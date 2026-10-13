import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  type AnyServerEvent,
  SSE_PATH,
  serverEventSchema,
  WS_CLOSE_CODES,
  WS_PATH,
} from '@picc/contracts';
import { WebSocket } from 'ws';
import { EventBus } from '../src/realtime/bus.js';
import { MemoryTicketStore } from '../src/realtime/tickets.js';
import { ADMIN, createTestContext, OWNER, type TestContext, VIEWER } from './helpers.js';

let ctx: TestContext;
let server: Server;
let port: number;
const tokens: Record<string, string> = {};

before(async () => {
  ctx = await createTestContext({}, { gateway: { heartbeatIntervalMs: 60_000 } });
  server = createServer(ctx.app);
  ctx.container.gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  for (const email of [ADMIN, OWNER, VIEWER]) tokens[email] = await ctx.login(email);
});
after(async () => {
  ctx.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const ticketFor = async (email: string): Promise<string> =>
  (await ctx.post('/realtime/ticket', tokens[email])).body.ticket as string;

/** A WebSocket client that records everything it receives and lets a test wait for an event. */
class Client {
  readonly events: AnyServerEvent[] = [];
  private waiters: {
    match: (e: AnyServerEvent) => boolean;
    resolve: (e: AnyServerEvent) => void;
  }[] = [];
  closed: Promise<{ code: number; reason: string }>;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as AnyServerEvent;
      this.events.push(event);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(event)) return true;
        w.resolve(event);
        return false;
      });
    });
    this.closed = new Promise((resolve) =>
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  waitFor<T extends AnyServerEvent['type']>(
    type: T,
    match: (e: Extract<AnyServerEvent, { type: T }>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<Extract<AnyServerEvent, { type: T }>> {
    const test = (e: AnyServerEvent) =>
      e.type === type && match(e as Extract<AnyServerEvent, { type: T }>);
    const seen = this.events.find(test);
    if (seen) return Promise.resolve(seen as Extract<AnyServerEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for ${type}; got ${this.events.map((e) => e.type).join(', ')}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        match: test,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e as Extract<AnyServerEvent, { type: T }>);
        },
      });
    });
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

async function connect(email: string, query = ''): Promise<Client> {
  const ticket = await ticketFor(email);
  const client = new Client(
    new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}?ticket=${ticket}${query}`),
  );
  await client.waitFor('connection.ready');
  return client;
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const spike = (reportId: string, loadTimeSec = 48) =>
  ctx.post('/admin/incidents', tokens[ADMIN], { reportId, kind: 'latency_spike', loadTimeSec });
const recover = (reportId: string) =>
  ctx.post('/admin/incidents', tokens[ADMIN], { reportId, kind: 'recovery' });
/** Clears open and recently resolved state so the next breach opens a brand-new alert. */
const reset = async (reportId: string) => {
  for (let i = 0; i < 3; i++) await recover(reportId);
};

describe('event bus', () => {
  it('numbers events monotonically and replays everything after a given id', () => {
    const bus = new EventBus(100);
    for (let i = 0; i < 5; i++) bus.publish('system.notice', 'system', { n: i });
    assert.equal(bus.latestId, 5);
    const replay = bus.replayAfter(2);
    assert.deepEqual(
      replay.records.map((r) => r.id),
      [3, 4, 5],
    );
    assert.equal(replay.gap, false);
  });

  it('reports a gap when the requested events have left the buffer', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 10; i++) bus.publish('system.notice', 'system', { n: i });
    const replay = bus.replayAfter(2);
    assert.equal(replay.gap, true);
    assert.equal(replay.oldestAvailable, 8);
    assert.deepEqual(
      replay.records.map((r) => r.id),
      [8, 9, 10],
    );
    assert.equal(
      bus.replayAfter(7).gap,
      false,
      'resuming from 7 needs 8 onwards, which is still there',
    );
  });

  it('keeps delivering when one listener throws', () => {
    const bus = new EventBus();
    const received: number[] = [];
    bus.subscribe(() => {
      throw new Error('broken transport');
    });
    bus.subscribe((r) => received.push(r.id));
    bus.publish('system.notice', 'system', {});
    assert.deepEqual(received, [1]);
  });
});

describe('tickets', () => {
  it('are single-use and expire after 30 seconds', async () => {
    let now = 0;
    const store = new MemoryTicketStore(() => now);
    const principal = ctx.container.personas.length
      ? (await import('../src/auth/principal.js')).SERVICE_PRINCIPAL
      : null;
    const first = await store.issue(principal!);
    assert.ok(await store.consume(first));
    assert.equal(await store.consume(first), null, 'second use fails');
    const second = await store.issue(principal!);
    now = 30_001;
    assert.equal(await store.consume(second), null, 'expired');
    assert.equal(await store.consume('made-up'), null);
  });

  it('cannot be minted without a session', async () => {
    assert.equal((await ctx.post('/realtime/ticket', undefined)).status, 401);
  });
});

describe('WebSocket stream', () => {
  it('greets with connection.ready describing the caller and the stream', async () => {
    const client = await connect(ADMIN);
    const ready = await client.waitFor('connection.ready');
    assert.equal(ready.id, 0);
    assert.equal(ready.data.user.email, ADMIN);
    assert.equal(ready.data.user.scope, 'all');
    assert.deepEqual(ready.data.topics.sort(), ['alerts', 'reports', 'system']);
    assert.equal(ready.data.protocolVersion, 1);
    assert.equal(ready.data.resumedFrom, null);
    assert.equal(ready.data.streamId, ctx.container.bus.streamId);
    serverEventSchema('connection.ready').parse(ready);
    client.close();
  });

  it('closes with 4401 for a missing, forged or reused ticket', async () => {
    const forged = new Client(new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}?ticket=forged`));
    assert.equal((await forged.closed).code, WS_CLOSE_CODES.UNAUTHORIZED.code);
    const none = new Client(new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`));
    assert.equal((await none.closed).code, WS_CLOSE_CODES.UNAUTHORIZED.code);

    const ticket = await ticketFor(ADMIN);
    const first = new Client(new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}?ticket=${ticket}`));
    await first.waitFor('connection.ready');
    const replayed = new Client(new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}?ticket=${ticket}`));
    assert.equal((await replayed.closed).code, WS_CLOSE_CODES.UNAUTHORIZED.code);
    first.close();
  });

  it('pushes alert.fired the moment latency exceeds the threshold, then alert.resolved', async () => {
    const report = 'RPT_250';
    await reset(report);
    const client = await connect(ADMIN);
    await spike(report, 48);
    const fired = await client.waitFor('alert.fired', (e) => e.data.alert.reportId === report);
    serverEventSchema('alert.fired').parse(fired);
    assert.equal(fired.data.alert.ruleId, 'latency');
    assert.equal(fired.data.alert.severity, 'critical');
    assert.equal(fired.data.alert.value, 48);
    assert.equal(fired.data.alert.source, 'injected');
    assert.ok(fired.id > 0);

    await recover(report);
    const resolved = await client.waitFor(
      'alert.resolved',
      (e) => e.data.alert.id === fired.data.alert.id,
    );
    assert.equal(resolved.data.alert.status, 'resolved');
    assert.ok(resolved.id > fired.id, 'ids increase');
    client.close();
  });

  it('pushes alert.fired when an automated refresh fails', async () => {
    const report = 'RPT_251';
    await ctx.post('/telemetry', tokens[ADMIN], {
      events: [
        { reportId: report, refreshStatus: 'SUCCESS' },
        { reportId: report, refreshStatus: 'SUCCESS' },
        { reportId: report, refreshStatus: 'SUCCESS' },
        { reportId: report, refreshStatus: 'SUCCESS' },
      ],
    });
    const client = await connect(ADMIN);
    await ctx.post('/admin/incidents', tokens[ADMIN], {
      reportId: report,
      kind: 'refresh_failure',
    });
    const fired = await client.waitFor(
      'alert.fired',
      (e) => e.data.alert.reportId === report && e.data.alert.ruleId === 'refresh_failure',
    );
    assert.equal(fired.data.alert.severity, 'high');
    assert.match(fired.data.alert.message, /refresh failed/i);
    client.close();
  });

  it('sends alert.updated, not a second alert.fired, for a repeat breach', async () => {
    const report = 'RPT_252';
    await reset(report);
    const client = await connect(ADMIN);
    await spike(report, 20);
    const fired = await client.waitFor('alert.fired', (e) => e.data.alert.reportId === report);
    await spike(report, 21);
    const updated = await client.waitFor(
      'alert.updated',
      (e) => e.data.alert.id === fired.data.alert.id,
    );
    assert.equal(updated.data.change, 'occurrence');
    assert.equal(updated.data.alert.occurrences, 2);
    await spike(report, 50);
    await client.waitFor(
      'alert.updated',
      (e) => e.data.alert.id === fired.data.alert.id && e.data.change === 'escalated',
    );
    assert.equal(
      client.events.filter((e) => e.type === 'alert.fired' && e.data.alert.reportId === report)
        .length,
      1,
    );
    client.close();
  });

  it('broadcasts an acknowledgement to other connected users', async () => {
    const report = 'RPT_253';
    await reset(report);
    const watcher = await connect(VIEWER);
    await spike(report);
    const fired = await watcher.waitFor('alert.fired', (e) => e.data.alert.reportId === report);
    await ctx.post(`/alerts/${fired.data.alert.id}/ack`, tokens[ADMIN], { note: 'on it' });
    const updated = await watcher.waitFor(
      'alert.updated',
      (e) => e.data.change === 'acknowledged' && e.data.alert.id === fired.data.alert.id,
    );
    assert.equal(updated.data.alert.status, 'acknowledged');
    watcher.close();
  });

  it('applies row-level security: an owner only receives events for reports they own', async () => {
    const owned = ctx.container.ownership.reportsOwnedBy(OWNER)[0]!;
    const foreign = ctx.container.snapshot.dim.find(
      (d) => d.owner_email !== null && d.owner_email !== OWNER,
    )!.report_id;
    await reset(owned);
    await reset(foreign);
    const owner = await connect(OWNER, '&topics=alerts,telemetry');
    const admin = await connect(ADMIN);
    assert.equal((await owner.waitFor('connection.ready')).data.user.scope, 'own');

    await spike(foreign);
    await admin.waitFor('alert.fired', (e) => e.data.alert.reportId === foreign);
    await spike(owned);
    await owner.waitFor('alert.fired', (e) => e.data.alert.reportId === owned);

    const leaked = owner.events.filter((e) => JSON.stringify(e).includes(foreign));
    assert.deepEqual(
      leaked,
      [],
      'nothing about the foreign report reached the owner, on any topic',
    );
    owner.close();
    admin.close();
  });

  it('applies field-level security: a viewer receives masked owner emails', async () => {
    const report = ctx.container.snapshot.dim.find(
      (d) => d.owner_email !== null && d.owner_email !== OWNER && d.report_id > 'RPT_260',
    )!;
    await reset(report.report_id);
    const viewer = await connect(VIEWER);
    const admin = await connect(ADMIN);
    await spike(report.report_id);
    const forViewer = await viewer.waitFor(
      'alert.fired',
      (e) => e.data.alert.reportId === report.report_id,
    );
    const forAdmin = await admin.waitFor(
      'alert.fired',
      (e) => e.data.alert.reportId === report.report_id,
    );
    assert.equal(forAdmin.data.alert.routing.ownerEmail, report.owner_email);
    assert.notEqual(forViewer.data.alert.routing.ownerEmail, report.owner_email);
    assert.equal(forViewer.data.alert.routing.ownerEmail, 'u***@company.com');
    viewer.close();
    admin.close();
  });

  it('routes an alert on an orphaned report to admins and re-routes it when an owner is assigned', async () => {
    const orphan = (await ctx.get('/orphans', tokens[ADMIN])).body.items.at(-1).reportId as string;
    await reset(orphan);
    const client = await connect(ADMIN);
    await spike(orphan);
    const fired = await client.waitFor('alert.fired', (e) => e.data.alert.reportId === orphan);
    assert.deepEqual(fired.data.alert.routing, {
      kind: 'admins',
      ownerEmail: null,
      escalated: true,
    });

    await ctx.post(`/reports/${orphan}/owner`, tokens[ADMIN], { ownerEmail: OWNER });
    const changed = await client.waitFor('report.owner_changed', (e) => e.data.reportId === orphan);
    assert.equal(changed.data.ownerEmail, OWNER);
    const rerouted = await client.waitFor(
      'alert.updated',
      (e) => e.data.change === 'rerouted' && e.data.alert.id === fired.data.alert.id,
    );
    assert.deepEqual(rerouted.data.alert.routing, {
      kind: 'owner',
      ownerEmail: OWNER,
      escalated: false,
    });
    client.close();
  });

  it('resumes after a disconnect: events missed while away are replayed in order', async () => {
    const report = 'RPT_255';
    await reset(report);
    const first = await connect(ADMIN);
    await spike(report, 20);
    const fired = await first.waitFor('alert.fired', (e) => e.data.alert.reportId === report);
    const lastSeen = fired.id;
    first.close();
    await first.closed;

    await spike(report, 35);
    await spike(report, 52);

    const second = await connect(ADMIN, `&lastEventId=${lastSeen}`);
    const ready = await second.waitFor('connection.ready');
    assert.equal(ready.data.resumedFrom, lastSeen);
    assert.ok(ready.data.replayed >= 2);
    await settle();
    const replayed = second.events.filter(
      (e) => e.type === 'alert.updated' && e.data.alert.reportId === report,
    );
    assert.deepEqual(
      replayed.map((e) => (e.type === 'alert.updated' ? e.data.alert.value : null)),
      [35, 52],
    );
    const ids = second.events.filter((e) => e.id > 0).map((e) => e.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
    assert.ok(
      ids.every((id) => id > lastSeen),
      'nothing already seen is sent again',
    );
    second.close();
  });

  it('answers ping with pong and honours subscribe / unsubscribe', async () => {
    const client = await connect(ADMIN);
    client.send({ type: 'ping', ts: 12345 });
    assert.equal((await client.waitFor('pong')).data.clientTs, 12345);

    client.send({ type: 'subscribe', topics: ['telemetry'] });
    const subscribed = await client.waitFor('subscribed');
    assert.ok(subscribed.data.topics.includes('telemetry'));
    await spike('RPT_256', 16);
    const observed = await client.waitFor(
      'telemetry.observed',
      (e) => e.data.reportId === 'RPT_256',
    );
    assert.equal(observed.data.breach, true);
    assert.equal(observed.data.loadTimeSec, 16);

    client.send({ type: 'unsubscribe', topics: ['telemetry'] });
    await client.waitFor('subscribed', (e) => !e.data.topics.includes('telemetry'));
    const before = client.events.filter((e) => e.type === 'telemetry.observed').length;
    await spike('RPT_256', 17);
    await settle();
    assert.equal(client.events.filter((e) => e.type === 'telemetry.observed').length, before);
    client.close();
  });

  it('reports malformed client messages without dropping the connection', async () => {
    const client = await connect(ADMIN);
    client.send('{not json');
    assert.equal((await client.waitFor('error')).data.code, 'bad_json');
    client.send({ type: 'launch_missiles' });
    await client.waitFor('error', (e) => e.data.code === 'bad_message');
    client.send({ type: 'ping' });
    await client.waitFor('pong');
    assert.equal(client.socket.readyState, WebSocket.OPEN);
    client.close();
  });

  it('counts live connections in system status', async () => {
    await settle();
    const before = (await ctx.get('/system/status', tokens[ADMIN])).body.realtime
      .webSocketClients as number;
    const client = await connect(ADMIN);
    assert.equal(
      (await ctx.get('/system/status', tokens[ADMIN])).body.realtime.webSocketClients,
      before + 1,
    );
    client.close();
  });
});

describe('Server-Sent Events stream', () => {
  /** Reads SSE frames from a fetch body until `count` events have arrived. */
  async function readSse(
    url: string,
    count: number,
    headers: Record<string, string> = {},
    onOpen?: () => Promise<unknown>,
  ) {
    const controller = new AbortController();
    const res = await fetch(url, { headers, signal: controller.signal });
    const frames: { id: string | null; event: string; data: AnyServerEvent }[] = [];
    if (res.status !== 200)
      return { status: res.status, contentType: res.headers.get('content-type'), frames };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let opened = false;
    const deadline = Date.now() + 4000;
    while (frames.length < count && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const field = (name: string) =>
          block
            .split('\n')
            .find((l) => l.startsWith(`${name}: `))
            ?.slice(name.length + 2) ?? null;
        const data = field('data');
        if (data)
          frames.push({
            id: field('id'),
            event: field('event')!,
            data: JSON.parse(data) as AnyServerEvent,
          });
        boundary = buffer.indexOf('\n\n');
      }
      if (!opened && frames.length > 0 && onOpen) {
        opened = true;
        await onOpen();
      }
    }
    controller.abort();
    return { status: res.status, contentType: res.headers.get('content-type'), frames };
  }

  it('delivers the same events in the same envelope as the WebSocket', async () => {
    const report = 'RPT_257';
    await reset(report);
    const ticket = await ticketFor(ADMIN);
    const result = await readSse(
      `http://127.0.0.1:${port}${SSE_PATH}?ticket=${ticket}&topics=alerts`,
      2,
      {},
      () => spike(report, 33),
    );
    assert.equal(result.status, 200);
    assert.match(result.contentType!, /text\/event-stream/);
    const [ready, fired] = result.frames;
    assert.equal(ready!.event, 'connection.ready');
    assert.equal(ready!.id, null, 'connection-scoped messages carry no SSE id');
    assert.equal(fired!.event, 'alert.fired');
    assert.equal(fired!.id, String(fired!.data.id));
    serverEventSchema('alert.fired').parse(fired!.data);
  });

  it('resumes from Last-Event-ID', async () => {
    const report = 'RPT_258';
    await reset(report);
    const mark = ctx.container.bus.latestId;
    await spike(report, 22);
    await spike(report, 23);
    const ticket = await ticketFor(ADMIN);
    const result = await readSse(
      `http://127.0.0.1:${port}${SSE_PATH}?ticket=${ticket}&topics=alerts`,
      3,
      { 'last-event-id': String(mark) },
    );
    const types = result.frames.map((f) => f.event);
    assert.deepEqual(types, ['connection.ready', 'alert.fired', 'alert.updated']);
    assert.ok(result.frames.slice(1).every((f) => Number(f.id) > mark));
  });

  it('refuses a missing or reused ticket with 401 problem details', async () => {
    const none = await readSse(`http://127.0.0.1:${port}${SSE_PATH}`, 1);
    assert.equal(none.status, 401);
    assert.match(none.contentType!, /application\/problem\+json/);
  });
});

describe('WebSocket origin check (production)', () => {
  let strict: TestContext;
  let strictServer: Server;
  let strictPort: number;
  let token: string;

  before(async () => {
    strict = await createTestContext(
      {},
      { gateway: { enforceOrigin: true, allowedOrigins: ['https://portal.example.com'] } },
    );
    strictServer = createServer(strict.app);
    strict.container.gateway.attach(strictServer);
    await new Promise<void>((resolve) => strictServer.listen(0, '127.0.0.1', resolve));
    strictPort = (strictServer.address() as AddressInfo).port;
    token = await strict.login(ADMIN);
  });
  after(async () => {
    strict.close();
    strictServer.closeAllConnections();
    await new Promise((resolve) => strictServer.close(resolve));
  });

  /** Resolves with 'open' once the handshake message arrives, or with the refusal. */
  const attempt = async (origin: string): Promise<string> => {
    const ticket = (await strict.post('/realtime/ticket', token)).body.ticket as string;
    const socket = new WebSocket(`ws://127.0.0.1:${strictPort}${WS_PATH}?ticket=${ticket}`, {
      origin,
    });
    return new Promise((resolve) => {
      socket.on('message', () => {
        resolve('open');
        socket.close();
      });
      socket.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
      socket.on('error', () => resolve('refused'));
    });
  };

  it('accepts the page the API itself serves (same origin), which is how the Docker image runs', async () => {
    assert.equal(await attempt(`http://127.0.0.1:${strictPort}`), 'open');
  });

  it('accepts an allow-listed origin and refuses any other', async () => {
    assert.equal(await attempt('https://portal.example.com'), 'open');
    assert.equal(await attempt('https://evil.example'), 'refused 403');
  });
});
