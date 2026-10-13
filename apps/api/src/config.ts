import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_GENERATED_DIR,
  DEFAULT_RAW_CSV,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_WEB_DIST,
} from './paths.js';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  /** API_PORT always wins. PORT is honoured only in production, where the platform assigns it;
   *  in development PORT usually belongs to the front-end dev server. */
  API_PORT: z.coerce.number().int().optional(),
  PORT: z.coerce.number().int().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Signing key for access tokens. Required in production; generated per process otherwise. */
  JWT_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(7),

  /** Demo mode seeds the personas and enables one-click sign-in and the incident injector. */
  DEMO_MODE: bool(true),
  DEMO_PASSWORD: z.string().min(8).default('command-centre-demo'),
  INGEST_API_KEY: z.string().min(16).default('demo-ingest-key-change-me'),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Reverse proxies in front of the API whose X-Forwarded-For may be believed. 0 = none. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Set when served over TLS: adds upgrade-insecure-requests and marks cookies Secure. */
  FORCE_HTTPS: bool(false),

  RAW_CSV: z.string().default(DEFAULT_RAW_CSV),
  GENERATED_DIR: z.string().default(DEFAULT_GENERATED_DIR),
  OPS_DB: z.string().default(join(DEFAULT_RUNTIME_DIR, 'ops.sqlite')),
  WEB_DIST: z.string().default(DEFAULT_WEB_DIST),

  SIMULATOR_ENABLED: bool(true),
  SIMULATOR_INTERVAL_MS: z.coerce.number().int().min(250).default(2500),

  /** Requests per minute per client address. The telemetry endpoint takes up to 1,000 events
   *  per request, so this bounds requests, not events. */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(600),
  /** When set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().min(16).optional(),

  /** No telemetry from any report for this long means the feed itself is down. */
  FEED_SILENT_AFTER_SEC: z.coerce.number().int().min(10).default(300),
  /** How long individual readings are kept. Also the window in which a resend is recognised. */
  TELEMETRY_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),

  /** Incoming-webhook URL (Slack, Teams, Mattermost, or any HTTP endpoint). Unset: alert
   *  notifications are recorded but not sent. */
  NOTIFY_WEBHOOK_URL: z.url().optional(),
  NOTIFY_WEBHOOK_FORMAT: z.enum(['slack', 'json']).default('slack'),
  NOTIFY_MIN_SEVERITY: z.enum(['info', 'warning', 'high', 'critical']).default('high'),
  NOTIFY_ESCALATE_AFTER_MIN: z.coerce.number().int().min(1).default(15),

  /** Where the cost model is read from. `snowflake` reads marts the SQL suite built there. */
  WAREHOUSE: z.enum(['duckdb', 'snowflake']).default('duckdb'),
  /** Re-read the warehouse this often without a restart. 0 = only on demand. */
  WAREHOUSE_REFRESH_MIN: z.coerce.number().int().min(0).default(0),
  SNOWFLAKE_ACCOUNT: z.string().optional(),
  SNOWFLAKE_USER: z.string().optional(),
  SNOWFLAKE_PASSWORD: z.string().optional(),
  SNOWFLAKE_TOKEN: z.string().optional(),
  SNOWFLAKE_PRIVATE_KEY_PATH: z.string().optional(),
  SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: z.string().optional(),
  SNOWFLAKE_WAREHOUSE: z.string().default('COMPUTE_WH'),
  SNOWFLAKE_DATABASE: z.string().default('PURE_INSIGHTS_SIM'),
  SNOWFLAKE_ROLE: z.string().optional(),

  /** Optional. With it, the event stream and the stream tickets live in Redis: live updates
   *  survive a restart, and connection-only nodes (ROLE=edge) can share the load. */
  REDIS_URL: z.url().optional(),
  /** Namespace for every key, so several environments can share one Redis. */
  REDIS_PREFIX: z
    .string()
    .regex(/^[\w-]{1,40}$/)
    .default('picc'),
  /** `core` is the whole application. `edge` holds WebSocket and SSE connections only, fed
   *  from Redis; it needs REDIS_URL and no database. */
  ROLE: z.enum(['core', 'edge']).default('core'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // An empty variable (`JWT_SECRET=` in a compose file) means "not set", not "set to nothing".
  const parsed = EnvSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  // A real deployment must bring its own signing key. Demo mode is the one exception: it is
  // already open by design, so a per-process key is acceptable there and is logged as a warning.
  if (parsed.NODE_ENV === 'production' && !parsed.JWT_SECRET && !parsed.DEMO_MODE) {
    throw new Error('JWT_SECRET must be set in production (at least 32 characters).');
  }
  if (parsed.ROLE === 'edge' && !parsed.REDIS_URL) {
    throw new Error('ROLE=edge needs REDIS_URL: an edge node receives its events from Redis.');
  }
  const hasSnowflakeAuth =
    parsed.SNOWFLAKE_PASSWORD || parsed.SNOWFLAKE_TOKEN || parsed.SNOWFLAKE_PRIVATE_KEY_PATH;
  if (
    parsed.WAREHOUSE === 'snowflake' &&
    !(parsed.SNOWFLAKE_ACCOUNT && parsed.SNOWFLAKE_USER && hasSnowflakeAuth)
  ) {
    throw new Error(
      'WAREHOUSE=snowflake needs SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER and one of SNOWFLAKE_PASSWORD, SNOWFLAKE_TOKEN or SNOWFLAKE_PRIVATE_KEY_PATH.',
    );
  }
  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.API_PORT ?? (parsed.NODE_ENV === 'production' ? parsed.PORT : undefined) ?? 4000,
    logLevel: parsed.LOG_LEVEL,
    jwtSecret: parsed.JWT_SECRET ?? randomBytes(48).toString('base64url'),
    jwtSecretIsEphemeral: !parsed.JWT_SECRET,
    accessTokenTtlSec: parsed.ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlDays: parsed.REFRESH_TOKEN_TTL_DAYS,
    demoMode: parsed.DEMO_MODE,
    demoPassword: parsed.DEMO_PASSWORD,
    ingestApiKey: parsed.INGEST_API_KEY,
    forceHttps: parsed.FORCE_HTTPS,
    trustProxy: parsed.TRUST_PROXY,
    corsOrigins: parsed.CORS_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rawCsv: parsed.RAW_CSV,
    generatedDir: parsed.GENERATED_DIR,
    opsDb: parsed.OPS_DB,
    webDist: parsed.WEB_DIST,
    simulatorEnabled: parsed.SIMULATOR_ENABLED,
    simulatorIntervalMs: parsed.SIMULATOR_INTERVAL_MS,
    rateLimitPerMin: parsed.RATE_LIMIT_PER_MIN,
    metricsToken: parsed.METRICS_TOKEN ?? null,
    feedSilentAfterSec: parsed.FEED_SILENT_AFTER_SEC,
    telemetryRetentionDays: parsed.TELEMETRY_RETENTION_DAYS,
    notify: {
      webhookUrl: parsed.NOTIFY_WEBHOOK_URL ?? null,
      format: parsed.NOTIFY_WEBHOOK_FORMAT,
      minSeverity: parsed.NOTIFY_MIN_SEVERITY,
      escalateAfterMin: parsed.NOTIFY_ESCALATE_AFTER_MIN,
    },
    warehouse: parsed.WAREHOUSE,
    warehouseRefreshMin: parsed.WAREHOUSE_REFRESH_MIN,
    snowflake:
      parsed.SNOWFLAKE_ACCOUNT && parsed.SNOWFLAKE_USER
        ? {
            account: parsed.SNOWFLAKE_ACCOUNT,
            username: parsed.SNOWFLAKE_USER,
            password: parsed.SNOWFLAKE_PASSWORD,
            token: parsed.SNOWFLAKE_TOKEN,
            privateKeyPath: parsed.SNOWFLAKE_PRIVATE_KEY_PATH,
            privateKeyPass: parsed.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
            warehouse: parsed.SNOWFLAKE_WAREHOUSE,
            database: parsed.SNOWFLAKE_DATABASE,
            role: parsed.SNOWFLAKE_ROLE,
          }
        : null,
    redisUrl: parsed.REDIS_URL ?? null,
    redisPrefix: parsed.REDIS_PREFIX,
    role: parsed.ROLE,
  };
}

export const SERVICE_NAME = 'pure-insights-command-centre';
export const SERVICE_VERSION = '1.0.0';
export const API_PREFIX = '/api/v1';
