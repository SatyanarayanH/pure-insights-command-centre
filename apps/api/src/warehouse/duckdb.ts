import { type DuckDBConnection, DuckDBInstance, type DuckDBValue } from '@duckdb/node-api';
import { normaliseRow, type Row, type Warehouse } from './warehouse.js';

export class DuckDbWarehouse implements Warehouse {
  readonly dialect = 'duckdb' as const;

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  static async open(path = ':memory:'): Promise<DuckDbWarehouse> {
    const instance = await DuckDBInstance.create(path);
    return new DuckDbWarehouse(instance, await instance.connect());
  }

  async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql, params as DuckDBValue[]);
    return reader.getRowObjectsJS().map((row) => normaliseRow(row as Row)) as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.connection.run(sql);
  }

  async close(): Promise<void> {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}
