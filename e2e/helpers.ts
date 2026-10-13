import { type APIRequestContext, expect, type Page } from '@playwright/test';

export const PERSONA = {
  admin: 'Platform Admin',
  finops: 'FinOps Analyst',
  viewer: 'Viewer',
} as const;

/** One-click demo sign-in as a staff persona. */
export async function signIn(page: Page, persona: keyof typeof PERSONA): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(`^${PERSONA[persona]}`) }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

export async function signInAsOwner(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Report owner account').selectOption(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

/** Waits until the real-time stream reports that it is connected. */
export async function waitForLive(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
}

export const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' }).first();

/**
 * Posts an hour of readings the way the portal would, with timestamps spread over the last
 * sixty minutes, so the live charts have something to show in a screenshot. Deterministic.
 */
export async function seedLiveReadings(request: APIRequestContext): Promise<void> {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const now = Date.now();
  const events: Record<string, unknown>[] = [];
  for (let minutesAgo = 59; minutesAgo >= 0; minutesAgo--) {
    const at = (offsetSec: number) =>
      new Date(now - minutesAgo * 60_000 + offsetSec * 1000).toISOString();
    // A slow patch from 28 to 20 minutes ago, on top of a gentle wave.
    const incident = minutesAgo <= 28 && minutesAgo >= 20 ? 14 : 0;
    const base = 9 + 4 * Math.sin(minutesAgo / 8) + incident;
    for (let i = 0; i < 4; i++) {
      const report = 202 + ((minutesAgo * 4 + i) % 60);
      events.push({
        reportId: `RPT_${report}`,
        eventId: `seed-${minutesAgo}-${i}`,
        observedAt: at(i * 10),
        loadTimeSec: Math.round((base + random() * 9 + (random() < 0.08 ? 18 : 0)) * 10) / 10,
        refreshStatus: random() < 0.05 ? 'FAILED' : 'SUCCESS',
      });
    }
    if (minutesAgo % 3 === 0) {
      events.push({
        reportId: 'RPT_201',
        eventId: `seed-201-${minutesAgo}`,
        observedAt: at(45),
        loadTimeSec: Math.round((11 + incident * 1.4 + random() * 6) * 10) / 10,
        refreshStatus: 'SUCCESS',
      });
    }
  }
  const response = await request.post('/api/v1/telemetry', {
    headers: { 'x-api-key': 'demo-ingest-key-change-me' },
    data: { events },
  });
  expect(response.status()).toBe(202);
  expect((await response.json()).rejected).toEqual([]);
}
