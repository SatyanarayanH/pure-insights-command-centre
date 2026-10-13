/**
 * Runs the cost allocation SQL suite on a real Snowflake account and compares every mart
 * with the DuckDB run of the same files.
 *
 *   npm run sql:snowflake
 *
 * Credentials come from the environment (or a .env file in the repository root, which is
 * git-ignored). Nothing is written to the repository except docs/evidence/snowflake-run.md.
 *
 * This file is also the reference implementation of the `Warehouse` interface for Snowflake:
 * the application talks to DuckDB through the same four methods.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_GENERATED_DIR,
  DEFAULT_RAW_CSV,
  DOCS_DIR,
  REPO_ROOT,
  SQL_DIR,
} from '../../apps/api/src/paths.js';
import { ensureSimulation } from '../../apps/api/src/warehouse/build.js';
import { DuckDbWarehouse } from '../../apps/api/src/warehouse/duckdb.js';
import { runSqlSuite, type SuiteResult } from '../../apps/api/src/warehouse/sql-runner.js';
import { normaliseRow, type Row, type Warehouse } from '../../apps/api/src/warehouse/warehouse.js';

interface SnowflakeConnection {
  connect(callback: (error: Error | undefined) => void): void;
  execute(options: {
    sqlText: string;
    binds?: unknown[];
    complete: (error: Error | undefined, statement: unknown, rows: Row[] | undefined) => void;
  }): void;
  destroy(callback: (error: Error | undefined) => void): void;
}

class SnowflakeWarehouse implements Warehouse {
  readonly dialect = 'snowflake' as const;

  constructor(private readonly connection: SnowflakeConnection) {}

  query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.connection.execute({
        sqlText: sql,
        binds: [...params],
        complete: (error, _statement, rows) =>
          error ? reject(error) : resolve((rows ?? []).map(normaliseRow) as T[]),
      });
    });
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.connection.destroy(() => resolve()));
  }
}

function loadDotEnv(): void {
  const path = join(REPO_ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#') && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing ${name}. Set it in the environment or in .env (see .env.example and sql/README.md).`,
    );
    process.exit(2);
  }
  return value;
}

async function connect(): Promise<SnowflakeWarehouse> {
  const { default: snowflake } = (await import('snowflake-sdk')) as unknown as {
    default: {
      createConnection(options: Record<string, unknown>): SnowflakeConnection;
      configure(options: Record<string, unknown>): void;
    };
  };
  snowflake.configure({ logLevel: 'ERROR' });

  const auth: Record<string, unknown> = process.env.SNOWFLAKE_PRIVATE_KEY_PATH
    ? {
        authenticator: 'SNOWFLAKE_JWT',
        privateKeyPath: process.env.SNOWFLAKE_PRIVATE_KEY_PATH,
        privateKeyPass: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
      }
    : process.env.SNOWFLAKE_TOKEN
      ? { authenticator: 'PROGRAMMATIC_ACCESS_TOKEN', token: process.env.SNOWFLAKE_TOKEN }
      : { password: requireEnv('SNOWFLAKE_PASSWORD') };

  const connection = snowflake.createConnection({
    account: requireEnv('SNOWFLAKE_ACCOUNT'),
    username: requireEnv('SNOWFLAKE_USER'),
    ...auth,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE ?? 'COMPUTE_WH',
    role: process.env.SNOWFLAKE_ROLE || undefined,
    application: 'PureInsightsCommandCentre',
  });
  await new Promise<void>((resolve, reject) =>
    connection.connect((error) => (error ? reject(error) : resolve())),
  );
  return new SnowflakeWarehouse(connection);
}

/** The queries whose results must match between engines, each ordered deterministically. */
const COMPARISONS: { name: string; sql: string; key: string[] }[] = [
  {
    name: 'DQ.RULE_SUMMARY',
    key: ['rule_id'],
    sql: 'SELECT rule_id, rows_affected, reports_affected FROM DQ.RULE_SUMMARY',
  },
  {
    name: 'DQ.RECONCILIATION',
    key: ['check_id'],
    sql: 'SELECT check_id, status, expected_value, actual_value FROM DQ.RECONCILIATION',
  },
  {
    name: 'MART.FCT_REPORT_PERIOD',
    key: ['report_id', 'period_seq'],
    sql: `SELECT report_id, period_seq, owner_email, refresh_status, latency_severity, is_cost_quarantined,
                 credits_attributed, credits_idle_loaded, credits_time_weighted, credits_fully_loaded,
                 total_cost_usd, total_cost_per_view_usd
          FROM MART.FCT_REPORT_PERIOD`,
  },
  {
    name: 'MART.PERIOD_SUMMARY',
    key: ['period_seq'],
    sql: `SELECT period_seq, reports_orphaned, refresh_failed, latency_breaches, credits_attributed_reports,
                 credits_metered_compute, credits_idle, credits_unattributed, total_cost_usd
          FROM MART.PERIOD_SUMMARY`,
  },
  {
    name: 'MART.CHARGEBACK_OWNER',
    key: ['owner_key'],
    sql: 'SELECT owner_key, report_periods, total_cost_usd, share_of_total_cost FROM MART.CHARGEBACK_OWNER',
  },
  {
    name: 'MART.ORPHAN_QUEUE',
    key: ['report_id'],
    sql: 'SELECT report_id, priority_rank, suggested_owner, cost_at_risk_usd FROM MART.ORPHAN_QUEUE',
  },
  {
    name: 'MART.REPORT_EFFICIENCY',
    key: ['report_id'],
    sql: 'SELECT report_id, efficiency_quadrant, run_rate_total_cost_usd FROM MART.REPORT_EFFICIENCY',
  },
  {
    name: 'MART.COST_ANOMALIES',
    key: ['anomaly_type'],
    sql: 'SELECT anomaly_type, COUNT(*) AS anomalies, SUM(est_monthly_impact_usd) AS impact FROM MART.COST_ANOMALIES GROUP BY anomaly_type',
  },
];

const RELATIVE_TOLERANCE = 1e-6;

function compare(
  name: string,
  key: string[],
  left: Row[],
  right: Row[],
): { name: string; rows: number; mismatches: string[] } {
  const keyOf = (row: Row) => key.map((k) => String(row[k])).join('|');
  const rightByKey = new Map(right.map((row) => [keyOf(row), row]));
  const mismatches: string[] = [];
  if (left.length !== right.length)
    mismatches.push(`row count ${left.length} (DuckDB) vs ${right.length} (Snowflake)`);
  for (const row of left) {
    const other = rightByKey.get(keyOf(row));
    if (!other) {
      mismatches.push(`${keyOf(row)}: missing on Snowflake`);
      continue;
    }
    for (const [column, value] of Object.entries(row)) {
      const theirs = other[column];
      const same =
        typeof value === 'number' && typeof theirs === 'number'
          ? Math.abs(value - theirs) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(value))
          : // Engines differ on true/false vs 1/0 and null vs undefined; compare by text.
            String(value ?? '') === String(theirs ?? '');
      if (!same)
        mismatches.push(
          `${keyOf(row)}.${column}: ${String(value)} (DuckDB) vs ${String(theirs)} (Snowflake)`,
        );
    }
  }
  return { name, rows: left.length, mismatches };
}

loadDotEnv();
const rawCsv = process.env.RAW_CSV ?? DEFAULT_RAW_CSV;
const dataDir = process.env.GENERATED_DIR ?? DEFAULT_GENERATED_DIR;
const database = (process.env.SNOWFLAKE_DATABASE ?? 'PURE_INSIGHTS_SIM').toUpperCase();
if (!/^[A-Z][A-Z0-9_]*$/.test(database)) {
  console.error('SNOWFLAKE_DATABASE must be a plain identifier.');
  process.exit(2);
}
ensureSimulation(rawCsv, dataDir);

console.log('Running the suite on DuckDB (reference)...');
const duck = await DuckDbWarehouse.open();
const duckResult = await runSqlSuite(duck, { sqlDir: SQL_DIR, rawCsv, dataDir });

console.log('Connecting to Snowflake...');
const snow = await connect();
let snowResult: SuiteResult;
const comparisons: ReturnType<typeof compare>[] = [];
let context: Row = {};
try {
  await snow.exec(`CREATE DATABASE IF NOT EXISTS ${database}`);
  await snow.exec(`USE DATABASE ${database}`);
  [context = {}] = await snow.query(
    'SELECT CURRENT_VERSION() AS version, CURRENT_REGION() AS region, CURRENT_WAREHOUSE() AS warehouse, CURRENT_DATABASE() AS database_name',
  );
  console.log(
    `Running the suite on Snowflake ${String(context.version)} (${String(context.region)}), database ${database}...`,
  );
  snowResult = await runSqlSuite(snow, { sqlDir: SQL_DIR, rawCsv, dataDir });

  for (const { name, sql, key } of COMPARISONS) {
    comparisons.push(compare(name, key, await duck.query(sql), await snow.query(sql)));
  }
} finally {
  await snow.close();
  await duck.close();
}

const failed = comparisons.filter((c) => c.mismatches.length > 0);
const table = (header: string[], rows: (string | number)[][]) =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const report = [
  '# Snowflake validation run',
  '',
  `Run at ${new Date().toISOString()} against Snowflake ${String(context.version)} in ${String(context.region)}, warehouse ${String(context.warehouse)}, database ${String(context.database_name)}.`,
  '',
  'The same SQL files were executed on DuckDB and on Snowflake, from the same generated input files, and every mart was compared row by row.',
  '',
  '## Suite execution on Snowflake',
  '',
  table(
    ['File', 'Statements', 'Duration (ms)'],
    snowResult.files.map((f) => [f.file, f.statements, f.durationMs]),
  ),
  '',
  `Total: ${snowResult.durationMs} ms on Snowflake, ${duckResult.durationMs} ms on DuckDB.`,
  '',
  '## Reconciliation checks on Snowflake',
  '',
  table(
    ['Check', 'What is verified', 'Expected', 'Actual', 'Status'],
    snowResult.reconciliation.map((r) => [
      r.check_id,
      r.description,
      String(r.expected_value),
      String(r.actual_value),
      r.status,
    ]),
  ),
  '',
  '## DuckDB versus Snowflake',
  '',
  `Numeric columns compared with relative tolerance ${RELATIVE_TOLERANCE}.`,
  '',
  table(
    ['Table', 'Rows compared', 'Result'],
    comparisons.map((c) => [
      c.name,
      c.rows,
      c.mismatches.length === 0 ? 'identical' : `${c.mismatches.length} differences`,
    ]),
  ),
  '',
  ...(failed.length
    ? [
        '## Differences',
        '',
        ...failed.flatMap((c) => [
          `### ${c.name}`,
          '',
          ...c.mismatches.slice(0, 25).map((m) => `- ${m}`),
          '',
        ]),
      ]
    : ['Every compared table is identical across the two engines.', '']),
].join('\n');

const evidenceDir = join(DOCS_DIR, 'evidence');
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, 'snowflake-run.md'), report);
console.table(
  comparisons.map((c) => ({
    table: c.name,
    rows: c.rows,
    result: c.mismatches.length === 0 ? 'identical' : `${c.mismatches.length} differences`,
  })),
);
console.log(`Report written to docs/evidence/snowflake-run.md`);
if (failed.length > 0) process.exitCode = 1;
