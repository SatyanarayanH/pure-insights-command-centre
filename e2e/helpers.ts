import { expect, type Page } from '@playwright/test';

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
