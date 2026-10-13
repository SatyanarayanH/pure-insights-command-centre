import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EfficiencyQuadrant, LatencySeverity, RefreshStatus } from '@picc/contracts';
import { ensureSimulation } from './build.js';
import { DuckDbWarehouse } from './duckdb.js';
import { LOADER_FILES, type ReconciliationRow, runSqlSuite, SUITE_FILES } from './sql-runner.js';
import type { Warehouse } from './warehouse.js';

export interface FactRow {
  report_id: string;
  report_name: string;
  period_seq: number;
  period_start: string;
  period_end: string;
  row_seq: number;
  owner_email: string | null;
  is_orphaned: boolean;
  orphan_encoding: string | null;
  refresh_status: RefreshStatus;
  is_refresh_failure: boolean;
  is_refresh_unknown: boolean;
  avg_load_time_sec: number | null;
  is_latency_breach: boolean;
  latency_severity: LatencySeverity;
  monthly_active_views: number | null;
  query_count_last_30d: number | null;
  concurrent_user_peak: number | null;
  is_zero_views: boolean;
  is_concurrency_gt_views: boolean;
  credits_reported: number | null;
  is_cost_quarantined: boolean;
  credits_attributed: number | null;
  credits_idle_loaded: number | null;
  credits_time_weighted: number | null;
  credits_fully_loaded: number | null;
  is_cost_imputed: boolean;
  snowflake_cost_usd: number | null;
  snowflake_cost_loaded_usd: number | null;
  aws_hosting_cost_usd: number | null;
  total_cost_usd: number | null;
  credits_per_view: number | null;
  snowflake_cost_per_view_usd: number | null;
  aws_cost_per_view_usd: number | null;
  total_cost_per_view_usd: number | null;
  snowflake_cost_per_query_usd: number | null;
}

/** Cost columns shared by the per-period fact and the current-state dimension. */
export type CostColumns = Pick<
  FactRow,
  | 'credits_attributed'
  | 'credits_fully_loaded'
  | 'snowflake_cost_usd'
  | 'snowflake_cost_loaded_usd'
  | 'aws_hosting_cost_usd'
  | 'total_cost_usd'
  | 'snowflake_cost_per_view_usd'
  | 'total_cost_per_view_usd'
  | 'is_cost_imputed'
  | 'is_cost_quarantined'
>;

export interface DimRow extends CostColumns {
  report_id: string;
  report_name: string;
  latest_period_seq: number;
  latest_period_start: string;
  latest_period_end: string;
  owner_email: string | null;
  is_orphaned: boolean;
  orphan_encoding: string | null;
  last_known_owner: string | null;
  last_known_owner_period: number | null;
  most_frequent_owner: string | null;
  distinct_owners: number;
  ownership_changes: number;
  periods_orphaned: number;
  refresh_status: RefreshStatus;
  refresh_failure_streak: number;
  refresh_failures_total: number;
  avg_load_time_sec: number | null;
  latency_severity: LatencySeverity;
  latency_breaches_total: number;
  median_load_time_sec: number | null;
  monthly_active_views: number | null;
  query_count_last_30d: number | null;
  concurrent_user_peak: number | null;
  lifetime_views: number | null;
  lifetime_credits_attributed: number | null;
  lifetime_credits_fully_loaded: number | null;
  lifetime_total_cost_usd: number | null;
  lifetime_cost_per_view_usd: number | null;
  periods_cost_quarantined: number;
}

export interface EfficiencyRow {
  report_id: string;
  run_rate_views: number | null;
  run_rate_total_cost_usd: number | null;
  run_rate_cost_per_view_usd: number | null;
  efficiency_quadrant: EfficiencyQuadrant;
}

export interface OwnershipHistoryRow {
  report_id: string;
  period_seq: number;
  owner_email: string | null;
  change_type: string;
}

export interface PeriodSummaryRow {
  period_seq: number;
  period_start: string;
  period_end: string;
  credits_metered_compute: number;
  credits_cloud_services: number;
  credits_idle: number;
  credits_unattributed: number;
}

export interface OrphanQueueRow {
  priority_rank: number;
  report_id: string;
  report_name: string;
  orphan_encoding: string | null;
  periods_since_owned: number | null;
  suggested_owner: string | null;
  suggestion_basis: string | null;
  most_frequent_owner: string | null;
  cost_at_risk_usd: number | null;
  lifetime_cost_while_orphaned_usd: number | null;
}

export interface ChargebackOwnerRow {
  owner_key: string;
  is_unowned: boolean;
  report_periods: number;
  views: number;
  credits_fully_loaded: number;
  snowflake_cost_loaded_usd: number;
  aws_hosting_cost_usd: number;
  total_cost_usd: number;
  total_cost_per_view_usd: number | null;
  share_of_total_cost: number;
}

export interface AnomalyRow {
  anomaly_type: string;
  report_id: string;
  period_seq: number | null;
  metric_value: number | null;
  metric_unit: string;
  est_monthly_impact_usd: number | null;
  detail: string;
}

export interface DqRuleRow {
  rule_id: string;
  rule_name: string;
  category: string;
  severity: string;
  action: 'NORMALIZE' | 'QUARANTINE' | 'FLAG' | 'RESTRUCTURE';
  in_brief: boolean;
  description: string;
  rows_affected: number;
  reports_affected: number;
  pct_of_rows: number;
}

export interface DqFindingRow {
  rule_id: string;
  row_seq: number;
  report_id: string;
  period_seq: number;
  observed_value: string | null;
  detail: string | null;
}

export interface QuarantineRow {
  row_seq: number;
  report_id: string;
  period_seq: number;
  rule_id: string;
  reason_code: string;
  raw_value: string | null;
  credits_raw: number | null;
}

export interface CostParams {
  credit_price_usd: number;
  latency_warning_sec: number;
  latency_high_sec: number;
  latency_critical_sec: number;
  run_rate_periods: number;
}

/** Everything the application needs from the warehouse, read once after the suite has run. */
export interface WarehouseSnapshot {
  dialect: string;
  builtAt: string;
  suiteDurationMs: number;
  fromCache: boolean;
  queryRowsSimulated: number;
  queriesPerRow: number;
  params: CostParams;
  dim: DimRow[];
  facts: FactRow[];
  efficiency: EfficiencyRow[];
  ownershipHistory: OwnershipHistoryRow[];
  periodSummary: PeriodSummaryRow[];
  unattributed: { attribution_class: string; tag_app: string; tag_report_id: string; query_rows: number; credits: number }[];
  methods: {
    credits_direct: number;
    credits_idle_loaded: number;
    credits_time_weighted: number;
    median_abs_difference_pct: number | null;
    correlation: number | null;
  };
  correlations: { usage_measure: string; cost_measure: string; pearson_r: number | null; observations: number }[];
  orphanQueue: OrphanQueueRow[];
  chargebackOwners: ChargebackOwnerRow[];
  chargebackLatest: { owner_key: string; total_cost_usd: number }[];
  anomalies: AnomalyRow[];
  dqRules: DqRuleRow[];
  dqFindings: DqFindingRow[];
  quarantine: QuarantineRow[];
  reconciliation: ReconciliationRow[];
}

async function readSnapshot(
  warehouse: Warehouse,
  meta: Pick<WarehouseSnapshot, 'builtAt' | 'suiteDurationMs' | 'fromCache' | 'queryRowsSimulated' | 'queriesPerRow'>,
): Promise<WarehouseSnapshot> {
  const q = <T>(sql: string) => warehouse.query(sql) as Promise<T[]>;
  const [params] = await q<CostParams>('SELECT * FROM CONFIG.COST_PARAMS');
  const [methods] = await q<WarehouseSnapshot['methods']>(`
    SELECT SUM(credits_direct) AS credits_direct,
           SUM(credits_idle_loaded) AS credits_idle_loaded,
           SUM(credits_time_weighted) AS credits_time_weighted,
           MEDIAN(ABS(time_weighted_vs_idle_loaded_pct)) AS median_abs_difference_pct,
           CORR(credits_idle_loaded, credits_time_weighted) AS correlation
    FROM MART.ATTRIBUTION_COMPARISON`);

  return {
    dialect: warehouse.dialect,
    ...meta,
    params: params!,
    methods: methods!,
    dim: await q<DimRow>('SELECT * FROM MART.DIM_REPORT ORDER BY report_id'),
    facts: await q<FactRow>('SELECT * FROM MART.FCT_REPORT_PERIOD ORDER BY report_id, period_seq'),
    efficiency: await q<EfficiencyRow>('SELECT * FROM MART.REPORT_EFFICIENCY'),
    ownershipHistory: await q<OwnershipHistoryRow>(
      'SELECT report_id, period_seq, owner_email, change_type FROM MART.OWNERSHIP_HISTORY ORDER BY report_id, period_seq',
    ),
    periodSummary: await q<PeriodSummaryRow>(
      'SELECT period_seq, period_start, period_end, credits_metered_compute, credits_cloud_services, credits_idle, credits_unattributed FROM MART.PERIOD_SUMMARY ORDER BY period_seq',
    ),
    unattributed: await q(`
      SELECT attribution_class, tag_app, tag_report_id, SUM(query_rows) AS query_rows, SUM(credits) AS credits
      FROM MART.CREDITS_UNATTRIBUTED
      GROUP BY attribution_class, tag_app, tag_report_id
      ORDER BY credits DESC`),
    correlations: await q('SELECT usage_measure, cost_measure, pearson_r, observations FROM MART.USAGE_COST_CORRELATION'),
    orphanQueue: await q<OrphanQueueRow>('SELECT * FROM MART.ORPHAN_QUEUE ORDER BY priority_rank'),
    chargebackOwners: await q<ChargebackOwnerRow>('SELECT * FROM MART.CHARGEBACK_OWNER ORDER BY total_cost_usd DESC'),
    chargebackLatest: await q(`
      SELECT owner_key, total_cost_usd
      FROM MART.CHARGEBACK_OWNER_PERIOD
      WHERE period_seq = (SELECT MAX(period_seq) FROM MART.CHARGEBACK_OWNER_PERIOD)`),
    anomalies: await q<AnomalyRow>('SELECT * FROM MART.COST_ANOMALIES ORDER BY est_monthly_impact_usd DESC'),
    dqRules: await q<DqRuleRow>('SELECT * FROM DQ.RULE_SUMMARY ORDER BY rule_id'),
    dqFindings: await q<DqFindingRow>('SELECT * FROM DQ.FINDINGS ORDER BY rule_id, row_seq'),
    quarantine: await q<QuarantineRow>('SELECT * FROM DQ.QUARANTINE ORDER BY row_seq'),
    reconciliation: await q<ReconciliationRow>('SELECT * FROM DQ.RECONCILIATION ORDER BY check_id'),
  };
}

export interface BuildWarehouseOptions {
  sqlDir: string;
  rawCsv: string;
  generatedDir: string;
  /** Persist the built warehouse so later starts skip the suite. Off for tests. */
  cache?: boolean;
}

/**
 * Builds the warehouse (simulate -> run the SQL suite -> reconcile) and returns a snapshot.
 *
 * The built DuckDB file is cached, keyed by a fingerprint of the input data, the simulation
 * manifest and every SQL file. Change any of them and the next start rebuilds from scratch.
 */
export async function buildWarehouseSnapshot(options: BuildWarehouseOptions): Promise<WarehouseSnapshot> {
  const { manifest } = ensureSimulation(options.rawCsv, options.generatedDir);
  const hash = createHash('sha256').update(JSON.stringify(manifest));
  for (const file of [...SUITE_FILES, LOADER_FILES.duckdb]) {
    hash.update(readFileSync(join(options.sqlDir, file)));
  }
  const fingerprint = hash.digest('hex');
  const sim = { queryRowsSimulated: manifest.rows.queryHistory, queriesPerRow: manifest.params.queriesPerRow };

  const cachePath = join(options.generatedDir, 'warehouse.duckdb');
  if (options.cache && existsSync(cachePath)) {
    const cached = await DuckDbWarehouse.open(cachePath);
    try {
      const [build] = await cached
        .query<{ fingerprint: string; built_at: string; suite_duration_ms: number }>('SELECT * FROM CONFIG.BUILD')
        .catch(() => []);
      if (build?.fingerprint === fingerprint) {
        return await readSnapshot(cached, {
          builtAt: build.built_at,
          suiteDurationMs: build.suite_duration_ms,
          fromCache: true,
          ...sim,
        });
      }
    } finally {
      await cached.close();
    }
    rmSync(cachePath, { force: true });
    rmSync(`${cachePath}.wal`, { force: true });
  }

  if (options.cache) mkdirSync(dirname(cachePath), { recursive: true });
  const warehouse = await DuckDbWarehouse.open(options.cache ? cachePath : ':memory:');
  try {
    const result = await runSqlSuite(warehouse, {
      sqlDir: options.sqlDir,
      rawCsv: options.rawCsv,
      dataDir: options.generatedDir,
    });
    const builtAt = new Date().toISOString();
    await warehouse.exec(
      'CREATE OR REPLACE TABLE CONFIG.BUILD (fingerprint VARCHAR, built_at VARCHAR, suite_duration_ms INTEGER)',
    );
    await warehouse.query('INSERT INTO CONFIG.BUILD VALUES (?, ?, ?)', [fingerprint, builtAt, result.durationMs]);
    return await readSnapshot(warehouse, {
      builtAt,
      suiteDurationMs: result.durationMs,
      fromCache: false,
      ...sim,
    });
  } finally {
    await warehouse.close();
  }
}

export const periodLabel = (periodSeq: number): string => `P${String(periodSeq + 1).padStart(2, '0')}`;
