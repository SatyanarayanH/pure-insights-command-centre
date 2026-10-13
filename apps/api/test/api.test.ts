import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ReportDetailSchema } from '@picc/contracts';
import request from 'supertest';
import {
  ADMIN,
  API,
  createTestContext,
  FINOPS,
  OWNER,
  type TestContext,
  VIEWER,
} from './helpers.js';

let ctx: TestContext;
let admin: string;
let finops: string;

before(async () => {
  ctx = await createTestContext();
  admin = await ctx.login(ADMIN);
  finops = await ctx.login(FINOPS);
});
after(() => ctx.close());

const cookieOf = (res: request.Response): string => {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith('picc_refresh='));
  assert.ok(cookie, 'refresh cookie set');
  return cookie.split(';')[0]!;
};

describe('authentication', () => {
  it('signs in with the demo password and returns role and permissions', async () => {
    const res = await request(ctx.app)
      .post(`${API}/auth/login`)
      .send({ email: '  Admin@Company.com ', password: ctx.container.config.demoPassword });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'admin');
    assert.ok(res.body.user.permissions.includes('orphans:assign'));
    assert.equal(res.body.expiresIn, 900);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrong = await request(ctx.app)
      .post(`${API}/auth/login`)
      .send({ email: ADMIN, password: 'nope-nope-nope' });
    const unknown = await request(ctx.app)
      .post(`${API}/auth/login`)
      .send({ email: 'ghost@company.com', password: 'nope-nope-nope' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.detail, unknown.body.detail);
  });

  it('sets the refresh token as an httpOnly, SameSite=Strict cookie scoped to the auth path', async () => {
    const res = await request(ctx.app).post(`${API}/auth/demo-login`).send({ email: VIEWER });
    const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('picc_refresh='),
    )!;
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Strict/i);
    assert.match(raw, /Path=\/api\/v1\/auth/);
    assert.doesNotMatch(JSON.stringify(res.body), /picc_refresh/);
  });

  it('rotates the refresh token, and revokes the session when an old token is replayed', async () => {
    const login = await request(ctx.app).post(`${API}/auth/demo-login`).send({ email: VIEWER });
    const first = cookieOf(login);

    const refreshed = await request(ctx.app).post(`${API}/auth/refresh`).set('cookie', first);
    assert.equal(refreshed.status, 200);
    const second = cookieOf(refreshed);
    assert.notEqual(second, first);

    // An attacker replays the stolen first token: refused, and the whole family is revoked.
    assert.equal(
      (await request(ctx.app).post(`${API}/auth/refresh`).set('cookie', first)).status,
      401,
    );
    assert.equal(
      (await request(ctx.app).post(`${API}/auth/refresh`).set('cookie', second)).status,
      401,
    );
  });

  it('ends the session on logout', async () => {
    const login = await request(ctx.app).post(`${API}/auth/demo-login`).send({ email: VIEWER });
    const cookie = cookieOf(login);
    assert.equal(
      (await request(ctx.app).post(`${API}/auth/logout`).set('cookie', cookie)).status,
      200,
    );
    assert.equal(
      (await request(ctx.app).post(`${API}/auth/refresh`).set('cookie', cookie)).status,
      401,
    );
  });

  it('rejects a tampered or expired access token', async () => {
    assert.equal((await ctx.get('/auth/me', `${admin}x`)).status, 401);
    const expiring = await createTestContext({ ACCESS_TOKEN_TTL_SEC: '60' });
    try {
      const token = await expiring.login(ADMIN);
      assert.equal((await expiring.get('/auth/me', token)).status, 200);
      expiring.advance(61_000);
      assert.equal((await expiring.get('/auth/me', token)).status, 401);
    } finally {
      expiring.close();
    }
  });

  it('refuses demo sign-in when demo mode is off', async () => {
    const strict = await createTestContext({ DEMO_MODE: 'false' });
    try {
      const res = await request(strict.app).post(`${API}/auth/demo-login`).send({ email: ADMIN });
      assert.equal(res.status, 403);
      assert.deepEqual((await request(strict.app).get(`${API}/auth/config`)).body, {
        demoMode: false,
        personas: [],
      });
    } finally {
      strict.close();
    }
  });
});

describe('error contract', () => {
  it('returns RFC 9457 problem details with field-level errors and a request id', async () => {
    const res = await ctx.get('/reports?pageSize=0&sort=nope', admin);
    assert.equal(res.status, 400);
    assert.match(String(res.headers['content-type']), /application\/problem\+json/);
    assert.equal(res.body.code, 'validation_failed');
    assert.deepEqual(res.body.errors.map((e: { path: string }) => e.path).sort(), [
      'query.pageSize',
      'query.sort',
    ]);
    assert.equal(res.body.requestId, res.headers['x-request-id']);
  });

  it('answers unknown API paths and malformed JSON in the same shape', async () => {
    const missing = await ctx.get('/no-such-thing', admin);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
    const malformed = await request(ctx.app)
      .post(`${API}/auth/login`)
      .set('content-type', 'application/json')
      .send('{not json');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'bad_request');
  });

  it('echoes a caller-supplied request id', async () => {
    const res = await ctx.get('/overview', admin).set('x-request-id', 'trace-1234-abcd');
    assert.equal(res.headers['x-request-id'], 'trace-1234-abcd');
  });
});

describe('reports', () => {
  it('lists all 100 reports with filtering, sorting and paging', async () => {
    const all = await ctx.get('/reports?pageSize=500', admin);
    assert.equal(all.body.total, 100);

    const orphaned = await ctx.get('/reports?orphaned=true&pageSize=500', admin);
    assert.equal(orphaned.body.total, 14);
    assert.ok(
      orphaned.body.items.every(
        (r: { isOrphaned: boolean; ownerEmail: null }) => r.isOrphaned && r.ownerEmail === null,
      ),
    );

    const costly = await ctx.get('/reports?sort=totalCostUsd&order=desc&pageSize=10', admin);
    const costs = costly.body.items.map(
      (r: { cost: { totalCostUsd: number } }) => r.cost.totalCostUsd,
    );
    assert.deepEqual(
      costs,
      [...costs].sort((a, b) => b - a),
    );

    const page2 = await ctx.get('/reports?page=2&pageSize=30', admin);
    assert.equal(page2.body.items.length, 30);
    assert.equal(page2.body.items[0].reportId, 'RPT_230');
  });

  it('returns a report with its 20-period history and ownership trail', async () => {
    const res = await ctx.get('/reports/RPT_203', admin);
    assert.equal(res.status, 200);
    const detail = ReportDetailSchema.parse(res.body);
    assert.equal(detail.history.length, 20);
    assert.equal(detail.ownership.history.length, 20);
    assert.equal(detail.history[0]!.periodLabel, 'P01');
    assert.equal(
      detail.history[0]!.isOrphaned,
      true,
      'RPT_203 has owner "nan" in the first period',
    );
    assert.equal(detail.ownership.distinctOwners, 9, 'nine named owners in 20 periods');
  });

  it('summarises health for the overview', async () => {
    const { body } = await ctx.get('/overview', admin);
    assert.equal(body.reports.total, 100);
    assert.equal(body.reports.orphaned, 14);
    assert.equal(body.trend.length, 20);
    assert.equal(body.latency.thresholdSec, 15);
    assert.equal(
      body.latency.distribution.reduce((a: number, b: { reports: number }) => a + b.reports, 0),
      100,
    );
    assert.ok(body.cost.totalCostUsd > 0);
    assert.equal(body.asOf.periodLabel, 'P20');
    assert.match(body.asOf.periodEnd, /^2026-10-01/);
  });
});

describe('orphan remediation', () => {
  it('ranks orphans by cost at risk and suggests an owner from history', async () => {
    const { body } = await ctx.get('/orphans', admin);
    assert.equal(body.total, 14);
    assert.equal(body.assignableOwners.length, 14);
    assert.ok(body.totalCostAtRiskUsd > 0);
    assert.ok(body.items[0].costAtRiskUsd >= body.items[1].costAtRiskUsd);
    assert.match(body.items[0].suggestedOwner, /@company\.com$/);
  });

  it('assigns an owner: queue shrinks, alerts re-route, the change is audited, the owner gains access', async () => {
    const queue = (await ctx.get('/orphans', admin)).body;
    const target = queue.items.find((o: { activeAlerts: number }) => o.activeAlerts > 0);
    const owner = await ctx.login(OWNER);
    assert.equal((await ctx.get(`/reports/${target.reportId}`, owner)).status, 404);

    const res = await ctx.post(`/reports/${target.reportId}/owner`, admin, {
      ownerEmail: OWNER,
      note: 'Confirmed in standup',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ownerEmail, OWNER);
    assert.equal(res.body.previousOwnerEmail, null);

    const after = (await ctx.get('/orphans', admin)).body;
    assert.equal(after.total, queue.total - 1);
    assert.ok(!after.items.some((o: { reportId: string }) => o.reportId === target.reportId));

    const detail = (await ctx.get(`/reports/${target.reportId}`, owner)).body;
    assert.equal(detail.ownerEmail, OWNER);
    assert.equal(detail.ownerSource, 'assigned');
    assert.equal(detail.isOrphaned, false);
    assert.ok(
      detail.alerts.every(
        (a: { routing: { kind: string; escalated: boolean } }) =>
          a.routing.kind === 'owner' && !a.routing.escalated,
      ),
    );

    const alert = (await ctx.get(`/alerts/${detail.alerts[0].id}`, admin)).body;
    assert.equal(alert.timeline.at(-1).type, 'rerouted');

    const audit = (await ctx.get('/audit-log?action=report.owner.assign', admin)).body;
    assert.equal(audit.items[0].actor, ADMIN);
    assert.equal(audit.items[0].targetId, target.reportId);
    assert.equal(audit.items[0].detail.ownerEmail, OWNER);
  });

  it('refuses an assignee who is not a Report Owner, and a no-op reassignment', async () => {
    const orphan = (await ctx.get('/orphans', admin)).body.items[0].reportId;
    const notOwner = await ctx.post(`/reports/${orphan}/owner`, admin, { ownerEmail: FINOPS });
    assert.equal(notOwner.status, 400);
    assert.equal(notOwner.body.errors[0].path, 'ownerEmail');
    await ctx.post(`/reports/${orphan}/owner`, admin, { ownerEmail: OWNER });
    assert.equal(
      (await ctx.post(`/reports/${orphan}/owner`, admin, { ownerEmail: OWNER })).status,
      409,
    );
  });
});

describe('telemetry and alerting through the API', () => {
  const REPORT = 'RPT_240';
  const alertsFor = async (ruleId: string) =>
    (await ctx.get(`/alerts?reportId=${REPORT}&ruleId=${ruleId}&status=active`, admin)).body.items;

  it('accepts a batch, processes the valid events and reports the rejected ones', async () => {
    const res = await ctx.post('/telemetry', admin, {
      events: [
        { reportId: REPORT, loadTimeSec: 4.2, refreshStatus: 'SUCCESS' },
        { reportId: 'RPT_999999', loadTimeSec: 1 },
        { reportId: REPORT },
        { reportId: 'not-an-id', loadTimeSec: 1 },
      ],
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.accepted, 1);
    assert.deepEqual(
      res.body.rejected.map((r: { index: number }) => r.index),
      [1, 2, 3],
    );
    assert.match(res.body.rejected[0].reason, /Unknown report/);
  });

  it('opens a latency alert above 15 s, not at exactly 15 s', async () => {
    // Two healthy observations clear whatever the backfill left open.
    await ctx.post('/telemetry', admin, {
      events: [
        { reportId: REPORT, loadTimeSec: 2 },
        { reportId: REPORT, loadTimeSec: 2 },
        { reportId: REPORT, loadTimeSec: 2 },
        { reportId: REPORT, loadTimeSec: 2 },
        { reportId: REPORT, loadTimeSec: 2 },
      ],
    });
    assert.equal((await alertsFor('latency')).length, 0);

    await ctx.post('/telemetry', admin, { events: [{ reportId: REPORT, loadTimeSec: 15 }] });
    assert.equal(
      (await alertsFor('latency')).length,
      0,
      'exactly 15 s does not exceed the threshold',
    );

    const res = await ctx.post('/telemetry', admin, {
      events: [{ reportId: REPORT, loadTimeSec: 15.5 }],
    });
    assert.equal(res.body.alertsFired, 1);
    const [alert] = await alertsFor('latency');
    assert.equal(alert.severity, 'warning');
    assert.equal(alert.value, 15.5);
    assert.equal(alert.source, 'api');
  });

  it('opens a refresh alert on failure and escalates it on the third in a row', async () => {
    await ctx.post('/telemetry', admin, {
      events: [{ reportId: REPORT, refreshStatus: 'SUCCESS' }],
    });
    await ctx.post('/telemetry', admin, {
      events: [{ reportId: REPORT, refreshStatus: 'FAILED' }],
    });
    assert.equal((await alertsFor('refresh_failure'))[0].severity, 'high');
    await ctx.post('/telemetry', admin, {
      events: [
        { reportId: REPORT, refreshStatus: 'TIMED_OUT' },
        { reportId: REPORT, refreshStatus: 'FAILED' },
      ],
    });
    const [alert] = await alertsFor('refresh_failure');
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.value, 3);
    assert.equal((await ctx.get(`/reports/${REPORT}`, admin)).body.refreshFailureStreak, 3);
  });

  it('injects incidents through the same pipeline and recovers from them', async () => {
    const spike = await ctx.post('/admin/incidents', admin, {
      reportId: 'RPT_241',
      kind: 'latency_spike',
      loadTimeSec: 51,
    });
    assert.equal(spike.status, 202);
    const open = (await ctx.get('/alerts?reportId=RPT_241&ruleId=latency&status=active', admin))
      .body.items;
    assert.equal(open[0].severity, 'critical');

    const recovery = await ctx.post('/admin/incidents', admin, {
      reportId: 'RPT_241',
      kind: 'recovery',
    });
    assert.ok(recovery.body.alertsResolved >= 1);
    assert.equal(
      (await ctx.get('/alerts?reportId=RPT_241&ruleId=latency&status=active', admin)).body.total,
      0,
    );
  });

  it('lets an admin change a threshold, audits it, and rejects inconsistent tiers', async () => {
    const bad = await ctx.put('/alert-rules/latency', admin, { warningThreshold: 40 });
    assert.equal(bad.status, 409, 'warning 40 would exceed high 30');
    const ok = await ctx.put('/alert-rules/latency', admin, { warningThreshold: 20 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.warningThreshold, 20);
    assert.equal(ok.body.updatedBy, ADMIN);
    assert.equal((await ctx.get('/overview', admin)).body.latency.thresholdSec, 20);
    const audit = (await ctx.get('/audit-log?action=alert_rule.update', admin)).body;
    assert.equal(audit.items[0].detail.before.warningThreshold, 15);
    await ctx.put('/alert-rules/latency', admin, { warningThreshold: 15 });
  });
});

describe('alert history from the dataset', () => {
  it('starts with the alerts the engine derived from 20 periods of telemetry', async () => {
    const fresh = await createTestContext();
    try {
      const token = await fresh.login(ADMIN);
      const stats = (await fresh.get('/alerts/stats', token)).body;
      // Expectations are recomputed from the dataset, not copied from a previous run.
      const latest = fresh.container.snapshot.facts.filter((f) => f.period_seq === 19);
      // A refresh alert is open when the most recent *known* outcome was a failure: an UNKNOWN
      // in the latest period must not close an alert that a FAILED opened the period before.
      const facts = fresh.container.snapshot.facts;
      const lastKnownFailed = fresh.container.snapshot.dim.filter((d) => {
        const known = facts
          .filter((f) => f.report_id === d.report_id && !f.is_refresh_unknown)
          .at(-1);
        return known?.is_refresh_failure === true;
      }).length;
      assert.equal(
        latest.filter((f) => f.is_refresh_failure).length,
        25,
        '16 FAILED + 9 TIMED_OUT in the latest period',
      );
      assert.equal(stats.byRule.refresh_failure, lastKnownFailed);
      assert.equal(lastKnownFailed, 26, 'one more is UNKNOWN now but failed before that');
      assert.equal(stats.byRule.refresh_unknown, latest.filter((f) => f.is_refresh_unknown).length);
      assert.equal(
        stats.byRule.invalid_telemetry,
        latest.filter((f) => f.is_cost_quarantined).length,
      );
      // Latency needs two healthy periods to clear, so a few alerts outlive the latest breach.
      const breaching = latest.filter((f) => f.is_latency_breach).length;
      assert.equal(breaching, 76);
      assert.ok(stats.byRule.latency >= breaching && stats.byRule.latency <= 100);
      assert.ok(stats.resolved > 200, 'history, not just current state');
      assert.equal(stats.acknowledged, 0);

      const open = (await fresh.get('/alerts?pageSize=500', token)).body;
      const orphaned = new Set(
        fresh.container.snapshot.dim.filter((d) => d.is_orphaned).map((d) => d.report_id),
      );
      const onOrphans = open.items.filter((a: { reportId: string }) =>
        orphaned.has(a.reportId),
      ).length;
      assert.equal(stats.escalated, onOrphans, 'open alerts on reports nobody owns');
      const escalated = (await fresh.get('/alerts?escalated=true&pageSize=500', token)).body;
      assert.equal(escalated.total, onOrphans);
      assert.ok(
        escalated.items.every((a: { routing: { kind: string } }) => a.routing.kind === 'admins'),
      );
      assert.ok(open.items.every((a: { source: string }) => a.source === 'backfill'));
    } finally {
      fresh.close();
    }
  });
});

describe('cost and data quality', () => {
  it('reconciles the platform bill: metered = report credits + idle + unattributed + quarantined', async () => {
    const { body } = await ctx.get('/costs/summary', finops);
    assert.equal(body.scope, 'all');
    assert.equal(body.creditPriceUsd, 3);
    assert.equal(body.periods.length, 20);
    const p = body.platform;
    assert.equal(p.quarantine.reportPeriods, 24);
    assert.equal(Math.round(p.quarantine.creditsReported * 100) / 100, -161.04);
    assert.ok(
      p.quarantine.creditsImputed > 10000,
      'the hidden cost is large; filtering alone would under-report',
    );
    assert.ok(p.idleShare > 0.1 && p.idleShare < 0.2);
    assert.ok(
      Math.abs(
        p.creditsMeteredCompute -
          (p.creditsAttributedToReports +
            p.creditsIdle +
            p.creditsUnattributed +
            p.creditsQuarantinedImputed),
      ) /
        p.creditsMeteredCompute <
        0.01,
    );
    assert.ok(
      p.correlations.every((c: { pearsonR: number }) => Math.abs(c.pearsonR) < 0.05),
      'usage and cost are unrelated in this dataset',
    );
  });

  it('prices each report per active view and leaves zero-view periods undefined', async () => {
    const latest = (await ctx.get('/costs/reports', finops)).body;
    assert.equal(latest.periodLabel, 'P20');
    assert.equal(latest.items.length, 100);
    const row = latest.items[0];
    assert.ok(Math.abs(row.totalCostPerViewUsd - row.totalCostUsd / row.monthlyActiveViews) < 1e-9);

    const p11 = (await ctx.get('/costs/reports?period=10', finops)).body;
    const zeroViews = p11.items.find((r: { reportId: string }) => r.reportId === 'RPT_299');
    assert.equal(zeroViews.monthlyActiveViews, 0);
    assert.equal(zeroViews.totalCostPerViewUsd, null);
    assert.ok(zeroViews.totalCostUsd > 0);
    assert.equal((await ctx.get('/costs/reports?period=99', finops)).status, 400);
  });

  it('charges back to owners with the unowned pool as its own line', async () => {
    const { items } = (await ctx.get('/costs/chargeback', finops)).body;
    assert.equal(items.length, 15, '14 owners + unowned');
    const unowned = items.find((i: { isUnowned: boolean }) => i.isUnowned);
    assert.equal(unowned.ownerKey, '(unowned)');
    assert.equal(unowned.reportPeriods, 245);
    assert.ok(
      Math.abs(
        items.reduce((a: number, i: { shareOfTotalCost: number }) => a + i.shareOfTotalCost, 0) - 1,
      ) < 1e-9,
    );
  });

  it('lists anomalies with a dollar figure', async () => {
    const { body } = await ctx.get('/costs/anomalies', finops);
    const types = Object.fromEntries(
      body.byType.map((t: { anomalyType: string; count: number }) => [t.anomalyType, t.count]),
    );
    assert.equal(types.QUARANTINED_CREDITS, 24);
    assert.equal(types.ZERO_VIEW_SPEND, 4);
    assert.equal(types.ZOMBIE_REPORT, 5);
  });

  it('exposes data-quality rules, findings traceable to a source line, and the quarantine', async () => {
    const summary = (await ctx.get('/dq/summary', finops)).body;
    assert.equal(summary.rowsLanded, 2000);
    assert.equal(
      summary.rules.filter(
        (r: { inBrief: boolean; rowsAffected: number }) => !r.inBrief && r.rowsAffected > 0,
      ).length,
      5,
      'defects the brief does not list',
    );
    assert.ok(summary.reconciliation.every((c: { status: string }) => c.status === 'PASS'));

    const findings = (await ctx.get('/dq/findings?ruleId=DQ-02&pageSize=100', finops)).body;
    assert.equal(findings.total, 24);
    assert.ok(
      findings.items.every(
        (f: { observedValue: string; rowSeq: number }) =>
          Number(f.observedValue) < 0 && f.rowSeq >= 1 && f.rowSeq <= 2000,
      ),
    );

    const quarantine = (await ctx.get('/dq/quarantine', finops)).body.items;
    assert.equal(quarantine.length, 24);
    assert.ok(
      quarantine.every(
        (q: { creditsReported: number; creditsImputed: number }) =>
          q.creditsReported < 0 && q.creditsImputed > 0,
      ),
    );
  });
});
