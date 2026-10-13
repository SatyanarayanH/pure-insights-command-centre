import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Warehouse } from './warehouse.js';

/** The suite, in execution order. The loader between setup and staging is dialect-specific. */
export const SUITE_FILES = [
  '00_setup.sql',
  '01_staging_clean.sql',
  '02_attribution_direct.sql',
  '03_attribution_time_weighted.sql',
  '04_unit_economics.sql',
  '05_chargeback.sql',
  '06_cost_anomalies.sql',
  '07_reconciliation_tests.sql',
] as const;

export const LOADER_FILES = {
  duckdb: 'loaders/duckdb_load.sql',
  snowflake: 'loaders/snowflake_load.sql',
} as const;

/** Splits a script into statements on `;`, ignoring semicolons inside string literals,
 *  quoted identifiers, line comments and block comments. */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < script.length) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (ch === '-' && next === '-') {
      const end = script.indexOf('\n', i);
      const stop = end === -1 ? script.length : end;
      current += script.slice(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      const stop = end === -1 ? script.length : end + 2;
      current += script.slice(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < script.length) {
        if (script[j] === ch) {
          if (script[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      current += script.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ';') {
      statements.push(current);
      current = '';
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => stripComments(s).trim() !== '');
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export interface SuiteFileResult {
  file: string;
  statements: number;
  durationMs: number;
}

export interface ReconciliationRow {
  check_id: string;
  description: string;
  expected_value: number | null;
  actual_value: number | null;
  difference: number | null;
  tolerance: number;
  status: 'PASS' | 'FAIL';
}

export interface SuiteResult {
  files: SuiteFileResult[];
  reconciliation: ReconciliationRow[];
  durationMs: number;
}

export class ReconciliationError extends Error {
  constructor(readonly failures: ReconciliationRow[]) {
    super(
      `Reconciliation failed: ${failures
        .map((f) => `${f.check_id} (${f.description}: expected ${f.expected_value}, got ${f.actual_value})`)
        .join('; ')}`,
    );
  }
}

export interface RunSuiteOptions {
  sqlDir: string;
  rawCsv: string;
  dataDir: string;
}

/** Runs setup, the dialect's loader, then the rest of the suite. Throws if any reconciliation
 *  check fails, so a warehouse that does not add up never reaches the application. */
export async function runSqlSuite(warehouse: Warehouse, options: RunSuiteOptions): Promise<SuiteResult> {
  const started = performance.now();
  const [setup, ...rest] = SUITE_FILES;
  const order = [setup, LOADER_FILES[warehouse.dialect], ...rest];
  const files: SuiteFileResult[] = [];

  for (const file of order) {
    const script = readFileSync(join(options.sqlDir, file), 'utf8')
      .replaceAll('${RAW_CSV}', options.rawCsv)
      .replaceAll('${DATA_DIR}', options.dataDir);
    const statements = splitStatements(script);
    const fileStarted = performance.now();
    for (const [index, statement] of statements.entries()) {
      try {
        await warehouse.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${file}, statement ${index + 1} of ${statements.length} failed: ${message}`, {
          cause: error,
        });
      }
    }
    files.push({ file, statements: statements.length, durationMs: Math.round(performance.now() - fileStarted) });
  }

  const reconciliation = await warehouse.query<ReconciliationRow & Record<string, unknown>>(
    'SELECT check_id, description, expected_value, actual_value, difference, tolerance, status FROM DQ.RECONCILIATION ORDER BY check_id',
  );
  const failures = reconciliation.filter((row) => row.status !== 'PASS');
  if (failures.length > 0) throw new ReconciliationError(failures);

  return { files, reconciliation, durationMs: Math.round(performance.now() - started) };
}
