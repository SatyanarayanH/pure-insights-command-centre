import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type Container, type ContainerOverrides, createContainer } from '../src/container.js';
import type { RouteDefinition } from '../src/http/registry.js';
import { DEFAULT_GENERATED_DIR, DEFAULT_RAW_CSV, SQL_DIR } from '../src/paths.js';
import { buildWarehouseSnapshot, type WarehouseSnapshot } from '../src/warehouse/snapshot.js';

let snapshot: Promise<WarehouseSnapshot> | undefined;

/** The real warehouse, built by the real SQL suite from the real dataset. Built once per test
 *  process and cached on disk between runs. */
export function getSnapshot(): Promise<WarehouseSnapshot> {
  snapshot ??= buildWarehouseSnapshot({
    sqlDir: SQL_DIR,
    rawCsv: DEFAULT_RAW_CSV,
    generatedDir: DEFAULT_GENERATED_DIR,
    cache: true,
  });
  return snapshot;
}

export interface TestContext {
  container: Container;
  app: Express;
  routes: RouteDefinition[];
  /** Advances the injected clock. */
  advance(ms: number): void;
  login(email: string): Promise<string>;
  get(path: string, token?: string): request.Test;
  post(path: string, token: string | undefined, body?: unknown): request.Test;
  put(path: string, token: string | undefined, body?: unknown): request.Test;
  close(): void;
}

export const API = '/api/v1';
export const ADMIN = 'admin@company.com';
export const FINOPS = 'finops@company.com';
export const VIEWER = 'viewer@company.com';
export const OWNER = 'user_7@company.com';

/** A full application wired exactly as in production, on an in-memory operational database
 *  and a controllable clock. */
export async function createTestContext(
  env: Record<string, string> = {},
  overrides: ContainerOverrides = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    OPS_DB: ':memory:',
    JWT_SECRET: 'test-secret-test-secret-test-secret-0123',
    SIMULATOR_ENABLED: 'false',
    DEMO_MODE: 'true',
    INGEST_API_KEY: 'test-ingest-key-0123456789',
    ...env,
  });
  let now = Date.parse('2026-10-13T09:00:00.000Z');
  const container = createContainer(config, await getSnapshot(), {
    now: () => new Date(now),
    ...overrides,
  });
  const { app, routes } = createApp(container);
  const auth = (test: request.Test, token?: string) =>
    token ? test.set('authorization', `Bearer ${token}`) : test;

  return {
    container,
    app,
    routes,
    advance: (ms) => {
      now += ms;
    },
    login: async (email) => {
      const res = await request(app).post(`${API}/auth/demo-login`).send({ email });
      if (res.status !== 200)
        throw new Error(`demo login failed for ${email}: ${res.status} ${res.text}`);
      return res.body.accessToken as string;
    },
    get: (path, token) => auth(request(app).get(`${API}${path}`), token),
    post: (path, token, body = {}) =>
      auth(request(app).post(`${API}${path}`), token).send(body as object),
    put: (path, token, body = {}) =>
      auth(request(app).put(`${API}${path}`), token).send(body as object),
    close: () => container.close(),
  };
}
