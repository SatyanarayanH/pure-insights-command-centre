import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_RAW_CSV, SQL_DIR } from '../src/paths.js';
import { csvLine, parseCsvObjects } from '../src/warehouse/csv.js';
import { buildWarehouseSnapshot, type WarehouseSnapshot } from '../src/warehouse/snapshot.js';
import { ADMIN, createTestContext, type TestContext } from './helpers.js';

/**
 * The pipeline was written against one file. These tests feed it files it has never seen:
 * dirtier values, a different shape, missing rows. A validation pipeline that only works on
 * the sample it was developed against has not validated anything.
 */
type Row = Record<string, string>;
const source = parseCsvObjects(readFileSync(DEFAULT_RAW_CSV, 'utf8'));
const columns = Object.keys(source[0]!);
const dirs: string[] = [];
const contexts: TestContext[] = [];
after(() => {
  for (const ctx of contexts) ctx.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The first `reports` reports for the first `periods` periods of the real file. */
function slice(reports: number, periods: number): Row[] {
  return source
    .filter((_row, index) => index % 100 < reports && Math.floor(index / 100) < periods)
    .map((row) => ({ ...row }));
}

async function build(rows: Row[]): Promise<WarehouseSnapshot> {
  const dir = mkdtempSync(join(tmpdir(), 'picc-variant-'));
  dirs.push(dir);
  const csv = join(dir, 'variant.csv');
  writeFileSync(
    csv,
    `${[csvLine(columns), ...rows.map((row) => csvLine(columns.map((c) => row[c] ?? '')))].join('\n')}\n`,
  );
  return buildWarehouseSnapshot({
    sqlDir: SQL_DIR,
    rawCsv: csv,
    generatedDir: join(dir, 'generated'),
    cache: false,
  });
}

/** Every read endpoint must answer 200 with a body that matches its schema. */
async function exerciseApi(snapshot: WarehouseSnapshot): Promise<TestContext> {
  const ctx = await createTestContext({}, {}, snapshot);
  contexts.push(ctx);
  const admin = await ctx.login(ADMIN);
  const reportId = snapshot.dim[0]!.report_id;
  for (const path of [
    '/overview',
    '/reports?pageSize=500',
    `/reports/${reportId}`,
    '/orphans',
    '/alerts?status=all&pageSize=500',
    '/alerts/stats',
    '/costs/summary',
    '/costs/reports',
    '/costs/reports?period=lifetime',
    '/costs/chargeback',
    '/costs/anomalies',
    '/dq/summary',
    '/dq/findings?pageSize=500',
    '/dq/quarantine',
    '/system/status',
  ]) {
    const res = await ctx.get(path, admin);
    assert.equal(
      res.status,
      200,
      `${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`,
    );
  }
  return ctx;
}

const ruleRows = (snapshot: WarehouseSnapshot, ruleId: string): number =>
  snapshot.dqRules.find((r) => r.rule_id === ruleId)!.rows_affected;

describe('a dirtier file than the one provided', () => {
  let snapshot: WarehouseSnapshot;
  const rows = slice(30, 3);
  rows[0]!.owner_email = '';
  rows[1]!.owner_email = '  ORPHANED_REPORT ';
  rows[2]!.owner_email = 'NaN';
  rows[3]!.owner_email = ' User_3@Company.COM ';
  rows[4]!.last_refresh_status = 'failed';
  rows[5]!.last_refresh_status = '';
  rows[6]!.snowflake_credits_consumed = 'abc';
  rows[7]!.snowflake_credits_consumed = '';
  rows[8]!.avg_load_time_sec = '';
  rows[9]!.monthly_active_views = '';
  rows[10]!.query_count_last_30d = '';
  rows[11]!.concurrent_user_peak = 'n/a';
  rows[12]!.aws_hosting_cost_usd = '';
  rows[13]!.owner_email = 'not-an-email';

  it('builds, and every reconciliation check that guards the arithmetic still passes', async () => {
    snapshot = await build(rows);
    assert.deepEqual(
      snapshot.reconciliation.filter((c) => c.status === 'FAIL').map((c) => c.check_id),
      [],
    );
    assert.equal(snapshot.facts.length, 90, 'no row was dropped');
  });

  it('recognises every spelling of "no owner" and normalises a messy address', () => {
    const fact = (i: number) => snapshot.facts.find((f) => f.row_seq === i + 1)!;
    for (const i of [0, 1, 2]) assert.equal(fact(i).is_orphaned, true, `row ${i}`);
    assert.equal(fact(3).owner_email, 'user_3@company.com');
    assert.equal(fact(13).is_orphaned, false);
    assert.ok(ruleRows(snapshot, 'DQ-12') >= 1, 'a present but malformed address is flagged');
  });

  it('normalises status case and treats a blank status as unknown', () => {
    const fact = (i: number) => snapshot.facts.find((f) => f.row_seq === i + 1)!;
    assert.equal(fact(4).refresh_status, 'FAILED');
    assert.equal(fact(5).refresh_status, 'UNKNOWN');
  });

  it('quarantines credits that are not numbers or are missing, and still costs those rows', () => {
    const fact = (i: number) => snapshot.facts.find((f) => f.row_seq === i + 1)!;
    assert.ok(ruleRows(snapshot, 'DQ-10') >= 2, 'the two unparseable numbers are reported');
    for (const i of [6, 7]) {
      assert.equal(fact(i).is_cost_quarantined, true, `row ${i}`);
      assert.equal(fact(i).credits_attributed, null);
      assert.ok(fact(i).credits_fully_loaded! > 0, `row ${i} has an estimated cost`);
    }
  });

  it('never produces a NULL where the application expects a yes or no', () => {
    const flags = [
      'is_orphaned',
      'is_refresh_failure',
      'is_refresh_unknown',
      'is_latency_breach',
      'is_zero_views',
      'is_concurrency_gt_views',
      'is_cost_quarantined',
      'is_cost_imputed',
    ] as const;
    for (const fact of snapshot.facts) {
      for (const flag of flags)
        assert.equal(
          typeof fact[flag],
          'boolean',
          `${flag} on row ${fact.row_seq} is ${fact[flag]}`,
        );
    }
  });

  it('serves every page of the application from it', async () => {
    await exerciseApi(snapshot);
  });
});

describe('a file with a different shape', () => {
  it('one period only: 120 distinct reports, each seen once', async () => {
    const rows = source.slice(0, 100).map((row) => ({ ...row }));
    for (let i = 0; i < 20; i++)
      rows.push({ ...source[i]!, report_id: `RPT_${900 + i}`, report_name: `Extra ${i}` });
    const snapshot = await build(rows);
    assert.equal(snapshot.dim.length, 120);
    assert.equal(snapshot.periodSummary.length, 1);
    assert.deepEqual(
      snapshot.reconciliation.filter((c) => c.status === 'FAIL'),
      [],
    );
    const ctx = await exerciseApi(snapshot);
    const overview = (await ctx.get('/overview', await ctx.login(ADMIN))).body;
    assert.equal(overview.reports.total, 120);
    assert.equal(overview.trend.length, 1);
  });

  it('a single report in a single period', async () => {
    const snapshot = await build(slice(1, 1));
    assert.equal(snapshot.dim.length, 1);
    await exerciseApi(snapshot);
  });

  it('an incomplete panel: one report is missing its last period', async () => {
    const rows = slice(30, 3);
    const dropped = rows.pop()!;
    const snapshot = await build(rows);
    assert.equal(snapshot.facts.length, 89);
    const panel = snapshot.reconciliation.find((c) => c.check_id === 'R03')!;
    assert.equal(panel.status, 'WARN', 'reported, but not a reason to refuse to start');
    assert.deepEqual(
      snapshot.reconciliation.filter((c) => c.status === 'FAIL'),
      [],
    );
    const ctx = await exerciseApi(snapshot);
    const detail = (await ctx.get(`/reports/${dropped.report_id}`, await ctx.login(ADMIN))).body;
    assert.equal(detail.history.length, 2);
  });
});
