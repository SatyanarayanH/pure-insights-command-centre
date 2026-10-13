import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);

// End-to-end tests drive the production build: the API serving the compiled web app, on a
// throwaway operational database, with the telemetry simulator off so runs are deterministic.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'chromium',
      // Locally, use the installed Chrome so nothing has to be downloaded. CI installs Chromium.
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        ...(process.env.CI ? {} : { channel: 'chrome' }),
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm start',
    url: `http://127.0.0.1:${PORT}/healthz`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      API_PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      DEMO_MODE: 'true',
      SIMULATOR_ENABLED: 'false',
      // With no simulator there is no feed; keep the "no telemetry" banner out of these runs.
      FEED_SILENT_AFTER_SEC: '86400',
      OPS_DB: join(tmpdir(), `picc-e2e-${Date.now()}.sqlite`),
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
    },
  },
});
