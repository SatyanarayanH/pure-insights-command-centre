import type { Config } from '../config.js';
import { SQL_DIR } from '../paths.js';
import type { SnapshotBuilder } from './handle.js';
import { buildWarehouseSnapshot } from './snapshot.js';
import { readSnowflakeSnapshot } from './snowflake.js';

/**
 * How this deployment obtains its warehouse snapshot, at start-up and on every refresh.
 *
 *   duckdb     build locally: simulate ACCOUNT_USAGE, run the SQL suite, reconcile. Cached on
 *              disk by a fingerprint of the inputs, so an unchanged input is not rebuilt.
 *   snowflake  read the marts that the suite has already built in Snowflake.
 */
export function snapshotBuilderFor(config: Config): SnapshotBuilder {
  if (config.warehouse === 'snowflake') {
    const settings = config.snowflake;
    if (!settings) throw new Error('WAREHOUSE=snowflake needs the SNOWFLAKE_* settings.');
    return () => readSnowflakeSnapshot(settings);
  }
  return () =>
    buildWarehouseSnapshot({
      sqlDir: SQL_DIR,
      rawCsv: config.rawCsv,
      generatedDir: config.generatedDir,
      cache: true,
    });
}
