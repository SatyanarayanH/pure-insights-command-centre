import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, describe, it } from 'node:test';
import type { Notification, TelemetrySeries } from '@picc/contracts';
import request from 'supertest';
import type { WarehouseSnapshot } from '../src/warehouse/snapshot.js';
import {
  ADMIN,
  API,
  createTestContext,
  FINOPS,
  getSnapshot,
  OWNER,
  type TestContext,
  VIEWER,
} from './helpers.js';

/**
 * What the system needs beyond the case-study file to be run for real: safe resends, a history
 * of readings, noticing when data stops, telling people, being observable, and picking up new
 * warehouse data without a restart.
 */
const open: TestContext[] = [];
const context = async (...args: Parameters<typeof createTestContext>): Promise<TestContext> => {
  const ctx = await createTestContext(...args);
  open.push(ctx);
  return ctx;
};
afterEach(() => {
  for (const ctx of open.splice(0)) ctx.close();
});

const MINUTE = 60_000;
const INGEST_KEY = 'test-ingest-key-0123456789';
/** Pushes telemetry the way the portal does: with the service key, which does not expire, so
 *  a test can move the clock by hours and keep sending. */
const ingest = (ctx: TestContext, events: unknown[]) =>
  request(ctx.app)
    .post(`${API}/telemetry`)
    .set('x-api-key', INGEST_KEY)
    .send({ events })
    .then((r) => r.body);
const reportIds = (ctx: TestContext): string[] => ctx.container.ownership.reportIds();
/** A report with an owner, and one without. */
const owned = (ctx: TestContext): string =>
  reportIds(ctx).find((id) => ctx.container.ownership.ownerOf(id).email !== null)!;
const orphaned = (ctx: TestContext): string =>
  reportIds(ctx).find((id) => ctx.container.ownership.ownerOf(id).email === null)!;
/** Brings every rule on a report back to healthy, so a test starts from a known state. */
const settle = async (ctx: TestContext, reportId: string): Promise<void> => {
  // Enough healthy readings to resolve whatever the history left open and to move past the
  // window in which a new breach would reopen it, so the next alert is a new one.
  for (let i = 0; i < 6; i++) {
    await ingest(ctx, [{ reportId, loadTimeSec: 2, refreshStatus: 'SUCCESS', creditsConsumed: 1 }]);
  }
};

describe('safe resends (idempotent ingest)', () => {
  it('applies an event once however many times it is sent', async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    const reportId = owned(ctx);
    await settle(ctx, reportId);
    const event = { reportId, eventId: 'portal-7f3a91c2', refreshStatus: 'FAILED' };

    const first = await ingest(ctx, [event]);
    assert.deepEqual([first.accepted, first.duplicates, first.alertsFired], [1, 0, 1]);

    // The emitter timed out and sends the same batch again.
    const second = await ingest(ctx, [event]);
    assert.deepEqual([second.accepted, second.duplicates, second.rejected.length], [0, 1, 0]);
    assert.equal(second.alertsFired, 0);

    const [alert] = (await ctx.get(`/alerts?reportId=${reportId}&ruleId=refresh_failure`, admin))
      .body.items;
    assert.equal(alert.occurrences, 1, 'the resend did not count as a second failure');
    assert.equal(alert.value, 1, 'nor extend the failure streak');
  });

  it('recognises a repeat inside one batch', async () => {
    const ctx = await context();
    const reportId = owned(ctx);
    const res = await ingest(ctx, [
      { reportId, eventId: 'batch-0000001', loadTimeSec: 3 },
      { reportId, eventId: 'batch-0000001', loadTimeSec: 3 },
      { reportId, eventId: 'batch-0000002', loadTimeSec: 3 },
    ]);
    assert.deepEqual([res.accepted, res.duplicates], [2, 1]);
  });

  it('acknowledges a late resend as a duplicate, not as out of order', async () => {
    const ctx = await context();
    const reportId = owned(ctx);
    const t0 = ctx.container.now().toISOString();
    await ingest(ctx, [{ reportId, eventId: 'late-00000001', loadTimeSec: 3, observedAt: t0 }]);
    ctx.advance(MINUTE);
    await ingest(ctx, [{ reportId, loadTimeSec: 4 }]);
    const resend = await ingest(ctx, [
      { reportId, eventId: 'late-00000001', loadTimeSec: 3, observedAt: t0 },
    ]);
    assert.deepEqual([resend.duplicates, resend.rejected.length], [1, 0]);
  });

  it('still processes events that carry no id, and refuses a malformed one', async () => {
    const ctx = await context();
    const reportId = owned(ctx);
    const res = await ingest(ctx, [
      { reportId, loadTimeSec: 3 },
      { reportId, loadTimeSec: 3 },
      { reportId, eventId: 'short', loadTimeSec: 3 },
      { reportId, eventId: 'has spaces and; punctuation', loadTimeSec: 3 },
    ]);
    assert.equal(res.accepted, 2);
    assert.equal(res.rejected.length, 2);
    assert.match(res.rejected[0].reason, /eventId/);
  });
});

describe('stored readings and the live trend', () => {
  it('keeps live readings but not the history replayed at start-up', async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    const status = () => ctx.get('/system/status', admin).then((r) => r.body.telemetry);
    assert.equal((await status()).observationsStored, 0, 'the backfill is not a live reading');
    assert.equal((await status()).lastReceivedAt, null);
    await ingest(ctx, [{ reportId: owned(ctx), loadTimeSec: 3 }]);
    assert.equal((await status()).observationsStored, 1);
    assert.equal((await status()).lastReceivedAt, ctx.container.now().toISOString());
  });

  it('summarises load time into clock-aligned buckets, leaving empty ones empty', async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    const [a, b] = reportIds(ctx);
    // Twenty readings now: 1..20 seconds. Median 10.5, five above the 15 s threshold.
    await ingest(
      ctx,
      Array.from({ length: 20 }, (_, i) => ({
        reportId: i % 2 ? a : b,
        loadTimeSec: i + 1,
        refreshStatus: i < 3 ? 'FAILED' : 'SUCCESS',
      })),
    );
    const series = (await ctx.get('/telemetry/series?window=1h', admin)).body as TelemetrySeries;
    assert.equal(series.bucketMinutes, 2);
    assert.equal(series.buckets.length, 30);
    assert.deepEqual(series.totals, {
      observations: 20,
      latencyBreaches: 5,
      refreshFailures: 3,
      reports: 2,
    });
    const last = series.buckets.at(-1)!;
    assert.deepEqual(
      [last.observations, last.p50LoadSec, last.p95LoadSec, last.maxLoadSec],
      [20, 10.5, 19.05, 20],
    );
    assert.equal(Date.parse(last.start) % (2 * MINUTE), 0, 'buckets start on the clock');
    assert.ok(Date.parse(last.start) <= ctx.container.now().getTime());
    const empty = series.buckets[0]!;
    assert.deepEqual([empty.observations, empty.p50LoadSec], [0, null]);
    assert.deepEqual(series.points, [], 'individual readings only for a single report');
  });

  it('moves readings into older buckets as time passes and drops them out of the window', async () => {
    const ctx = await context();
    await ingest(ctx, [{ reportId: owned(ctx), loadTimeSec: 7 }]);
    ctx.advance(30 * MINUTE);
    let admin = await ctx.login(ADMIN);
    const hour = (await ctx.get('/telemetry/series?window=1h', admin)).body as TelemetrySeries;
    const at = hour.buckets.findIndex((bucket) => bucket.observations === 1);
    assert.ok(at >= 13 && at <= 15, `about half-way back, got bucket ${at}`);
    ctx.advance(45 * MINUTE);
    admin = await ctx.login(ADMIN);
    const later = (await ctx.get('/telemetry/series?window=1h', admin)).body as TelemetrySeries;
    assert.equal(later.totals.observations, 0);
    const six = (await ctx.get('/telemetry/series?window=6h', admin)).body as TelemetrySeries;
    assert.deepEqual([six.bucketMinutes, six.buckets.length, six.totals.observations], [10, 36, 1]);
  });

  it('returns the individual readings for one report', async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    const reportId = owned(ctx);
    for (const loadTimeSec of [4, 18, 6]) {
      await ingest(ctx, [{ reportId, loadTimeSec }]);
      ctx.advance(MINUTE);
    }
    const series = (await ctx.get(`/telemetry/series?reportId=${reportId}`, admin))
      .body as TelemetrySeries;
    assert.deepEqual(
      series.points.map((p) => p.loadTimeSec),
      [4, 18, 6],
    );
    assert.equal(series.reportId, reportId);
  });

  it("limits a report owner to their own reports' readings", async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    const owner = await ctx.login(OWNER);
    const mine = ctx.container.ownership.reportsOwnedBy(OWNER)[0]!;
    const theirs = reportIds(ctx).find(
      (id) => ctx.container.ownership.ownerOf(id).email !== OWNER,
    )!;
    await ingest(ctx, [
      { reportId: mine, loadTimeSec: 5 },
      { reportId: theirs, loadTimeSec: 50 },
    ]);
    const series = (await ctx.get('/telemetry/series', owner)).body as TelemetrySeries;
    assert.deepEqual([series.totals.observations, series.totals.reports], [1, 1]);
    assert.equal(series.buckets.at(-1)!.maxLoadSec, 5);
    assert.equal((await ctx.get(`/telemetry/series?reportId=${theirs}`, owner)).status, 404);
    assert.equal((await ctx.get(`/telemetry/series?reportId=${mine}`, owner)).status, 200);
    assert.equal((await ctx.get('/telemetry/series?window=1y', admin)).status, 400);
  });

  it('deletes readings older than the retention window', async () => {
    const ctx = await context({ TELEMETRY_RETENTION_DAYS: '1' });
    await ingest(ctx, [{ reportId: owned(ctx), loadTimeSec: 5, eventId: 'retained-0001' }]);
    ctx.advance(25 * 60 * MINUTE);
    await ingest(ctx, [{ reportId: owned(ctx), loadTimeSec: 5 }]);
    ctx.container.staleness.sweep();
    assert.equal(ctx.container.observations.count(), 1);
  });
});

describe('noticing when data stops arriving', () => {
  /** A healthy reading for every report except the ones named. */
  const feedAllExcept = (ctx: TestContext, ...quiet: string[]) =>
    ingest(
      ctx,
      reportIds(ctx)
        .filter((id) => !quiet.includes(id))
        .map((reportId) => ({ reportId, loadTimeSec: 2, refreshStatus: 'SUCCESS' })),
    );
  const staleAlerts = async (ctx: TestContext) =>
    ctx.get('/alerts?ruleId=telemetry_stale&status=all&pageSize=500', await ctx.login(ADMIN)).then(
      (r) =>
        r.body.items as {
          reportId: string;
          status: string;
          severity: string;
          occurrences: number;
          value: number;
        }[],
    );

  it('raises one alert for a report that has gone quiet while the rest of the feed arrives', async () => {
    const ctx = await context();
    const quiet = owned(ctx);
    await feedAllExcept(ctx);

    // Half an hour of readings from everything else.
    for (let minute = 0; minute < 32; minute += 4) {
      ctx.advance(4 * MINUTE);
      await feedAllExcept(ctx, quiet);
    }
    assert.deepEqual(ctx.container.staleness.sweep(), { feedSilent: false, markedStale: 1 });
    let [alert] = await staleAlerts(ctx);
    assert.deepEqual(
      [alert!.reportId, alert!.status, alert!.severity, alert!.value],
      [quiet, 'firing', 'warning', 32],
    );

    // Later sweeps say nothing new until something changes.
    ctx.advance(4 * MINUTE);
    await feedAllExcept(ctx, quiet);
    assert.equal(ctx.container.staleness.sweep().markedStale, 0);
    assert.equal((await staleAlerts(ctx))[0]!.occurrences, 1);

    // Two hours of silence is worse than half an hour.
    for (let minute = 36; minute < 124; minute += 4) {
      ctx.advance(4 * MINUTE);
      await feedAllExcept(ctx, quiet);
    }
    assert.equal(ctx.container.staleness.sweep().markedStale, 1);
    [alert] = await staleAlerts(ctx);
    assert.equal(alert!.severity, 'high');

    // The next reading from the report clears it.
    await ingest(ctx, [{ reportId: quiet, loadTimeSec: 2 }]);
    [alert] = await staleAlerts(ctx);
    assert.equal(alert!.status, 'resolved');
    assert.equal(ctx.container.staleness.sweep().markedStale, 0);
  });

  it('treats a silent feed as one system problem, not as a hundred stale reports', async () => {
    const ctx = await context({ FEED_SILENT_AFTER_SEC: '300' });
    await feedAllExcept(ctx);
    const notices: string[] = [];
    ctx.container.bus.subscribe((record) => {
      if (record.type === 'system.notice') notices.push((record.payload as { code: string }).code);
    });

    ctx.advance(4 * MINUTE);
    assert.equal(ctx.container.staleness.sweep().feedSilent, false);
    ctx.advance(60 * MINUTE);
    assert.deepEqual(ctx.container.staleness.sweep(), { feedSilent: true, markedStale: 0 });
    assert.deepEqual(await staleAlerts(ctx), [], 'no per-report alerts while the feed is down');
    assert.deepEqual(notices, ['telemetry.feed_silent']);
    const viewer = await ctx.login(VIEWER);
    assert.equal((await ctx.get('/system/status', viewer)).body.telemetry.feedSilent, true);

    // Still down on the next sweep: it is announced once.
    ctx.advance(MINUTE);
    ctx.container.staleness.sweep();
    assert.deepEqual(notices, ['telemetry.feed_silent']);

    // The feed returns. Everything was silent for over an hour, yet nothing is flagged: each
    // report gets a fresh grace period measured from the recovery.
    await ingest(ctx, [{ reportId: owned(ctx), loadTimeSec: 2 }]);
    assert.deepEqual(ctx.container.staleness.sweep(), { feedSilent: false, markedStale: 0 });
    assert.deepEqual(notices, ['telemetry.feed_silent', 'telemetry.feed_recovered']);
    assert.equal((await ctx.get('/system/status', viewer)).body.telemetry.feedSilent, false);

    const kinds = (
      (await ctx.get('/notifications', await ctx.login(ADMIN))).body.items as Notification[]
    )
      .map((n) => n.kind)
      .reverse();
    assert.deepEqual(kinds, ['feed_silent', 'feed_recovered']);
  });

  it('gives a newly started server a grace period instead of alerting at once', async () => {
    const ctx = await context();
    assert.deepEqual(ctx.container.staleness.sweep(), { feedSilent: false, markedStale: 0 });
  });

  it('raises nothing when the rule is disabled', async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    await ctx.put('/alert-rules/telemetry_stale', admin, { enabled: false });
    await feedAllExcept(ctx);
    for (let minute = 0; minute < 40; minute += 4) {
      ctx.advance(4 * MINUTE);
      await feedAllExcept(ctx, owned(ctx));
    }
    assert.equal(ctx.container.staleness.sweep().markedStale, 0);
  });
});

describe('alert notifications', () => {
  interface Call {
    url: string;
    body: Record<string, unknown>;
  }
  /** A webhook that records what it is sent and answers with the given statuses in turn. */
  const webhook = (statuses: number[] = []) => {
    const calls: Call[] = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: statuses.shift() ?? 200 });
    }) as typeof fetch;
    return { calls, fetchStub };
  };
  const withWebhook = async (
    hook: ReturnType<typeof webhook>,
    env: Record<string, string> = {},
  ): Promise<TestContext> =>
    context(
      { NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/services/T000/B000/secret', ...env },
      { notifications: { fetch: hook.fetchStub } },
    );
  /** Oldest first. Signs in afresh, because these tests move the clock past a session. */
  const list = async (ctx: TestContext) =>
    ctx
      .get('/notifications?pageSize=200', await ctx.login(ADMIN))
      .then((r) => (r.body.items as Notification[]).reverse());

  it('tells the owner once when a high-severity alert opens, and once when it clears', async () => {
    const hook = webhook();
    const ctx = await withWebhook(hook);
    const reportId = owned(ctx);
    const owner = ctx.container.ownership.ownerOf(reportId).email;
    await settle(ctx, reportId);

    await ingest(ctx, [{ reportId, refreshStatus: 'FAILED' }]);
    await ingest(ctx, [{ reportId, refreshStatus: 'FAILED' }]);
    await ctx.container.notifications.flush();
    let sent = await list(ctx);
    assert.equal(sent.length, 1, 'the second failure is the same incident');
    assert.deepEqual(
      [sent[0]!.kind, sent[0]!.recipient, sent[0]!.status, sent[0]!.channel, sent[0]!.attempts],
      ['fired', owner, 'sent', 'webhook', 1],
    );
    assert.match(sent[0]!.title, /^\[HIGH\] Automated refresh failed: /);
    assert.equal(hook.calls.length, 1);
    assert.deepEqual(Object.keys(hook.calls[0]!.body), ['text'], 'Slack-compatible payload');
    assert.match(String(hook.calls[0]!.body.text), new RegExp(`Owner: ${owner}`));

    await ingest(ctx, [{ reportId, refreshStatus: 'SUCCESS' }]);
    await ctx.container.notifications.flush();
    sent = await list(ctx);
    assert.deepEqual(
      sent.map((n) => n.kind),
      ['fired', 'resolved'],
    );
    assert.match(sent[1]!.title, /^\[RESOLVED\]/);
    assert.equal(hook.calls.length, 2);
  });

  it('keeps low-severity alerts on the dashboard and notifies when they escalate', async () => {
    const hook = webhook();
    const ctx = await withWebhook(hook);
    const reportId = owned(ctx);
    await settle(ctx, reportId);

    await ingest(ctx, [{ reportId, loadTimeSec: 20 }]);
    assert.deepEqual(await list(ctx), [], 'a warning notifies nobody');
    await ingest(ctx, [{ reportId, loadTimeSec: 35 }]);
    await ingest(ctx, [{ reportId, loadTimeSec: 50 }]);
    await ingest(ctx, [{ reportId, loadTimeSec: 35 }]);
    await ingest(ctx, [{ reportId, loadTimeSec: 50 }]);
    assert.deepEqual(
      (await list(ctx)).map((n) => [n.kind, n.severity]),
      [
        ['escalated', 'high'],
        ['escalated', 'critical'],
      ],
      'once per severity reached, not once per crossing',
    );

    // It cleared without ever having been announced at warning level... but it was announced
    // at high, so the loop is closed.
    await settle(ctx, reportId);
    assert.equal((await list(ctx)).at(-1)!.kind, 'resolved');

    // A warning that comes and goes on its own is never mentioned.
    const before = (await list(ctx)).length;
    await ingest(ctx, [{ reportId, loadTimeSec: 20 }]);
    await settle(ctx, reportId);
    assert.equal((await list(ctx)).length, before);
  });

  it('sends alerts on unowned reports to the platform admins', async () => {
    const hook = webhook();
    const ctx = await withWebhook(hook);
    const reportId = orphaned(ctx);
    await settle(ctx, reportId);
    await ingest(ctx, [{ reportId, refreshStatus: 'TIMED_OUT' }]);
    const [n] = await list(ctx);
    assert.equal(n!.recipient, 'platform-admins');
    assert.match(n!.body, /Owner: none, routed to platform admins/);
  });

  it('escalates to the admins when nobody acknowledges in time, once', async () => {
    const hook = webhook();
    const ctx = await withWebhook(hook, { NOTIFY_ESCALATE_AFTER_MIN: '15' });
    const admin = await ctx.login(ADMIN);
    const [first, second] = reportIds(ctx).filter(
      (id) => ctx.container.ownership.ownerOf(id).email !== null,
    );
    await settle(ctx, first!);
    await settle(ctx, second!);
    await ingest(ctx, [
      { reportId: first, refreshStatus: 'FAILED' },
      { reportId: second, refreshStatus: 'FAILED' },
    ]);
    // Somebody takes the second one.
    const alertId = (await ctx.get(`/alerts?reportId=${second}&ruleId=refresh_failure`, admin)).body
      .items[0].id as string;
    await ctx.post(`/alerts/${alertId}/ack`, admin, { note: 'on it' });

    ctx.advance(10 * MINUTE);
    assert.equal(ctx.container.notifications.sweep(), 0, 'not yet');
    ctx.advance(6 * MINUTE);
    assert.equal(ctx.container.notifications.sweep(), 1, 'only the one nobody took');
    assert.equal(ctx.container.notifications.sweep(), 0, 'and only once');
    await ctx.container.notifications.flush();

    const escalation = (await list(ctx)).find((n) => n.kind === 'unacknowledged')!;
    assert.deepEqual(
      [escalation.reportId, escalation.recipient, escalation.status],
      [first, 'platform-admins', 'sent'],
    );
    assert.match(escalation.body, /Nobody has acknowledged this high alert for 16 minutes/);
  });

  it('respects a snooze', async () => {
    const hook = webhook();
    const ctx = await withWebhook(hook);
    const admin = await ctx.login(ADMIN);
    const reportId = owned(ctx);
    await settle(ctx, reportId);
    await ingest(ctx, [{ reportId, loadTimeSec: 20 }]);
    const alertId = (await ctx.get(`/alerts?reportId=${reportId}&ruleId=latency`, admin)).body
      .items[0].id as string;
    await ctx.post(`/alerts/${alertId}/snooze`, admin, { minutes: 60 });
    await ingest(ctx, [{ reportId, loadTimeSec: 50 }]);
    assert.deepEqual(await list(ctx), []);
  });

  it('retries a failing webhook with backoff, then gives up and says so', async () => {
    const hook = webhook([500, 503, 200]);
    const ctx = await withWebhook(hook);
    const reportId = owned(ctx);
    await settle(ctx, reportId);
    await ingest(ctx, [{ reportId, refreshStatus: 'FAILED' }]);
    await ctx.container.notifications.flush();
    let [n] = await list(ctx);
    assert.deepEqual([n!.status, n!.attempts], ['pending', 1]);
    assert.match(n!.lastError!, /HTTP 500/);

    await ctx.container.notifications.flush();
    assert.equal(hook.calls.length, 1, 'not retried before the backoff has passed');
    ctx.advance(31_000);
    await ctx.container.notifications.flush();
    [n] = await list(ctx);
    assert.deepEqual([n!.status, n!.attempts], ['pending', 2]);
    ctx.advance(61_000);
    await ctx.container.notifications.flush();
    [n] = await list(ctx);
    assert.deepEqual([n!.status, n!.attempts, n!.lastError], ['sent', 3, null]);

    // A webhook that never recovers.
    const dead = webhook(Array<number>(10).fill(500));
    const ctx2 = await withWebhook(dead);
    await settle(ctx2, reportId);
    await ingest(ctx2, [{ reportId, refreshStatus: 'FAILED' }]);
    for (let attempt = 0; attempt < 8; attempt++) {
      await ctx2.container.notifications.flush();
      ctx2.advance(20 * MINUTE);
    }
    const [failed] = await list(ctx2);
    assert.deepEqual([failed!.status, failed!.attempts], ['failed', 5]);
    assert.equal(dead.calls.length, 5);
    assert.equal(
      (await ctx2.get('/system/status', await ctx2.login(ADMIN))).body.notifications.failed,
      1,
    );
  });

  it('sends a burst as one digest instead of one message each', async () => {
    const hook = webhook();
    const ctx = await withWebhook(hook);
    const reports = reportIds(ctx)
      .filter((id) => ctx.container.ownership.ownerOf(id).email !== null)
      .slice(0, 6);
    for (const reportId of reports) await settle(ctx, reportId);
    // One upstream failure takes six reports down in the same batch.
    await ingest(
      ctx,
      reports.map((reportId) => ({ reportId, refreshStatus: 'FAILED' })),
    );
    await ctx.container.notifications.flush();
    assert.equal(hook.calls.length, 1, 'one message for the whole burst');
    const text = String(hook.calls[0]!.body.text);
    assert.match(text, /^\*6 alert notifications\*/);
    assert.equal(text.split('\n').length, 7, 'a line per alert under the heading');
    const sent = await list(ctx);
    assert.deepEqual(
      sent.map((n) => n.status),
      Array(6).fill('sent'),
    );
  });

  it('delivers over real HTTP to a real endpoint', async () => {
    // No stub here: a local HTTP server stands in for Slack and the service uses the real fetch.
    const received: { path: string; contentType: string; body: { text: string } }[] = [];
    const receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          contentType: req.headers['content-type'] ?? '',
          body: JSON.parse(body),
        });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const { port } = receiver.address() as AddressInfo;
    try {
      const ctx = await context({ NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${port}/services/hook` });
      const reportId = owned(ctx);
      await settle(ctx, reportId);
      await ingest(ctx, [{ reportId, refreshStatus: 'FAILED' }]);
      await ctx.container.notifications.flush();
      assert.equal(received.length, 1);
      assert.equal(received[0]!.path, '/services/hook');
      assert.match(received[0]!.contentType, /application\/json/);
      assert.match(received[0]!.body.text, /^\*\[HIGH\] Automated refresh failed: /);
      assert.equal((await list(ctx))[0]!.status, 'sent');
    } finally {
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    }
  });

  it('records notifications without sending them when no webhook is configured', async () => {
    const hook = webhook();
    const ctx = await context({}, { notifications: { fetch: hook.fetchStub } });
    const admin = await ctx.login(ADMIN);
    const reportId = owned(ctx);
    await settle(ctx, reportId);
    await ingest(ctx, [{ reportId, refreshStatus: 'FAILED' }]);
    await ctx.container.notifications.flush();
    const [n] = await list(ctx);
    assert.deepEqual([n!.status, n!.channel, n!.attempts], ['skipped', 'none', 0]);
    assert.equal(hook.calls.length, 0);
    assert.equal((await ctx.get('/system/status', admin)).body.notifications.channel, 'none');
  });

  it('can post the structured form instead of the Slack form', async () => {
    const hook = webhook();
    const ctx = await withWebhook(hook, {
      NOTIFY_WEBHOOK_FORMAT: 'json',
      NOTIFY_MIN_SEVERITY: 'warning',
    });
    const reportId = owned(ctx);
    await settle(ctx, reportId);
    await ingest(ctx, [{ reportId, loadTimeSec: 20 }]);
    await ctx.container.notifications.flush();
    const body = hook.calls[0]!.body;
    assert.deepEqual([body.kind, body.reportId, body.severity], ['fired', reportId, 'warning']);
    assert.equal('status' in body, false);
  });

  it('is visible to admins only', async () => {
    const ctx = await context();
    for (const [email, status] of [
      [ADMIN, 200],
      [FINOPS, 403],
      [OWNER, 403],
      [VIEWER, 403],
    ] as const) {
      assert.equal((await ctx.get('/notifications', await ctx.login(email))).status, status, email);
    }
  });
});

describe('metrics endpoint', () => {
  it('reports requests by route pattern, telemetry, alerts and warehouse state', async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    const [a, b] = reportIds(ctx);
    await ctx.get(`/reports/${a}`, admin);
    await ctx.get(`/reports/${b}`, admin);
    await ctx.get('/reports/RPT_999999', admin);
    await ingest(ctx, [
      { reportId: a, loadTimeSec: 3, eventId: 'metrics-0001' },
      { reportId: a, loadTimeSec: 3, eventId: 'metrics-0001' },
      { reportId: 'RPT_999999', loadTimeSec: 3 },
    ]);
    const res = await request(ctx.app).get('/metrics');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/plain/);
    const text = res.text;
    const value = (line: string): number => {
      const found = text.split('\n').find((l) => l.startsWith(`${line} `));
      assert.ok(found, `missing series: ${line}`);
      return Number(found.slice(line.length + 1));
    };
    // One series for the route, however many different reports were asked for.
    assert.equal(
      value(
        'picc_http_requests_total{method="GET",route="/api/v1/reports/:reportId",status="200"}',
      ),
      2,
    );
    assert.equal(
      value(
        'picc_http_requests_total{method="GET",route="/api/v1/reports/:reportId",status="404"}',
      ),
      1,
    );
    assert.equal(text.includes(a!), false, 'no report id leaks into a label');
    assert.equal(value('picc_telemetry_events{outcome="accepted"}'), 1);
    assert.equal(value('picc_telemetry_events{outcome="duplicate"}'), 1);
    assert.equal(value('picc_telemetry_events{outcome="rejected"}'), 1);
    assert.equal(value('picc_telemetry_feed_silent'), 0);
    assert.equal(value('picc_warehouse_reconciliation_checks{status="FAIL"}'), 0);
    assert.ok(value('picc_warehouse_reconciliation_checks{status="PASS"}') >= 15);
    assert.ok(value('picc_alerts_open{severity="critical"}') >= 0);
    assert.ok(value('picc_process_resident_memory_bytes') > 0);
    assert.ok(
      value(
        'picc_http_request_duration_seconds_count{method="GET",route="/api/v1/reports/:reportId"}',
      ) === 3,
    );
    for (const line of text.split('\n')) {
      if (line && !line.startsWith('#')) assert.match(line, /^[a-z_]+(\{[^}]*\})? -?[\d.e+-]+$/);
    }
  });

  it('gives an unmatched path one label, whatever the path', async () => {
    const ctx = await context();
    await request(ctx.app).get('/api/v1/no-such-thing-1');
    await request(ctx.app).get('/api/v1/no-such-thing-2');
    const text = (await request(ctx.app).get('/metrics')).text;
    assert.match(text, /route="other",status="404"\} 2/);
    assert.equal(text.includes('no-such-thing'), false);
  });

  it('requires the token when one is set, and hides in production otherwise', async () => {
    const token = 'metrics-token-0123456789';
    const guarded = await context({ METRICS_TOKEN: token });
    assert.equal((await request(guarded.app).get('/metrics')).status, 404);
    assert.equal(
      (await request(guarded.app).get('/metrics').set('authorization', 'Bearer wrong')).status,
      404,
    );
    assert.equal(
      (await request(guarded.app).get('/metrics').set('authorization', `Bearer ${token}`)).status,
      200,
    );
    const production = await context({ NODE_ENV: 'production', DEMO_MODE: 'false' });
    assert.equal((await request(production.app).get('/metrics')).status, 404);
  });
});

describe('refreshing the warehouse without a restart', () => {
  /** The real snapshot with one report renamed, one added and a new build time. */
  const changed = async (): Promise<WarehouseSnapshot> => {
    const base = await getSnapshot();
    const template = base.dim[0]!;
    return {
      ...base,
      builtAt: '2026-11-01T00:00:00.000Z',
      dim: [
        { ...template, report_name: 'Renamed By Refresh' },
        ...base.dim.slice(1),
        { ...template, report_id: 'RPT_777777', report_name: 'Brand New Report' },
      ],
    };
  };

  it('reports "unchanged" when the source has nothing new', async () => {
    const ctx = await context();
    const admin = await ctx.login(ADMIN);
    const before = ctx.container.snapshot;
    const res = await ctx.post('/admin/warehouse/refresh', admin);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.outcome, res.body.error], ['unchanged', null]);
    assert.equal(ctx.container.snapshot, before);
  });

  it('swaps in new data for every service at once, and tells connected clients', async () => {
    let builds = 0;
    const next = await changed();
    const ctx = await context(
      {},
      {
        buildSnapshot: async () => {
          builds += 1;
          // Slow enough that the second request arrives while the first is still running.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return next;
        },
      },
    );
    const admin = await ctx.login(ADMIN);
    const renamed = next.dim[0]!.report_id;
    const notices: string[] = [];
    ctx.container.bus.subscribe((record) => {
      if (record.type === 'system.notice') notices.push((record.payload as { code: string }).code);
    });
    assert.equal((await ctx.get('/reports/RPT_777777', admin)).status, 404);

    // Two admins press the button at the same moment: one refresh runs.
    const [first, second] = await Promise.all([
      ctx.post('/admin/warehouse/refresh', admin),
      ctx.post('/admin/warehouse/refresh', admin),
    ]);
    assert.deepEqual([first.body.outcome, second.body.outcome], ['refreshed', 'refreshed']);
    assert.equal(builds, 1);
    assert.deepEqual(notices, ['warehouse.refreshed']);

    assert.equal(
      (await ctx.get(`/reports/${renamed}`, admin)).body.reportName,
      'Renamed By Refresh',
    );
    assert.equal((await ctx.get('/reports/RPT_777777', admin)).body.reportName, 'Brand New Report');
    assert.equal((await ctx.get('/reports?pageSize=500', admin)).body.total, next.dim.length);
    assert.equal((await ctx.get('/dq/summary', admin)).body.reports, next.dim.length);
    // Telemetry for the new report is accepted from now on.
    assert.equal((await ingest(ctx, [{ reportId: 'RPT_777777', loadTimeSec: 3 }])).accepted, 1);

    const status = (await ctx.get('/system/status', admin)).body.warehouse;
    assert.deepEqual(
      [status.builtAt, status.lastRefreshOutcome, status.lastRefreshError],
      ['2026-11-01T00:00:00.000Z', 'refreshed', null],
    );
    const audit = (await ctx.get('/audit-log?action=warehouse.refresh', admin)).body.items;
    assert.equal(audit.length, 2);
    assert.equal(audit[0].detail.outcome, 'refreshed');
  });

  it('keeps the previous data when the source is unreachable', async () => {
    const ctx = await context(
      {},
      {
        buildSnapshot: async () => {
          throw new Error('Network error: could not reach the warehouse');
        },
      },
    );
    const admin = await ctx.login(ADMIN);
    const before = ctx.container.snapshot;
    const res = await ctx.post('/admin/warehouse/refresh', admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'failed');
    assert.match(res.body.error, /could not reach the warehouse/);
    assert.equal(ctx.container.snapshot, before);
    assert.equal((await ctx.get('/overview', admin)).status, 200);

    const status = (await ctx.get('/system/status', admin)).body.warehouse;
    assert.equal(status.lastRefreshOutcome, 'failed');
    assert.match(status.lastRefreshError, /could not reach/);

    // The admins are told, once an hour at most rather than once per attempt.
    await ctx.post('/admin/warehouse/refresh', admin);
    const told = ((await ctx.get('/notifications', admin)).body.items as Notification[]).filter(
      (n) => n.kind === 'warehouse_refresh_failed',
    );
    assert.equal(told.length, 1);
  });

  it('refuses new data that fails a reconciliation check', async () => {
    const next = await changed();
    const bad: WarehouseSnapshot = {
      ...next,
      reconciliation: next.reconciliation.map((check, index) =>
        index === 0 ? { ...check, status: 'FAIL' } : check,
      ),
    };
    const ctx = await context({}, { buildSnapshot: async () => bad });
    const admin = await ctx.login(ADMIN);
    const res = await ctx.post('/admin/warehouse/refresh', admin);
    assert.equal(res.body.outcome, 'failed');
    assert.match(res.body.error, /failed 1 reconciliation check/);
    assert.equal(
      (await ctx.get('/reports/RPT_777777', admin)).status,
      404,
      'bad data never went live',
    );
    assert.equal((await request(ctx.app).get('/readyz')).status, 200);
  });

  it('is an admin action', async () => {
    const ctx = await context();
    assert.equal((await ctx.post('/admin/warehouse/refresh', await ctx.login(FINOPS))).status, 403);
  });
});

after(() => {
  for (const ctx of open.splice(0)) ctx.close();
});
