import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.js';
import { DEFAULT_SIMULATION_PARAMS } from './simulator.js';
import { readSnapshot, type WarehouseSnapshot } from './snapshot.js';
import { normaliseRow, type Row, type Warehouse } from './warehouse.js';

export interface SnowflakeSettings {
  account: string;
  username: string;
  password?: string;
  token?: string;
  privateKeyPath?: string;
  privateKeyPass?: string;
  warehouse: string;
  database: string;
  role?: string;
}

interface SnowflakeConnection {
  connect(callback: (error: Error | undefined) => void): void;
  execute(options: {
    sqlText: string;
    binds?: unknown[];
    complete: (error: Error | undefined, statement: unknown, rows: Row[] | undefined) => void;
  }): void;
  destroy(callback: (error: Error | undefined) => void): void;
}

interface SnowflakeSdk {
  createConnection(options: Record<string, unknown>): SnowflakeConnection;
  configure(options: Record<string, unknown>): void;
}

/** The `Warehouse` interface on Snowflake: the same four methods the application uses on
 *  DuckDB, so everything above this file is unaware of which engine it is talking to. */
export class SnowflakeWarehouse implements Warehouse {
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

/**
 * The driver is large and only some deployments need it, so it is not a dependency of the
 * API. It is found in `tools/snowflake` (installed by `npm run sql:snowflake`), or wherever a
 * deployment that reads from Snowflake has installed `snowflake-sdk`.
 */
async function loadDriver(): Promise<SnowflakeSdk> {
  const name = 'snowflake-sdk';
  try {
    return createRequire(join(REPO_ROOT, 'tools', 'snowflake', 'package.json'))(
      name,
    ) as SnowflakeSdk;
  } catch {
    try {
      const module = (await import(name)) as { default?: SnowflakeSdk } & SnowflakeSdk;
      return module.default ?? module;
    } catch {
      throw new Error(
        'The Snowflake driver is not installed. Run `npm install --prefix tools/snowflake`, or add `snowflake-sdk` to the deployment.',
      );
    }
  }
}

const expandHome = (path: string): string =>
  path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());

export function assertIdentifier(value: string, what: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value))
    throw new Error(`${what} must be a plain identifier.`);
  return value.toUpperCase();
}

export async function connectSnowflake(settings: SnowflakeSettings): Promise<SnowflakeWarehouse> {
  const sdk = await loadDriver();
  sdk.configure({ logLevel: 'ERROR' });

  const auth: Record<string, unknown> = settings.privateKeyPath
    ? {
        authenticator: 'SNOWFLAKE_JWT',
        privateKeyPath: expandHome(settings.privateKeyPath),
        privateKeyPass: settings.privateKeyPass,
      }
    : settings.token
      ? { authenticator: 'PROGRAMMATIC_ACCESS_TOKEN', token: settings.token }
      : { password: settings.password };

  const connection = sdk.createConnection({
    account: settings.account,
    username: settings.username,
    ...auth,
    warehouse: settings.warehouse,
    role: settings.role || undefined,
    application: 'PureInsightsCommandCentre',
  });
  await new Promise<void>((resolve, reject) =>
    connection.connect((error) => (error ? reject(error) : resolve())),
  );
  return new SnowflakeWarehouse(connection);
}

/**
 * Reads the application's snapshot straight from Snowflake.
 *
 * The application is a reader here: it does not run the SQL suite. In production the suite is
 * run on a schedule inside Snowflake (a task, or the orchestrator that owns the warehouse),
 * and this reads whatever that last produced. `builtAt` is when the marts were last written,
 * which is how a refresh knows whether there is anything new.
 */
export async function readSnowflakeSnapshot(
  settings: SnowflakeSettings,
): Promise<WarehouseSnapshot> {
  const database = assertIdentifier(settings.database, 'SNOWFLAKE_DATABASE');
  const warehouse = await connectSnowflake(settings);
  try {
    await warehouse.exec(`USE DATABASE ${database}`);
    const [marts] = await warehouse.query<{ built_at: string | null }>(
      `SELECT MAX(last_altered) AS built_at FROM INFORMATION_SCHEMA.TABLES
       WHERE table_schema = 'MART' AND table_name = 'FCT_REPORT_PERIOD'`,
    );
    if (!marts?.built_at) {
      throw new Error(
        `Database ${database} has no MART.FCT_REPORT_PERIOD. Run the SQL suite there first (npm run sql:snowflake).`,
      );
    }
    // Written by the suite runner when it is the one that built the marts; absent when a
    // scheduler did, in which case the duration is simply not known.
    const [build] = await warehouse
      .query<{ suite_duration_ms: number }>('SELECT suite_duration_ms FROM CONFIG.BUILD')
      .catch(() => []);
    const [queries] = await warehouse.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ACCOUNT_USAGE.QUERY_HISTORY',
    );
    return await readSnapshot(warehouse, {
      builtAt: marts.built_at,
      suiteDurationMs: build?.suite_duration_ms ?? 0,
      fromCache: false,
      queryRowsSimulated: queries?.n ?? 0,
      queriesPerRow: DEFAULT_SIMULATION_PARAMS.queriesPerRow,
    });
  } finally {
    await warehouse.close();
  }
}
