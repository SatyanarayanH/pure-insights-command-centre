/** Builds the warehouse and writes the on-disk cache, so the next server start is instant.
 *  Run during the Docker image build. */
import { DEFAULT_GENERATED_DIR, DEFAULT_RAW_CSV, SQL_DIR } from '../paths.js';
import { buildWarehouseSnapshot } from '../warehouse/snapshot.js';

const snapshot = await buildWarehouseSnapshot({
  sqlDir: SQL_DIR,
  rawCsv: process.env.RAW_CSV ?? DEFAULT_RAW_CSV,
  generatedDir: process.env.GENERATED_DIR ?? DEFAULT_GENERATED_DIR,
  cache: true,
});
console.log(
  `Warehouse ${snapshot.fromCache ? 'already built' : `built in ${snapshot.suiteDurationMs} ms`}: ` +
    `${snapshot.dim.length} reports, ${snapshot.facts.length} report-periods, ` +
    `${snapshot.reconciliation.filter((r) => r.status === 'PASS').length}/${snapshot.reconciliation.length} reconciliation checks pass.`,
);
