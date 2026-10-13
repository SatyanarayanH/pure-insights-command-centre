import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  maskEmail,
  PERMISSIONS,
  ROLE_DEFINITIONS,
  ROLES,
  type Role,
  roleHasPermission,
} from '@picc/contracts';
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

const PERSONA: Record<Role, string> = {
  admin: ADMIN,
  finops: FINOPS,
  owner: OWNER,
  viewer: VIEWER,
};

let ctx: TestContext;
const tokens = {} as Record<Role, string>;
let ownedReport: string;
let foreignReport: string;
let ownedAlert: string;
let foreignAlert: string;

before(async () => {
  ctx = await createTestContext();
  for (const role of ROLES) tokens[role] = await ctx.login(PERSONA[role]);
  const owned = ctx.container.ownership.reportsOwnedBy(OWNER);
  ownedReport = owned[0]!;
  foreignReport = ctx.container.snapshot.dim.find(
    (d) => d.owner_email !== OWNER && d.owner_email !== null,
  )!.report_id;
  const admin = await ctx.get('/alerts?pageSize=500', tokens.admin);
  ownedAlert = admin.body.items.find((a: { reportId: string }) => owned.includes(a.reportId)).id;
  foreignAlert =
    admin.body.items.find((a: { reportId: string }) => a.reportId === foreignReport)?.id ??
    admin.body.items.find((a: { reportId: string }) => !owned.includes(a.reportId)).id;
});
after(() => ctx.close());

describe('role definitions', () => {
  it('gives the admin every permission and nobody else all of them', () => {
    assert.deepEqual([...ROLE_DEFINITIONS.admin.permissions].sort(), [...PERMISSIONS].sort());
    for (const role of ['finops', 'owner', 'viewer'] as const) {
      assert.ok(ROLE_DEFINITIONS[role].permissions.length < PERMISSIONS.length);
    }
  });

  it('keeps cost and unmasked email away from viewers, and writes away from finops', () => {
    assert.equal(roleHasPermission('viewer', 'costs:read'), false);
    assert.equal(roleHasPermission('viewer', 'pii:read'), false);
    for (const write of [
      'orphans:assign',
      'alerts:ack',
      'alert-rules:write',
      'incidents:inject',
    ] as const) {
      assert.equal(roleHasPermission('finops', write), false, write);
    }
  });

  it('scopes report owners to their own reports', () => {
    assert.equal(ROLE_DEFINITIONS.owner.scope, 'own');
    for (const role of ['admin', 'finops', 'viewer'] as const)
      assert.equal(ROLE_DEFINITIONS[role].scope, 'all');
  });

  it('masks email addresses so that different owners cannot be told apart', () => {
    assert.equal(maskEmail('user_7@company.com'), 'u***@company.com');
    assert.equal(
      maskEmail('user_12@company.com'),
      'u***@company.com',
      'neither the last character nor the length survives',
    );
    assert.equal(maskEmail('ab@x.io'), 'a***@x.io');
    assert.equal(maskEmail('not-an-email'), '***');
  });
});

/**
 * The whole access matrix, derived from the route registry rather than written by hand: every
 * protected route is called once per role and once anonymously. A new endpoint is covered the
 * moment it is registered.
 */
describe('access matrix: every route x every role', () => {
  const pathFor = (path: string): string =>
    path
      .replace(':reportId', ownedReport)
      .replace(':alertId', ownedAlert)
      .replace(':ruleId', 'latency');

  it('rejects anonymous calls to every protected route with 401', async () => {
    const protectedRoutes = ctx.routes.filter((r) => r.auth !== 'public');
    assert.ok(protectedRoutes.length >= 25);
    for (const route of protectedRoutes) {
      const res = await request(ctx.app)
        [route.method](`${API}${pathFor(route.path)}`)
        .send({});
      assert.equal(res.status, 401, `${route.method.toUpperCase()} ${route.path}`);
      assert.match(String(res.headers['content-type']), /application\/problem\+json/);
    }
  });

  for (const role of ROLES) {
    it(`${role}: allowed exactly where the role holds the route's permission`, async () => {
      for (const route of ctx.routes.filter((r) => r.auth !== 'public' && r.permission)) {
        const res = await request(ctx.app)
          [route.method](`${API}${pathFor(route.path)}`)
          .set('authorization', `Bearer ${tokens[role]}`)
          .send({});
        const label = `${role} ${route.method.toUpperCase()} ${route.path} -> ${res.status}`;
        if (roleHasPermission(role, route.permission!)) {
          assert.notEqual(res.status, 401, label);
          assert.notEqual(res.status, 403, label);
        } else {
          assert.equal(res.status, 403, label);
          assert.equal(res.body.code, 'forbidden', label);
        }
      }
    });
  }
});

describe('row-level security (Report Owner)', () => {
  it('lists only the reports the owner owns', async () => {
    const res = await ctx.get('/reports?pageSize=500', tokens.owner);
    const owned = ctx.container.ownership.reportsOwnedBy(OWNER);
    assert.equal(res.body.total, owned.length);
    assert.deepEqual(
      res.body.items.map((r: { reportId: string }) => r.reportId).sort(),
      [...owned].sort(),
    );
  });

  it('answers 404 for a report it does not own, exactly as for one that does not exist', async () => {
    const foreign = await ctx.get(`/reports/${foreignReport}`, tokens.owner);
    const missing = await ctx.get('/reports/RPT_999999', tokens.owner);
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(foreign.body.code, missing.body.code);
    assert.equal((await ctx.get(`/reports/${ownedReport}`, tokens.owner)).status, 200);
  });

  it('scopes alerts, overview and cost to the same reports', async () => {
    const owned = new Set(ctx.container.ownership.reportsOwnedBy(OWNER));
    const alerts = await ctx.get('/alerts?status=all&pageSize=500', tokens.owner);
    assert.ok(alerts.body.total > 0);
    assert.ok(alerts.body.items.every((a: { reportId: string }) => owned.has(a.reportId)));

    const overview = await ctx.get('/overview', tokens.owner);
    assert.equal(overview.body.scope, 'own');
    assert.equal(overview.body.reports.total, owned.size);

    const costs = await ctx.get('/costs/summary', tokens.owner);
    assert.equal(costs.body.scope, 'own');
    assert.equal(
      costs.body.platform,
      null,
      'platform-wide reconciliation is not for a single owner',
    );
    assert.equal(costs.body.latest.reports, owned.size);
    assert.equal(costs.body.latest.creditsMeteredCompute, null);
  });

  it("cannot read or acknowledge an alert on someone else's report", async () => {
    assert.equal((await ctx.get(`/alerts/${foreignAlert}`, tokens.owner)).status, 404);
    assert.equal((await ctx.post(`/alerts/${foreignAlert}/ack`, tokens.owner)).status, 404);
    // The access-matrix run above already acknowledged one alert, so take one still firing.
    const firing = await ctx.get('/alerts?status=firing', tokens.owner);
    const target = firing.body.items[0].id as string;
    const own = await ctx.post(`/alerts/${target}/ack`, tokens.owner, { note: 'looking into it' });
    assert.equal(own.status, 200);
    assert.equal(own.body.status, 'acknowledged');
    assert.equal(own.body.acknowledgedBy, OWNER);
  });
});

describe('field-level security (Viewer)', () => {
  it('receives no cost block and no efficiency label on any report', async () => {
    const res = await ctx.get('/reports?pageSize=500', tokens.viewer);
    assert.equal(res.body.total, 100);
    for (const report of res.body.items) {
      assert.equal(report.cost, null);
      assert.equal(report.efficiencyQuadrant, null);
    }
    const detail = await ctx.get(`/reports/${ownedReport}`, tokens.viewer);
    assert.ok(detail.body.history.every((h: { cost: unknown }) => h.cost === null));
    assert.equal((await ctx.get('/overview', tokens.viewer)).body.cost, null);
  });

  it('receives masked owner emails everywhere, never the real address', async () => {
    const res = await ctx.get('/reports?pageSize=500', tokens.viewer);
    const text = JSON.stringify(res.body);
    assert.doesNotMatch(text, /user_\d+@company\.com/);
    assert.match(text, /u\*\*\*@company\.com/);
    const distinct = new Set(
      res.body.items.map((r: { ownerEmail: string | null }) => r.ownerEmail).filter(Boolean),
    );
    assert.equal(distinct.size, 1, 'every owner looks the same to a viewer');
    const alerts = await ctx.get('/alerts?status=all&pageSize=500', tokens.viewer);
    assert.doesNotMatch(JSON.stringify(alerts.body), /user_\d+@company\.com/);
  });

  it('cannot use the owner filter to work out who owns what', async () => {
    const res = await ctx.get('/reports?owner=user_7@company.com', tokens.viewer);
    assert.equal(res.status, 403);
    assert.match(res.body.detail, /pii:read/);
    // The same filter is fine for a role that may see the addresses anyway.
    assert.equal((await ctx.get('/reports?owner=user_7@company.com', tokens.finops)).body.total, 7);
  });

  it('cannot sort its way to cost information', async () => {
    const res = await ctx.get('/reports?sort=totalCostUsd&order=desc&pageSize=5', tokens.viewer);
    assert.equal(res.status, 200);
    // Without costs:read the sort silently falls back to report id.
    assert.deepEqual(
      res.body.items.map((r: { reportId: string }) => r.reportId),
      ['RPT_299', 'RPT_298', 'RPT_297', 'RPT_296', 'RPT_295'],
    );
  });
});

describe('machine identity (telemetry emitter)', () => {
  it('may push telemetry with the API key and nothing else', async () => {
    const key = 'test-ingest-key-0123456789';
    const ok = await request(ctx.app)
      .post(`${API}/telemetry`)
      .set('x-api-key', key)
      .send({ events: [{ reportId: ownedReport, loadTimeSec: 3 }] });
    assert.equal(ok.status, 202);
    const bad = await request(ctx.app)
      .post(`${API}/telemetry`)
      .set('x-api-key', 'wrong-key')
      .send({ events: [{}] });
    assert.equal(bad.status, 401);
    // The key is only honoured on the ingest route.
    assert.equal((await request(ctx.app).get(`${API}/reports`).set('x-api-key', key)).status, 401);
  });
});
