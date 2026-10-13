import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_GENERATED_DIR, DEFAULT_RAW_CSV, DEFAULT_RUNTIME_DIR, DEFAULT_WEB_DIST } from './paths.js';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
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

  RAW_CSV: z.string().default(DEFAULT_RAW_CSV),
  GENERATED_DIR: z.string().default(DEFAULT_GENERATED_DIR),
  OPS_DB: z.string().default(join(DEFAULT_RUNTIME_DIR, 'ops.sqlite')),
  WEB_DIST: z.string().default(DEFAULT_WEB_DIST),

  SIMULATOR_ENABLED: bool(true),
  SIMULATOR_INTERVAL_MS: z.coerce.number().int().min(250).default(2500),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  if (parsed.NODE_ENV === 'production' && !parsed.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production (at least 32 characters).');
  }
  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    jwtSecret: parsed.JWT_SECRET ?? randomBytes(48).toString('base64url'),
    jwtSecretIsEphemeral: !parsed.JWT_SECRET,
    accessTokenTtlSec: parsed.ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlDays: parsed.REFRESH_TOKEN_TTL_DAYS,
    demoMode: parsed.DEMO_MODE,
    demoPassword: parsed.DEMO_PASSWORD,
    ingestApiKey: parsed.INGEST_API_KEY,
    corsOrigins: parsed.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    rawCsv: parsed.RAW_CSV,
    generatedDir: parsed.GENERATED_DIR,
    opsDb: parsed.OPS_DB,
    webDist: parsed.WEB_DIST,
    simulatorEnabled: parsed.SIMULATOR_ENABLED,
    simulatorIntervalMs: parsed.SIMULATOR_INTERVAL_MS,
  };
}

export const SERVICE_NAME = 'pure-insights-command-centre';
export const SERVICE_VERSION = '1.0.0';
export const API_PREFIX = '/api/v1';
