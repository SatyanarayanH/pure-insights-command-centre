import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_RAW_CSV } from '../src/paths.js';
import { parseCsv, parseCsvObjects } from '../src/warehouse/csv.js';
import { createRng } from '../src/warehouse/prng.js';
import {
  DEFAULT_SIMULATION_PARAMS,
  readReportPeriods,
  simulateAccountUsage,
  simulatedQueryRows,
} from '../src/warehouse/simulator.js';
import { splitStatements } from '../src/warehouse/sql-runner.js';
import { getSnapshot } from './helpers.js';

const rawCsv = readFileSync(DEFAULT_RAW_CSV, 'utf8');

describe('csv', () => {
  it('reads quoted fields, escaped quotes and embedded commas', () => {
    assert.deepEqual(parseCsv('a,b\n"x,1","say ""hi"""\n'), [
      ['a', 'b'],
      ['x,1', 'say "hi"'],
    ]);
  });

  it('reads the dataset as 2,000 rows with the ten documented columns', () => {
    const rows = parseCsvObjects(rawCsv);
    assert.equal(rows.length, 2000);
    assert.deepEqual(Object.keys(rows[0]!), [
      'report_id',
      'report_name',
      'owner_email',
      'last_refresh_status',
      'monthly_active_views',
      'snowflake_credits_consumed',
      'avg_load_time_sec',
      'aws_hosting_cost_usd',
      'query_count_last_30d',
      'concurrent_user_peak',
    ]);
  });
});

describe('prng', () => {
  it('is deterministic per key and differs across keys', () => {
    const a = createRng('k');
    const b = createRng('k');
    const c = createRng('other');
    const seq = (r: ReturnType<typeof createRng>) => Array.from({ length: 5 }, () => r.next());
    const first = seq(a);
    assert.deepEqual(first, seq(b));
    assert.notDeepEqual(first, seq(c));
  });
});

describe('splitStatements', () => {
  it('ignores semicolons in strings, quoted identifiers and comments', () => {
    const statements = splitStatements(`
      -- a comment; with a semicolon
      SELECT 'a;b' AS x, "we;ird" FROM t; /* block; comment */
      INSERT INTO t VALUES ('it''s; fine');
    `);
    assert.equal(statements.length, 2);
    assert.match(statements[0]!, /SELECT 'a;b'/);
    assert.match(statements[1]!, /it''s; fine/);
  });

  it('drops comment-only fragments', () => {
    assert.deepEqual(splitStatements('-- nothing here\n;\n/* nor here */'), []);
  });
});

describe('ACCOUNT_USAGE simulator', () => {
  const simulation = simulateAccountUsage(rawCsv, DEFAULT_SIMULATION_PARAMS);

  it('finds the panel structure: 100 reports x 20 periods', () => {
    const inputs = readReportPeriods(rawCsv);
    assert.equal(new Set(inputs.map((r) => r.reportId)).size, 100);
    assert.equal(simulation.manifest.periods, 20);
    assert.ok(inputs.every((r) => r.periodSeq >= 0 && r.periodSeq < 20));
  });

  it('is deterministic: the same input and parameters give byte-identical files', () => {
    const again = simulateAccountUsage(rawCsv, DEFAULT_SIMULATION_PARAMS);
    assert.deepEqual(again.manifest, simulation.manifest);
    assert.equal(
      again.files['query_attribution_history.csv'],
      simulation.files['query_attribution_history.csv'],
    );
    assert.equal(
      again.files['warehouse_metering_history.csv'],
      simulation.files['warehouse_metering_history.csv'],
    );
  });

  it('is a pure disaggregation: query credits sum back to the dataset for every report-period', () => {
    const rows = parseCsvObjects(simulation.files['query_attribution_history.csv']);
    const calendar = parseCsvObjects(simulation.files['period_calendar.csv']).map((p) => ({
      seq: Number(p.PERIOD_SEQ),
      start: p.PERIOD_START!,
      end: p.PERIOD_END!,
    }));
    const totals = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const tag = row.QUERY_TAG;
      if (!tag?.startsWith('{')) continue;
      const parsed = JSON.parse(tag) as { app?: string; report_id?: string };
      if (parsed.app !== 'pure-insights' || parsed.report_id === 'RPT_999') continue;
      const period = calendar.find((p) => row.START_TIME! >= p.start && row.START_TIME! < p.end)!;
      const key = `${parsed.report_id}:${period.seq}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(row.CREDITS_ATTRIBUTED_COMPUTE));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const input of readReportPeriods(rawCsv)) {
      const key = `${input.reportId}:${input.periodSeq}`;
      assert.ok(
        Math.abs(totals.get(key)! - input.credits) < 1e-6,
        `${key}: ${totals.get(key)} vs ${input.credits}`,
      );
      assert.equal(
        counts.get(key),
        simulatedQueryRows(input.queryCount, DEFAULT_SIMULATION_PARAMS.queriesPerRow),
      );
    }
  });

  it('never meters less than the queries used, and keeps negative values out of the meter', () => {
    const hours = parseCsvObjects(simulation.files['warehouse_metering_history.csv']);
    assert.ok(hours.length > 20000);
    for (const hour of hours) {
      assert.ok(
        Number(hour.CREDITS_USED_COMPUTE) >= Number(hour.CREDITS_ATTRIBUTED_COMPUTE_QUERIES),
      );
      assert.ok(Number(hour.CREDITS_ATTRIBUTED_COMPUTE_QUERIES) >= 0);
    }
    assert.equal(simulation.manifest.totals.creditsReportedNegative, -161.04);
  });
});

describe('SQL suite on DuckDB', () => {
  it('passes every reconciliation check', async () => {
    const snapshot = await getSnapshot();
    assert.equal(snapshot.reconciliation.length, 16);
    for (const check of snapshot.reconciliation) {
      assert.equal(check.status, 'PASS', `${check.check_id} ${check.description}`);
    }
  });

  it('reports the defect counts found by profiling the dataset', async () => {
    const snapshot = await getSnapshot();
    const rows = Object.fromEntries(snapshot.dqRules.map((r) => [r.rule_id, r.rows_affected]));
    assert.deepEqual(rows, {
      'DQ-01': 245, // orphaned owners: 128 'nan' + 117 'ORPHANED_REPORT'
      'DQ-02': 24, // negative credits
      'DQ-03': 1490, // latency over 15 s
      'DQ-04': 27, // hosting cost per view outliers
      'DQ-05': 100, // UNKNOWN refresh status
      'DQ-06': 1900, // repeats of a report id
      'DQ-07': 1371, // named owner changed since the previous period
      'DQ-08': 4, // zero views with cost
      'DQ-09': 93, // peak concurrency above monthly views
      'DQ-10': 0,
      'DQ-11': 564, // FAILED 382 + TIMED_OUT 182
      'DQ-12': 0,
    });
  });

  it('keeps every landed row and quarantines without deleting', async () => {
    const snapshot = await getSnapshot();
    assert.equal(snapshot.facts.length, 2000);
    assert.equal(snapshot.dim.length, 100);
    assert.equal(snapshot.quarantine.length, 24);
    const quarantined = snapshot.facts.filter((f) => f.is_cost_quarantined);
    assert.equal(quarantined.length, 24);
    for (const fact of quarantined) {
      assert.equal(fact.credits_attributed, null, 'no attributed credits for a quarantined row');
      assert.equal(fact.is_cost_imputed, true);
      assert.ok(fact.credits_fully_loaded! > 0, 'cost is imputed from execution time');
    }
  });

  it('never divides by zero views', async () => {
    const snapshot = await getSnapshot();
    const zeroViews = snapshot.facts.filter((f) => f.monthly_active_views === 0);
    assert.equal(zeroViews.length, 4);
    for (const fact of zeroViews) {
      assert.equal(fact.total_cost_per_view_usd, null);
      assert.equal(fact.snowflake_cost_per_view_usd, null);
      assert.ok(fact.total_cost_usd! > 0);
    }
  });

  it('agrees across attribution methods', async () => {
    const { methods } = await getSnapshot();
    assert.ok(
      methods.credits_idle_loaded > methods.credits_direct,
      'loading idle time adds credits',
    );
    assert.ok(methods.correlation! > 0.99, 'methods B and C rank reports the same way');
    assert.ok(methods.median_abs_difference_pct! < 0.05);
  });

  it('classifies credits that belong to no catalogued report instead of dropping them', async () => {
    const { unattributed } = await getSnapshot();
    assert.deepEqual(
      new Set(unattributed.map((u) => u.attribution_class)),
      new Set(['OTHER_WORKLOAD', 'UNTAGGED', 'UNPARSEABLE_TAG', 'UNKNOWN_REPORT']),
    );
  });

  it('finds 14 reports orphaned in the latest period and suggests an owner for each', async () => {
    const { orphanQueue } = await getSnapshot();
    assert.equal(orphanQueue.length, 14);
    assert.ok(orphanQueue.every((o) => o.suggested_owner !== null));
    const risks = orphanQueue.map((o) => o.cost_at_risk_usd!);
    assert.deepEqual(
      risks,
      [...risks].sort((a, b) => b - a),
      'ranked by cost at risk',
    );
  });
});
