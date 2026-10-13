import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { type AnyServerEvent, WS_CLOSE_CODES, WS_PATH } from '@picc/contracts';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { WebSocket } from 'ws';
import { SERVICE_PRINCIPAL } from '../src/auth/principal.js';
import { createLogger } from '../src/logger.js';
import { EventBus } from '../src/realtime/bus.js';
import { DEFAULT_GATEWAY_OPTIONS, RealtimeGateway } from '../src/realtime/gateway.js';
import { connectRedis, RedisEventLog, RedisTicketStore, whenReady } from '../src/realtime/redis.js';
import { ADMIN, API, createTestContext, OWNER, type TestContext, VIEWER } from './helpers.js';

/**
 * Redis as the event backbone. These need a Redis server, so they run only when REDIS_URL is
 * set (CI provides one; locally: `docker run -p 6379:6379 redis:7-alpine`). Every test uses
 * its own key prefix and removes its keys afterwards.
 */
const REDIS_URL = process.env.REDIS_URL;
const logger = createLogger({ env: 'test', logLevel: 'silent' } as never);
const INGEST_KEY = 'test-ingest-key-0123456789';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  // Every cleanup runs even if one fails: a leaked connection would keep the process alive.
  for (const cleanup of cleanups.splice(0).reverse())
    await Promise.resolve()
      .then(cleanup)
      .catch(() => undefined);
});

async function redisClient(): Promise<Redis> {
  const redis = connectRedis(REDIS_URL!);
  redis.on('error', () => undefined);
  await whenReady(redis);
  cleanups.push(() => redis.disconnect());
  return redis;
}

const newPrefix = async (): Promise<string> => {
  const prefix = `picc-test-${randomBytes(5).toString('hex')}`;
  const admin = await redisClient();
  cleanups.push(async () => {
    const keys = await admin.keys(`${prefix}:*`);
    if (keys.length) await admin.del(...keys);
  });
  return prefix;
};

/** A core node: the whole application, with its bus mirrored to Redis and tickets held there. */
async function startCore(
  prefix: string,
): Promise<{ ctx: TestContext; log: RedisEventLog; port: number }> {
  const redis = await redisClient();
  const log = new RedisEventLog(redis, undefined, prefix, 100);
  const bus = new EventBus(2000, undefined, await log.load(2000));
  log.mirror(bus);
  const ctx = await createTestContext(
    {},
    {
      bus,
      tickets: new RedisTicketStore(redis, prefix),
      gateway: { heartbeatIntervalMs: 60_000 },
    },
  );
  const server = createServer(ctx.app);
  ctx.container.gateway.attach(server);
  const port = await listen(server);
  cleanups.push(() => ctx.close());
  return { ctx, log, port };
}

/** An edge node: connections only. No database, no warehouse, no application container. */
async function startEdge(
  prefix: string,
  onReset: () => void = () => undefined,
): Promise<{ bus: EventBus; port: number; gateway: RealtimeGateway }> {
  const redis = await redisClient();
  const log = new RedisEventLog(redis, undefined, prefix, 100);
  const bus = new EventBus(2000, undefined, await log.load(2000));
  const gateway = new RealtimeGateway(bus, new RedisTicketStore(redis, prefix), logger, {
    ...DEFAULT_GATEWAY_OPTIONS,
    heartbeatIntervalMs: 60_000,
  });
  const server = createServer();
  gateway.attach(server);
  const port = await listen(server);
  log.follow(bus, onReset);
  cleanups.push(() => {
    log.stop();
    gateway.close();
  });
  return { bus, port, gateway };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as AddressInfo).port;
}

class Client {
  readonly events: AnyServerEvent[] = [];
  private waiters: {
    match: (e: AnyServerEvent) => boolean;
    resolve: (e: AnyServerEvent) => void;
  }[] = [];
  readonly closed: Promise<number>;

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
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
    cleanups.push(() => socket.terminate());
  }

  waitFor<T extends AnyServerEvent['type']>(
    type: T,
    match: (e: Extract<AnyServerEvent, { type: T }>) => boolean = () => true,
  ): Promise<Extract<AnyServerEvent, { type: T }>> {
    const test = (e: AnyServerEvent) =>
      e.type === type && match(e as Extract<AnyServerEvent, { type: T }>);
    const seen = this.events.find(test);
    if (seen) return Promise.resolve(seen as Extract<AnyServerEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${type}; got ${this.events.map((e) => e.type).join(', ')}`)),
        4000,
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
}

/** Mints a ticket on the core over REST, then opens the stream on whichever node `port` is. */
async function connect(ctx: TestContext, email: string, port: number, query = ''): Promise<Client> {
  const ticket = (await ctx.post('/realtime/ticket', await ctx.login(email))).body.ticket as string;
  const client = new Client(
    new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}?ticket=${ticket}${query}`),
  );
  await client.waitFor('connection.ready');
  return client;
}

const ingest = (ctx: TestContext, events: unknown[]) =>
  request(ctx.app).post(`${API}/telemetry`).set('x-api-key', INGEST_KEY).send({ events });
const settle = async (ctx: TestContext, reportId: string): Promise<void> => {
  for (let i = 0; i < 6; i++)
    await ingest(ctx, [{ reportId, loadTimeSec: 2, refreshStatus: 'SUCCESS' }]);
};
const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('Redis: tickets shared between nodes', { skip: !REDIS_URL }, () => {
  it('lets one node mint a ticket and another redeem it, exactly once', async () => {
    const prefix = await newPrefix();
    const minting = new RedisTicketStore(await redisClient(), prefix);
    const first = new RedisTicketStore(await redisClient(), prefix);
    const second = new RedisTicketStore(await redisClient(), prefix);

    const ticket = await minting.issue(SERVICE_PRINCIPAL);
    // Two nodes are handed the same ticket at the same instant: one wins.
    const results = await Promise.all([first.consume(ticket), second.consume(ticket)]);
    const winners = results.filter((principal) => principal !== null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]!.email, SERVICE_PRINCIPAL.email);
    assert.ok(winners[0]!.permissions.has('telemetry:ingest'), 'permissions survive the trip');
    assert.equal(await first.consume(ticket), null);
  });

  it('expires a ticket and refuses anything that is not shaped like one', async () => {
    const prefix = await newPrefix();
    const redis = await redisClient();
    const store = new RedisTicketStore(redis, prefix);
    const ticket = await store.issue(SERVICE_PRINCIPAL);
    const ttl = await redis.pttl(`${prefix}:ticket:${ticket}`);
    assert.ok(ttl > 25_000 && ttl <= 30_000, `expires in 30 s, got ${ttl} ms`);

    // A key the attacker would like to read or delete through the ticket parameter.
    await redis.set(`${prefix}:ticket:../secret`, 'x');
    for (const bad of ['', '../secret', '*', 'a'.repeat(200), `${ticket}\n`, null, undefined]) {
      assert.equal(await store.consume(bad), null);
    }
    assert.equal(await redis.get(`${prefix}:ticket:../secret`), 'x', 'left untouched');
  });
});

describe('Redis: an edge node that holds connections and nothing else', {
  skip: !REDIS_URL,
}, () => {
  it('delivers what the core publishes, under the same access rules, with no database', async () => {
    const prefix = await newPrefix();
    const { ctx } = await startCore(prefix);
    const edge = await startEdge(prefix);
    const mine = ctx.container.ownership.reportsOwnedBy(OWNER)[0]!;
    const theirs = ctx.container.ownership
      .reportIds()
      .find((id) => ![OWNER, null].includes(ctx.container.ownership.ownerOf(id).email))!;
    await settle(ctx, mine);
    await settle(ctx, theirs);

    const admin = await connect(ctx, ADMIN, edge.port);
    const viewer = await connect(ctx, VIEWER, edge.port);
    const owner = await connect(ctx, OWNER, edge.port);
    assert.equal(admin.events[0]!.type, 'connection.ready');
    assert.equal(
      (admin.events[0] as Extract<AnyServerEvent, { type: 'connection.ready' }>).data.streamId,
      ctx.container.bus.streamId,
      'the edge speaks for the same stream as the core',
    );
    assert.deepEqual(edge.gateway.stats(), { webSocketClients: 3, sseClients: 0 });
    assert.deepEqual(ctx.container.gateway.stats(), { webSocketClients: 0, sseClients: 0 });

    await ingest(ctx, [{ reportId: theirs, refreshStatus: 'FAILED' }]);
    await ingest(ctx, [{ reportId: mine, refreshStatus: 'FAILED' }]);

    const seenByAdmin = await admin.waitFor('alert.fired', (e) => e.data.alert.reportId === theirs);
    const onCore = ctx.container.bus
      .replayAfter(0)
      .records.find((r) => r.type === 'alert.fired' && r.reportId === theirs)!;
    assert.equal(seenByAdmin.id, onCore.id, 'same event id as on the core');
    const realOwner = ctx.container.ownership.ownerOf(theirs).email;
    assert.equal(seenByAdmin.data.alert.routing.ownerEmail, realOwner);

    // Field-level security, applied on a node that has never seen the user table.
    const seenByViewer = await viewer.waitFor(
      'alert.fired',
      (e) => e.data.alert.reportId === theirs,
    );
    assert.equal(seenByViewer.data.alert.routing.ownerEmail, 'u***@company.com');

    // Row-level security, applied on a node that has never seen the ownership table.
    await owner.waitFor('alert.fired', (e) => e.data.alert.reportId === mine);
    assert.deepEqual(
      owner.events.filter((e) => e.type === 'alert.fired').map((e) => e.data.alert.reportId),
      [mine],
    );
  });

  it('refuses a ticket that was already used on another node', async () => {
    const prefix = await newPrefix();
    const { ctx, port: corePort } = await startCore(prefix);
    const edge = await startEdge(prefix);
    const ticket = (await ctx.post('/realtime/ticket', await ctx.login(ADMIN))).body
      .ticket as string;
    const first = new Client(
      new WebSocket(`ws://127.0.0.1:${edge.port}${WS_PATH}?ticket=${ticket}`),
    );
    await first.waitFor('connection.ready');
    const replay = new Client(
      new WebSocket(`ws://127.0.0.1:${corePort}${WS_PATH}?ticket=${ticket}`),
    );
    assert.equal(await replay.closed, WS_CLOSE_CODES.UNAUTHORIZED.code);
  });

  it('catches up on what it missed when it starts late', async () => {
    const prefix = await newPrefix();
    const { ctx } = await startCore(prefix);
    ctx.container.bus.publish('system.notice', 'system', {
      level: 'info',
      code: 'a',
      message: '1',
    });
    ctx.container.bus.publish('system.notice', 'system', {
      level: 'info',
      code: 'b',
      message: '2',
    });
    const edge = await startEdge(prefix);
    assert.equal(edge.bus.latestId, 2);
    ctx.container.bus.publish('system.notice', 'system', {
      level: 'info',
      code: 'c',
      message: '3',
    });
    await until(() => edge.bus.latestId === 3, 'the edge to receive event 3');
    assert.deepEqual(
      edge.bus.replayAfter(0).records.map((r) => [r.id, (r.payload as { code: string }).code]),
      [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ],
    );
  });

  it('reports that the stream was reset under it, so the node can restart clean', async () => {
    const prefix = await newPrefix();
    const redis = await redisClient();
    let reset = false;
    await startEdge(prefix, () => {
      reset = true;
    });
    // Redis lost its data and the core began a new stream.
    await redis.del(`${prefix}:events`);
    await redis.set(`${prefix}:events:stream-id`, 'a-new-stream');
    await until(() => reset, 'the edge to notice the reset');
  });
});

describe('Redis: the event stream outlives the process', { skip: !REDIS_URL }, () => {
  it('carries on numbering after a restart, so a client resumes with no gap', async () => {
    const prefix = await newPrefix();
    const before = await startCore(prefix);
    const reportId = before.ctx.container.ownership.reportIds()[0]!;
    await settle(before.ctx, reportId);

    const client = await connect(before.ctx, ADMIN, before.port);
    const ready = client.events[0] as Extract<AnyServerEvent, { type: 'connection.ready' }>;
    await ingest(before.ctx, [{ reportId, refreshStatus: 'FAILED' }]);
    const fired = await client.waitFor('alert.fired');
    // The connection drops; two more things happen that the client does not see.
    client.socket.terminate();
    await ingest(before.ctx, [{ reportId, refreshStatus: 'FAILED' }]);
    await ingest(before.ctx, [{ reportId, refreshStatus: 'SUCCESS' }]);
    const lastBeforeRestart = before.ctx.container.bus.latestId;
    assert.ok(lastBeforeRestart > fired.id);
    await until(() => before.log.mirrorFailures === 0, 'writes to settle');

    // The process is replaced. In memory, everything it knew about the stream is gone.
    before.ctx.close();
    const after = await startCore(prefix);
    assert.equal(after.ctx.container.bus.streamId, ready.data.streamId, 'same stream');
    assert.equal(after.ctx.container.bus.latestId, lastBeforeRestart, 'numbering carries on');

    const resumed = await connect(
      after.ctx,
      ADMIN,
      after.port,
      `&lastEventId=${fired.id}&streamId=${ready.data.streamId}`,
    );
    const hello = resumed.events[0] as Extract<AnyServerEvent, { type: 'connection.ready' }>;
    assert.equal(hello.data.resumedFrom, fired.id);
    assert.equal(hello.data.replayed, 2);
    await resumed.waitFor('alert.resolved');
    assert.deepEqual(
      resumed.events.slice(1).map((e) => e.type),
      ['alert.updated', 'alert.resolved'],
      'exactly what was missed, in order, and no replay.gap',
    );

    after.ctx.container.bus.publish('system.notice', 'system', {
      level: 'info',
      code: 'after-restart',
      message: 'x',
    });
    assert.equal((await resumed.waitFor('system.notice')).id, lastBeforeRestart + 1);
  });

  it('keeps serving its own connections when Redis is unreachable, and counts what it could not mirror', async () => {
    const prefix = await newPrefix();
    const redis = connectRedis(REDIS_URL!);
    redis.on('error', () => undefined);
    await whenReady(redis);
    const log = new RedisEventLog(redis, undefined, prefix, 100);
    const bus = new EventBus(2000, undefined, await log.load(2000));
    log.mirror(bus);
    const received: number[] = [];
    bus.subscribe((record) => received.push(record.id));

    redis.disconnect();
    bus.publish('system.notice', 'system', { level: 'info', code: 'offline', message: 'x' });
    assert.deepEqual(received, [1], 'local delivery does not depend on Redis');
    await until(() => log.mirrorFailures === 1, 'the failed write to be counted');
  });
});
