/**
 * Proves the application can run on Snowflake directly, not only validate SQL against it.
 *
 *   npm run sql:snowflake        # builds the marts in Snowflake (once)
 *   npm run snowflake:live-read
 *
 * It reads the application's whole snapshot from Snowflake through the same adapter the server
 * uses with WAREHOUSE=snowflake, compares every value with the snapshot built locally on
 * DuckDB, then starts the application on the Snowflake snapshot and exercises it, including a
 * refresh. Writes docs/evidence/snowflake-live-read.md.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { createContainer } from '../../apps/api/src/container.js';
import { DOCS_DIR, REPO_ROOT } from '../../apps/api/src/paths.js';
import type { WarehouseSnapshot } from '../../apps/api/src/warehouse/snapshot.js';
import { snapshotBuilderFor } from '../../apps/api/src/warehouse/source.js';

const envFile = join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const base = {
  NODE_ENV: 'test',
  OPS_DB: ':memory:',
  SIMULATOR_ENABLED: 'false',
  LOG_LEVEL: 'silent',
};
const duckConfig = loadConfig({ ...process.env, ...base, WAREHOUSE: 'duckdb' });
const snowConfig = loadConfig({ ...process.env, ...base, WAREHOUSE: 'snowflake' });

console.log('Building the snapshot locally on DuckDB...');
const duck = await snapshotBuilderFor(duckConfig)();
console.log('Reading the snapshot from Snowflake...');
const readFromSnowflake = snapshotBuilderFor(snowConfig);
const started = performance.now();
const snow = await readFromSnowflake();
const readMs = Math.round(performance.now() - started);

// ---- compare every value ---------------------------------------------------------------------
const TOLERANCE = 1e-6;
const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a));
  if (a instanceof Object && b instanceof Object) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) =>
      same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  // Engines differ on true/false against 1/0; nothing else may differ.
  return a === b || (typeof a !== typeof b && String(Number(a)) === String(Number(b)));
};

/** Parts of a snapshot that describe the build, not the data. */
const META = new Set([
  'dialect',
  'builtAt',
  'suiteDurationMs',
  'fromCache',
  'queryRowsSimulated',
  'queriesPerRow',
]);
const comparisons: { part: string; rows: number; values: number; differences: string[] }[] = [];
for (const part of Object.keys(duck).filter(
  (key) => !META.has(key),
) as (keyof WarehouseSnapshot)[]) {
  const left = duck[part];
  const right = snow[part];
  const leftRows = Array.isArray(left) ? left : [left];
  const rightRows = Array.isArray(right) ? right : [right];
  const differences: string[] = [];
  if (leftRows.length !== rightRows.length)
    differences.push(`${leftRows.length} rows on DuckDB, ${rightRows.length} on Snowflake`);
  let values = 0;
  leftRows.forEach((row, index) => {
    const other = rightRows[index] as Record<string, unknown> | undefined;
    for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
      values += 1;
      if (!other || !same(value, other[column])) {
        if (differences.length < 5)
          differences.push(
            `row ${index}.${column}: ${JSON.stringify(value)} (DuckDB) vs ${JSON.stringify(other?.[column])} (Snowflake)`,
          );
        else if (differences.length === 5) differences.push('...');
      }
    }
  });
  comparisons.push({ part, rows: leftRows.length, values, differences });
}

// ---- run the application on the Snowflake snapshot -----------------------------------------
const container = createContainer(snowConfig, snow, { buildSnapshot: readFromSnowflake });
const { app } = createApp(container);
const login = await request(app)
  .post('/api/v1/auth/demo-login')
  .send({ email: 'admin@company.com' });
const auth = { authorization: `Bearer ${String(login.body.accessToken)}` };
const get = (path: string) => request(app).get(`/api/v1${path}`).set(auth);

const status = (await get('/system/status')).body.warehouse;
const overview = (await get('/overview')).body;
const costs = (await get('/costs/summary')).body;
const dq = (await get('/dq/summary')).body;
const reportId = snow.dim[0]!.report_id;
const detail = (await get(`/reports/${reportId}`)).body;
const refreshStarted = performance.now();
const refresh = (await request(app).post('/api/v1/admin/warehouse/refresh').set(auth).send({}))
  .body;
const refreshMs = Math.round(performance.now() - refreshStarted);
container.close();

const checks: [string, boolean, string][] = [
  [
    'The server reports Snowflake as its source',
    status.source === 'snowflake' && status.dialect === 'snowflake',
    `source ${status.source}, ${status.reconciliationPassed}/${status.reconciliationTotal} reconciliation checks pass, marts built ${status.builtAt}`,
  ],
  [
    'Overview is served from it',
    overview.reports.total === duck.dim.length,
    `${overview.reports.total} reports, total cost $${Math.round(overview.cost.totalCostUsd).toLocaleString()} for ${overview.asOf.periodLabel}`,
  ],
  [
    'Cost summary is served from it',
    costs.periods.length === duck.periodSummary.length,
    `${costs.periods.length} periods, credit price $${costs.creditPriceUsd}`,
  ],
  [
    'Data-quality summary is served from it',
    dq.rules.length === duck.dqRules.length,
    `${dq.rules.length} rules, ${dq.rowsQuarantined} rows quarantined, engine "${dq.warehouse.dialect}"`,
  ],
  [
    'A report page is served from it',
    detail.history.length === duck.facts.filter((f) => f.report_id === reportId).length,
    `${reportId}: ${detail.history.length} periods of history`,
  ],
  [
    'A refresh re-reads Snowflake while the application keeps running',
    refresh.outcome === 'unchanged' && refresh.error === null,
    `outcome "${refresh.outcome}" in ${refreshMs} ms (the marts have not been rebuilt since the first read)`,
  ],
];

const different = comparisons.filter((c) => c.differences.length > 0);
const failedChecks = checks.filter(([, ok]) => !ok);
const table = (header: string[], rows: (string | number)[][]) =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

writeFileSync(
  join(DOCS_DIR, 'evidence', 'snowflake-live-read.md'),
  [
    '# The application reading from Snowflake',
    '',
    `Run at ${new Date().toISOString()} against Snowflake database ${snowConfig.snowflake?.database}, through the adapter the server uses when started with \`WAREHOUSE=snowflake\`.`,
    '',
    `Reading everything the application needs took ${readMs} ms: ${comparisons.length} result sets, ${comparisons.reduce((a, c) => a + c.rows, 0).toLocaleString()} rows.`,
    '',
    '## Snapshot read from Snowflake versus the one built on DuckDB',
    '',
    `Every value of every row, numbers compared with relative tolerance ${TOLERANCE}.`,
    '',
    table(
      ['Part of the snapshot', 'Rows', 'Values compared', 'Result'],
      comparisons.map((c) => [
        `\`${c.part}\``,
        c.rows,
        c.values.toLocaleString(),
        c.differences.length === 0 ? 'identical' : `${c.differences.length} differences`,
      ]),
    ),
    '',
    ...(different.length
      ? [
          '### Differences',
          '',
          ...different.flatMap((c) => [
            `**${c.part}**`,
            '',
            ...c.differences.map((d) => `- ${d}`),
            '',
          ]),
        ]
      : ['The application holds exactly the same data whichever engine it reads from.', '']),
    '## The application running on it',
    '',
    table(
      ['Check', 'Result', ''],
      checks.map(([name, ok, result]) => [name, result, ok ? 'PASS' : 'FAIL']),
    ),
    '',
  ].join('\n'),
);

console.table(
  comparisons.map((c) => ({
    part: c.part,
    rows: c.rows,
    result: c.differences.length === 0 ? 'identical' : c.differences[0],
  })),
);
for (const [name, ok, result] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${result}`);
console.log(
  `Read from Snowflake in ${readMs} ms. Report written to docs/evidence/snowflake-live-read.md`,
);
process.exit(different.length === 0 && failedChecks.length === 0 ? 0 : 1);
