import { expect, test } from '@playwright/test';
import { seedLiveReadings, signIn } from './helpers';

/** Regenerates the README screenshots. Runs only when asked: `npm run screenshots`. */
test.describe('screenshots', () => {
  test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/screenshots');

  test('capture the main pages', async ({ page, request }) => {
    await seedLiveReadings(request);
    const shot = async (name: string, fullPage = true) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage });
    };

    await page.goto('/');
    await expect(page.getByText('Demo personas')).toBeVisible();
    await shot('01-login', false);

    await signIn(page, 'admin');
    await expect(page.getByText('Health over 20 periods')).toBeVisible();
    await shot('02-overview');

    await page.goto('/reports');
    await expect(page.getByText('100 reports')).toBeVisible();
    await shot('03-reports', false);

    await page.goto('/reports/RPT_201');
    await expect(page.getByText('Refresh history')).toBeVisible();
    await shot('04-report-detail');

    await page.goto('/orphans');
    await expect(page.getByText('Remediation queue')).toBeVisible();
    await shot('05-orphans', false);

    await page.goto('/alerts');
    await expect(page.getByText('Alert rules')).toBeVisible();
    await shot('06-alerts', false);

    await page.goto('/costs');
    await expect(page.getByText('Chargeback by owner')).toBeVisible();
    await expect(page.getByText('Unit economics by report')).toBeVisible();
    await shot('07-cost');

    await page.goto('/data-quality');
    await expect(page.getByText('16 / 16')).toBeVisible();
    await shot('08-data-quality');

    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByText('Permission matrix')).toBeVisible();
    await shot('09-access-matrix');

    await page.getByRole('tab', { name: 'Notifications' }).click();
    await expect(page.getByText('No delivery channel is configured.')).toBeVisible();
    await shot('12-notifications', false);

    await page.getByRole('tab', { name: 'Live & incidents' }).click();
    await page.getByRole('button', { name: 'Refresh warehouse' }).click();
    await expect(
      page.getByText('The warehouse has not changed since it was last read.'),
    ).toBeVisible();
    await shot('13-admin-status');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.getByText('Health over 20 periods')).toBeVisible();
    await shot('10-overview-dark', false);

    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/alerts');
    await expect(page.getByText('Alert rules')).toBeVisible();
    await shot('11-alerts-phone', false);
  });
});
