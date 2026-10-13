import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { WS_CLOSE_CODES, WS_PATH } from '@picc/contracts';
import request from 'supertest';
import { WebSocket } from 'ws';
import { OpsDb } from '../src/opsdb/db.js';
import { DEFAULT_GENERATED_DIR, DEFAULT_RAW_CSV, SQL_DIR } from '../src/paths.js';
import { DuckDbWarehouse } from '../src/warehouse/duckdb.js';
import { runSqlSuite } from '../src/warehouse/sql-runner.js';
import { ADMIN, API, createTestContext, FINOPS, type TestContext, VIEWER } from './helpers.js';

/**
 * Regression tests for defects found by deliberately trying to break the system: malformed
 * input, restarts, expiry, privacy leaks, hostile clients. Each test names the failure it
 * guards against.
 */
let ctx: TestContext;
let server: Server;
let port: number;
let admin: string;

before(async () => {
  ctx = await createTestContext({}, { gateway: { heartbeatIntervalMs: 60_000 } });
  server = createServer(ctx.app);
  ctx.container.gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  admin = await ctx.login(ADMIN);
});
after(async () => {
  ctx.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const openSocket = async (query = ''): Promise<WebSocket> => {
  const ticket = (await ctx.post('/realtime/ticket', admin)).body.ticket as string;
  return new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}?ticket=${ticket}${query}`);
};
const nextMessages = (
  socket: WebSocket,
  count: number,
): Promise<{ type: string; data: Record<string, unknown> }[]> =>
  new Promise((resolve, reject) => {
    const seen: { type: string; data: Record<string, unknown> }[] = [];
    const timer = setTimeout(
      () => reject(new Error(`only received ${seen.map((m) => m.type).join(', ')}`)),
      3000,
    );
    socket.on('message', (raw) => {
      seen.push(JSON.parse(raw.toString()));
      if (seen.length === count) {
        clearTimeout(timer);
        resolve(seen);
      }
    });
  });

describe('hostile and malformed network input', () => {
  it('survives upgrade requests whose target is not a parseable URL', async () => {
    const uncaught: unknown[] = [];
    const listener = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', listener);
    try {
      for (const target of ['//', '/ws?ticket=%', 'http://[::1', '/%00', '*']) {
        await new Promise<void>((resolve) => {
          const socket = net.connect(port, '127.0.0.1', () =>
            socket.write(
              `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
            ),
          );
          socket.on('data', () => undefined);
          socket.on('error', () => undefined);
          socket.on('close', () => resolve());
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 300);
        });
      }
    } finally {
      process.off('uncaughtException', listener);
    }
    assert.deepEqual(uncaught, [], 'a bad request line must not throw outside a handler');
    assert.equal((await request(ctx.app).get('/healthz')).status, 200);
  });

  it('disconnects a WebSocket client that floods the server with messages', async () => {
    const socket = await openSocket();
    await nextMessages(socket, 1);
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    for (let i = 0; i < 80; i++) socket.send(JSON.stringify({ type: 'ping' }));
    assert.equal(await closed, WS_CLOSE_CODES.RATE_LIMITED.code);
  });

  it('does not believe X-Forwarded-For unless told there is a proxy', async () => {
    assert.equal(
      ctx.app.get('trust proxy'),
      0,
      'otherwise a caller could reset their own rate limit',
    );
    const behindProxy = await createTestContext({ TRUST_PROXY: '1' });
    assert.equal(behindProxy.app.get('trust proxy'), 1);
    behindProxy.close();
  });

  it('serves no inline-script allowance in its content security policy', async () => {
    const csp = (await request(ctx.app).get('/healthz')).headers[
      'content-security-policy'
    ] as string;
    const scriptSrc =
      csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';
    assert.match(scriptSrc, /'self'/);
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
  });
});

describe('resuming an event stream across a server restart', () => {
  it('tells a client whose event id is from before the restart to start again', async () => {
    // The client remembers id 5000 from the previous process; this process is nowhere near it.
    const socket = await openSocket('&lastEventId=5000&streamId=previous-run');
    const [ready, gap] = await nextMessages(socket, 2);
    assert.equal(ready!.type, 'connection.ready');
    assert.equal(ready!.data.resumedFrom, null, 'nothing was resumed');
    assert.equal(ready!.data.replayed, 0);
    assert.equal(ready!.data.streamId, ctx.container.bus.streamId);
    assert.equal(gap!.type, 'replay.gap');
    assert.match(String(gap!.data.message), /restarted/);
    socket.close();
  });

  it('does not trust an old id just because it happens to be in range', async () => {
    for (let i = 0; i < 5; i++)
      ctx.container.bus.publish('system.notice', 'system', {
        level: 'info',
        code: 'test',
        message: `n${i}`,
      });
    const socket = await openSocket('&lastEventId=2&streamId=previous-run&topics=system');
    const [ready, gap] = await nextMessages(socket, 2);
    assert.equal(
      ready!.data.replayed,
      0,
      'events of this stream are not presented as a continuation of another',
    );
    assert.equal(gap!.type, 'replay.gap');
    socket.close();
  });

  it('still resumes normally within the same stream', async () => {
    const mark = ctx.container.bus.latestId;
    for (let i = 0; i < 3; i++)
      ctx.container.bus.publish('system.notice', 'system', {
        level: 'info',
        code: 'test',
        message: `m${i}`,
      });
    const socket = await openSocket(
      `&lastEventId=${mark}&streamId=${ctx.container.bus.streamId}&topics=system`,
    );
    const messages = await nextMessages(socket, 4);
    assert.equal(messages[0]!.data.resumedFrom, mark);
    assert.equal(messages[0]!.data.replayed, 3);
    assert.deepEqual(
      messages.slice(1).map((m) => m.type),
      ['system.notice', 'system.notice', 'system.notice'],
    );
    socket.close();
  });
});

describe('alert state that must not get stuck', () => {
  it('ends a snooze when its time is up', async () => {
    const alert = (await ctx.get('/alerts?pageSize=1', admin)).body.items[0];
    const snoozed = (await ctx.post(`/alerts/${alert.id}/snooze`, admin, { minutes: 1 })).body;
    assert.ok(snoozed.snoozedUntil);
    ctx.advance(61_000);
    assert.equal((await ctx.get(`/alerts/${alert.id}`, admin)).body.snoozedUntil, null);
  });

  it('closes the open alerts of a rule when the rule is disabled, and starts fresh when re-enabled', async () => {
    const before = (await ctx.get('/alerts/stats', admin)).body;
    assert.ok(before.byRule.latency > 50);
    const sample = (await ctx.get('/alerts?ruleId=latency&pageSize=1', admin)).body.items[0];

    assert.equal((await ctx.put('/alert-rules/latency', admin, { enabled: false })).status, 200);
    const after = (await ctx.get('/alerts/stats', admin)).body;
    assert.equal(
      after.byRule.latency,
      undefined,
      'nothing is left firing for a rule nobody evaluates',
    );
    const closed = (await ctx.get(`/alerts/${sample.id}`, admin)).body;
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.timeline.at(-1).detail, 'Rule disabled');
    assert.equal(closed.timeline.at(-1).actor, ADMIN);

    await ctx.put('/alert-rules/latency', admin, { enabled: true });
    await ctx.post('/telemetry', admin, {
      events: [{ reportId: sample.reportId, loadTimeSec: 40 }],
    });
    const reopened = (await ctx.get(`/alerts?ruleId=latency&reportId=${sample.reportId}`, admin))
      .body.items[0];
    assert.notEqual(reopened.id, sample.id, 'a new incident, not the old one reopened');
    assert.equal(reopened.occurrences, 1);
  });

  it('refuses a rule change that changes nothing', async () => {
    const res = await ctx.put('/alert-rules/latency', admin, {});
    assert.equal(res.status, 400);
    assert.match(res.body.errors[0].message, /at least one field/);
  });
});

describe('telemetry timestamps', () => {
  const REPORT = 'RPT_260';
  const send = (observedAt: string, loadTimeSec = 3) =>
    ctx
      .post('/telemetry', admin, { events: [{ reportId: REPORT, loadTimeSec, observedAt }] })
      .then((r) => r.body);

  it('rejects a timestamp that is not a timestamp', async () => {
    for (const bad of ['banana', '2026-13-45', '13/10/2026', '2026-10-13 09:00']) {
      const res = await send(bad);
      assert.equal(res.accepted, 0, bad);
      assert.match(res.rejected[0].reason, /observedAt/);
    }
  });

  it('rejects a timestamp in the future, allowing for clock skew', async () => {
    const now = ctx.container.now().getTime();
    assert.equal(
      (await send(new Date(now + 2 * 60_000).toISOString())).accepted,
      1,
      'two minutes ahead is skew',
    );
    const res = await send(new Date(now + 60 * 60_000).toISOString());
    assert.equal(res.accepted, 0);
    assert.match(res.rejected[0].reason, /future/);
  });

  it('rejects an event older than what is already held, so stale data cannot overwrite current state', async () => {
    const before = (await ctx.get(`/reports/${REPORT}`, admin)).body;
    const res = await send('2001-01-01T00:00:00Z', 55);
    assert.equal(res.accepted, 0);
    assert.match(res.rejected[0].reason, /Out of order/);
    const after = (await ctx.get(`/reports/${REPORT}`, admin)).body;
    assert.equal(after.loadTimeSec, before.loadTimeSec);
    assert.equal(after.lastObservedAt, before.lastObservedAt);
  });

  it('applies ordering within one batch as well', async () => {
    const base = ctx.container.now().getTime() + 3 * 60_000;
    const res = (
      await ctx.post('/telemetry', admin, {
        events: [
          { reportId: 'RPT_261', loadTimeSec: 3, observedAt: new Date(base).toISOString() },
          {
            reportId: 'RPT_261',
            loadTimeSec: 4,
            observedAt: new Date(base - 30_000).toISOString(),
          },
        ],
      })
    ).body;
    assert.equal(res.accepted, 1);
    assert.deepEqual(
      res.rejected.map((r: { index: number }) => r.index),
      [1],
    );
  });
});

describe('sign-in', () => {
  it('spends the same effort on an unknown account as on a wrong password', async () => {
    const median = async (email: string): Promise<number> => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await request(ctx.app)
          .post(`${API}/auth/login`)
          .send({ email, password: 'wrong-password-123' });
        times.push(performance.now() - started);
      }
      return times.sort((a, b) => a - b)[2]!;
    };
    const known = await median(ADMIN);
    const unknown = await median('nobody-here@company.com');
    // Before the fix these were about 60 ms and 3 ms: response time revealed which emails exist.
    assert.ok(
      unknown > known * 0.5,
      `unknown account answered in ${unknown.toFixed(0)} ms against ${known.toFixed(0)} ms`,
    );
  });

  it('records failed sign-ins in the audit log', async () => {
    await request(ctx.app)
      .post(`${API}/auth/login`)
      .send({ email: FINOPS, password: 'definitely-wrong' });
    const entry = (await ctx.get('/audit-log?action=auth.login_failed&pageSize=1', admin)).body
      .items[0];
    assert.equal(entry.actor, 'anonymous');
    assert.equal(entry.targetId, FINOPS);
    assert.doesNotMatch(
      JSON.stringify(entry),
      /definitely-wrong/,
      'the attempted password is never stored',
    );
  });

  it('sets a script-readable hint cookie that carries no secret, and clears it on sign-out', async () => {
    const login = await request(ctx.app).post(`${API}/auth/demo-login`).send({ email: VIEWER });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const hint = cookies.find((c) => c.startsWith('picc_signed_in='))!;
    const refresh = cookies.find((c) => c.startsWith('picc_refresh='))!;
    assert.match(hint, /^picc_signed_in=1;/);
    assert.doesNotMatch(hint, /HttpOnly/i);
    assert.match(refresh, /HttpOnly/i);
    const logout = await request(ctx.app)
      .post(`${API}/auth/logout`)
      .set('cookie', refresh.split(';')[0]!);
    const cleared = (logout.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('picc_signed_in='),
    )!;
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  });
});

describe('restarts and upgrades of the operational database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picc-ops-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps alerts, acknowledgements and the audit trail across a restart, and does not replay history twice', async () => {
    const file = join(dir, 'ops.sqlite');
    const first = await createTestContext({ OPS_DB: file });
    const token = await first.login(ADMIN);
    const statsBefore = (await first.get('/alerts/stats', token)).body;
    const alert = (await first.get('/alerts?pageSize=1', token)).body.items[0];
    await first.post(`/alerts/${alert.id}/ack`, token, { note: 'before restart' });
    first.close();

    const second = await createTestContext({ OPS_DB: file });
    try {
      const again = await second.login(ADMIN);
      const statsAfter = (await second.get('/alerts/stats', again)).body;
      assert.equal(
        statsAfter.firing + statsAfter.acknowledged,
        statsBefore.firing + statsBefore.acknowledged,
      );
      assert.equal(
        statsAfter.resolved,
        statsBefore.resolved,
        'the 20 periods were not ingested a second time',
      );
      assert.equal(statsAfter.acknowledged, 1);
      const restored = (await second.get(`/alerts/${alert.id}`, again)).body;
      assert.equal(restored.status, 'acknowledged');
      assert.equal(restored.ackNote, 'before restart');
      const audit = (await second.get('/audit-log?action=alert.acknowledge', again)).body;
      assert.equal(audit.items[0].targetId, alert.id);
    } finally {
      second.close();
    }
  });

  it('upgrades a database written by an earlier build instead of failing on a missing column', () => {
    const file = join(dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(file);
    // The alerts table as it was before flap tracking was added; schema version never set.
    legacy.exec(`
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, rule_id TEXT NOT NULL, report_id TEXT NOT NULL,
        severity TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, value REAL, threshold REAL, unit TEXT,
        occurrences INTEGER NOT NULL, reopen_count INTEGER NOT NULL DEFAULT 0, ok_streak INTEGER NOT NULL DEFAULT 0,
        obs_since_resolved INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        resolved_at TEXT, acknowledged_by TEXT, acknowledged_at TEXT, ack_note TEXT, snoozed_until TEXT,
        source TEXT NOT NULL, seq INTEGER NOT NULL);
      INSERT INTO alerts (id, fingerprint, rule_id, report_id, severity, status, message, occurrences, reopen_count,
        first_seen_at, last_seen_at, source, seq)
      VALUES ('old-1', 'latency:RPT_200', 'latency', 'RPT_200', 'high', 'firing', 'm', 9, 3,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'live', 1);`);
    legacy.close();

    const upgraded = new OpsDb(file);
    try {
      assert.equal(upgraded.schemaVersion, 2);
      const row = upgraded.get<{ flap_count: number; breach_streak: number; occurrences: number }>(
        "SELECT flap_count, breach_streak, occurrences FROM alerts WHERE id = 'old-1'",
      )!;
      assert.deepEqual(
        { ...row },
        { flap_count: 3, breach_streak: 0, occurrences: 9 },
        'existing rows keep their data',
      );
    } finally {
      upgraded.close();
    }
    // Opening it again is a no-op, not a second attempt to add the same columns.
    const reopened = new OpsDb(file);
    assert.equal(reopened.schemaVersion, 2);
    reopened.close();
  });
});

describe('SQL suite', () => {
  it('is idempotent: running it twice on the same database gives the same answer', async () => {
    const warehouse = await DuckDbWarehouse.open();
    try {
      const options = { sqlDir: SQL_DIR, rawCsv: DEFAULT_RAW_CSV, dataDir: DEFAULT_GENERATED_DIR };
      const totals = () =>
        warehouse.query(
          'SELECT COUNT(*) AS n, SUM(total_cost_usd) AS cost, SUM(credits_attributed) AS credits FROM MART.FCT_REPORT_PERIOD',
        );
      await runSqlSuite(warehouse, options);
      const [first] = (await totals()) as { n: number; cost: number; credits: number }[];
      await runSqlSuite(warehouse, options);
      const [second] = (await totals()) as { n: number; cost: number; credits: number }[];
      assert.equal(second!.n, first!.n, 'no rows doubled');
      // Parallel aggregation adds doubles in a different order each run; compare to 1 part in 10^9.
      assert.ok(
        Math.abs(second!.cost - first!.cost) / first!.cost < 1e-9,
        'cost total did not drift',
      );
      assert.ok(
        Math.abs(second!.credits - first!.credits) / first!.credits < 1e-9,
        'credit total did not drift',
      );
      const [raw] = await warehouse.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM RAW.REPORT_TELEMETRY',
      );
      assert.equal(raw!.n, 2000);
    } finally {
      await warehouse.close();
    }
  });
});
