import { expect, test } from '@playwright/test';
import { nav, signIn, signInAsOwner, waitForLive } from './helpers';

test.describe('role-based access in the browser', () => {
  test('admin sees every section', async ({ page }) => {
    await signIn(page, 'admin');
    for (const item of [
      'Overview',
      'Reports',
      'Orphaned reports',
      'Alerts',
      'Cost',
      'Data quality',
      'Admin',
    ]) {
      await expect(nav(page).getByRole('link', { name: new RegExp(`^${item}`) })).toBeVisible();
    }
    await expect(page.getByText('Showing all reports on the platform')).toBeVisible();
    await expect(page.getByText(/Total cost, P20/)).toBeVisible();
  });

  test('finops sees cost and data quality but no admin section and no write actions', async ({
    page,
  }) => {
    await signIn(page, 'finops');
    await expect(nav(page).getByRole('link', { name: /^Cost/ })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /^Data quality/ })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /^Admin/ })).toHaveCount(0);
    await page.goto('/orphans');
    await expect(page.getByRole('heading', { name: 'Orphaned reports' })).toBeVisible();
    await expect(page.getByRole('cell', { name: /@company\.com/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Assign/ })).toHaveCount(0);
  });

  test('viewer sees health only: no cost anywhere, masked emails, no restricted pages', async ({
    page,
  }) => {
    await signIn(page, 'viewer');
    for (const hidden of ['Cost', 'Data quality', 'Admin', 'Orphaned reports']) {
      await expect(nav(page).getByRole('link', { name: new RegExp(`^${hidden}`) })).toHaveCount(0);
    }
    await expect(page.getByText(/Total cost/)).toHaveCount(0);
    await page.goto('/reports');
    await expect(page.getByRole('columnheader', { name: /Cost/ })).toHaveCount(0);
    await expect(page.getByText(/u\*+\d@company\.com/).first()).toBeVisible();
    await expect(page.getByText(/user_\d+@company\.com/)).toHaveCount(0);
    // Typing the URL does not get around it: the page is refused, and so is the API behind it.
    await page.goto('/costs');
    await expect(page.getByText('Not available for your role')).toBeVisible();
  });

  test('report owner sees only their own reports', async ({ page }) => {
    await signInAsOwner(page, 'user_7@company.com');
    await expect(page.getByText('Showing only the reports you own')).toBeVisible();
    await page.goto('/reports');
    await expect(page.getByText('7 reports')).toBeVisible();
    const owners = await page.getByRole('row').filter({ hasText: '@company.com' }).allInnerTexts();
    expect(owners.length).toBe(7);
    expect(owners.every((row) => row.includes('user_7@company.com'))).toBe(true);
    // A report that belongs to someone else does not exist as far as this user can tell.
    await page.goto('/reports/RPT_200');
    await expect(page.getByText('Not found').first()).toBeVisible();
  });
});

test.describe('real-time alerting across two sessions', () => {
  test('an injected latency spike reaches another signed-in user within moments', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const admin = await adminContext.newPage();
    const viewer = await viewerContext.newPage();
    await signIn(admin, 'admin');
    await signIn(viewer, 'viewer');
    await waitForLive(viewer);

    // Start from a clean state for this report, then break it.
    await admin.goto('/reports/RPT_240');
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.getByRole('button', { name: /Latency spike/ }).click();

    // The viewer never reloads: the alert arrives over the WebSocket.
    await expect(viewer.getByText(/Analytics Dashboard 41/).first()).toBeVisible();
    await expect(
      viewer.getByText(/Load time 42 s exceeds the 30 s high threshold/).first(),
    ).toBeVisible();

    await adminContext.close();
    await viewerContext.close();
  });

  test('an owner is not told about a report that belongs to someone else', async ({ browser }) => {
    const adminContext = await browser.newContext();
    const ownerContext = await browser.newContext();
    const admin = await adminContext.newPage();
    const owner = await ownerContext.newPage();
    await signIn(admin, 'admin');
    await signInAsOwner(owner, 'user_7@company.com');
    await waitForLive(owner);

    // RPT_250 is not one of user_7's reports; RPT_230 is.
    await admin.goto('/reports/RPT_250');
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.getByRole('button', { name: /Latency spike/ }).click();
    await admin.goto('/reports/RPT_230');
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.getByRole('button', { name: /Latency spike/ }).click();

    await expect(owner.getByText(/Analytics Dashboard 31/).first()).toBeVisible();
    await expect(owner.getByText(/Analytics Dashboard 51/)).toHaveCount(0);

    await adminContext.close();
    await ownerContext.close();
  });
});

test.describe('orphan remediation', () => {
  test('assigning an owner removes the report from the queue and records it in the audit log', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/orphans');
    const rows = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: /Assign/ }) });
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    const reportId = (await rows.first().innerText()).match(/RPT_\d+/)![0];

    await rows
      .first()
      .getByRole('button', { name: /Assign/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('the last named owner in this report')).toBeVisible();
    await dialog.getByLabel(/Note/).fill('Confirmed with the team');
    await dialog.getByRole('button', { name: 'Assign owner' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(rows).toHaveCount(before - 1);
    await expect(page.getByText(reportId)).toHaveCount(0);

    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Audit log' }).click();
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: 'report.owner.assign' })
        .filter({ hasText: reportId }),
    ).toBeVisible();
  });
});

test.describe('cost and data quality', () => {
  test('the cost page reconciles and the data-quality page shows every check passing', async ({
    page,
  }) => {
    await signIn(page, 'finops');
    await page.goto('/costs');
    await expect(page.getByText('Where the metered credits went')).toBeVisible();
    await expect(page.getByText('Attribution methods, side by side')).toBeVisible();
    await expect(page.getByText('Chargeback by owner')).toBeVisible();

    await page.goto('/data-quality');
    await expect(page.getByText('16 / 16')).toBeVisible();
    await expect(page.getByText('Defects found by profiling')).toBeVisible();
    await page.getByText('refresh status unknown').click();
    await expect(page.getByRole('heading', { name: 'Findings for DQ-05' })).toBeVisible();
  });
});
