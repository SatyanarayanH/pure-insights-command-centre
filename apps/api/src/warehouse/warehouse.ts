/** The analytical store behind the cost and data-quality views. DuckDB locally; the same
 *  interface is what a Snowflake adapter implements (tools/snowflake shows the driver calls). */
export type Row = Record<string, unknown>;

export interface Warehouse {
  readonly dialect: 'duckdb' | 'snowflake';
  /** Runs one statement and returns its rows with lower-cased column names. */
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs one statement for its side effects. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Engines disagree on value types (BIGINT as bigint, timestamps as Date, upper-case column
 *  names on Snowflake). Everything above the warehouse sees plain JSON-friendly rows. */
export function normaliseRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.toLowerCase()] = normaliseValue(value);
  }
  return out;
}

function normaliseValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    // DuckDB wraps DECIMAL, HUGEINT and similar in value objects that stringify to the number.
    const text = String(value);
    const asNumber = Number(text);
    return text !== '' && Number.isFinite(asNumber) ? asNumber : text;
  }
  return value;
}
