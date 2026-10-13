import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** The features that exist for running the system for real, exercised through the browser. */
test.describe('operating the system', () => {
  test('a live reading shows up on the report page and on the overview', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/reports/RPT_252');
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/admin/incidents') && r.status() === 202),
      page.getByRole('button', { name: /Latency spike/ }).click(),
    ]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Live load time', exact: true })).toBeVisible();
    await expect(page.getByText(/\d+ readings? · \d+ over 15 s/).first()).toBeVisible();

    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Live load time, all reports in view' }),
    ).toBeVisible();
    await expect(page.getByText(/\d+ readings? from \d+ reports?/).first()).toBeVisible();
    // The range switch is a real control: the six-hour view still contains the reading.
    await page.getByRole('tab', { name: '6 h' }).click();
    await expect(page.getByText(/\d+ readings? from \d+ reports?/).first()).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`a high-severity alert is recorded as a notification, marked as not sent without a webhook (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page, 'admin');
      await page.goto('/reports/RPT_253');
      await page.getByRole('button', { name: 'Recovery' }).click();
      await page.getByRole('button', { name: 'Recovery' }).click();
      await page.getByRole('button', { name: 'Refresh failure' }).click();

      await page.goto('/admin');
      await page.getByRole('tab', { name: 'Notifications' }).click();
      await expect(page.getByText('No delivery channel is configured.')).toBeVisible();
      const row = page
        .getByRole('row')
        .filter({ hasText: /Automated refresh failed: Analytics Dashboard 54/ });
      await expect(row.first()).toBeVisible();
      await expect(row.first()).toContainText('skipped');

      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axe.violations.map((v) => `${v.id} ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
    });
  }

  test('an admin can re-read the warehouse without a restart', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/admin');
    await expect(page.getByText('off (on demand)')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh warehouse' }).click();
    await expect(
      page.getByText('The warehouse has not changed since it was last read.'),
    ).toBeVisible();
    await expect(page.getByText(/^unchanged · /)).toBeVisible();
  });

  test('the server publishes metrics for a monitoring system to scrape', async ({ request }) => {
    const response = await request.get('/metrics');
    expect(response.status()).toBe(200);
    const text = await response.text();
    for (const series of [
      'picc_http_requests_total',
      'picc_http_request_duration_seconds_bucket',
      'picc_alerts_open',
      'picc_telemetry_events',
      'picc_realtime_connections',
      'picc_warehouse_reconciliation_checks',
      'picc_event_loop_lag_seconds',
    ]) {
      expect(text, series).toContain(series);
    }
  });
});
