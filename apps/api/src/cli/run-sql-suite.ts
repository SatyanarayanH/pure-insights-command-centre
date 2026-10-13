/** Runs the cost allocation SQL suite on DuckDB and prints the reconciliation table.
 *  Exits non-zero when a statement or a reconciliation check fails. */
import { DEFAULT_GENERATED_DIR, DEFAULT_RAW_CSV, SQL_DIR } from '../paths.js';
import { ensureSimulation } from '../warehouse/build.js';
import { DuckDbWarehouse } from '../warehouse/duckdb.js';
import { ReconciliationError, runSqlSuite } from '../warehouse/sql-runner.js';

const rawCsv = process.env.RAW_CSV ?? DEFAULT_RAW_CSV;
const dataDir = process.env.GENERATED_DIR ?? DEFAULT_GENERATED_DIR;

const { manifest, regenerated } = ensureSimulation(rawCsv, dataDir);
console.log(
  `ACCOUNT_USAGE simulation ${regenerated ? 'generated' : 'reused'}: ` +
    `${manifest.rows.queryHistory.toLocaleString()} query rows, ` +
    `${manifest.rows.warehouseMetering.toLocaleString()} metered warehouse-hours`,
);

const warehouse = await DuckDbWarehouse.open();
try {
  const result = await runSqlSuite(warehouse, { sqlDir: SQL_DIR, rawCsv, dataDir });
  console.table(result.files);
  console.table(
    result.reconciliation.map((r) => ({
      check: r.check_id,
      description: r.description,
      expected: r.expected_value,
      actual: r.actual_value,
      status: r.status,
    })),
  );
  console.log(`Suite passed on ${warehouse.dialect} in ${result.durationMs} ms.`);
} catch (error) {
  if (error instanceof ReconciliationError) {
    console.table(error.failures);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await warehouse.close();
}
