import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
// @ts-expect-error gifenc ships no type declarations
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { signIn, waitForLive } from './helpers';

// gifenc is CommonJS: its functions arrive on the default export.
const { applyPalette, GIFEncoder, quantize } = gifenc;

/** Records docs/demo.gif: a scripted tour ending in a live alert crossing two sessions.
 *  Runs only when asked: `npm run demo:gif`. */
test.describe('demo recording', () => {
  test.skip(!process.env.DEMO_GIF, 'set DEMO_GIF=1 to record docs/demo.gif');
  test.setTimeout(180_000);

  test('record the walkthrough', async ({ browser }) => {
    const size = { width: 1200, height: 720 };
    const gif = GIFEncoder();

    const caption = (page: Page, text: string) =>
      page.evaluate((message) => {
        let bar = document.getElementById('demo-caption');
        if (!bar) {
          bar = document.createElement('div');
          bar.id = 'demo-caption';
          bar.style.cssText =
            'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:14px 24px;background:#0b0b0b;color:#fff;font:600 17px system-ui,sans-serif;letter-spacing:-0.01em';
          document.body.appendChild(bar);
          // Lift toasts clear of the caption bar.
          const style = document.createElement('style');
          style.textContent = '[aria-live="polite"] { bottom: 68px !important; }';
          document.head.appendChild(style);
        }
        bar.textContent = message;
      }, text);

    /** Adds the page as one frame shown for `ms` milliseconds. */
    const frame = async (page: Page, ms: number) => {
      const png = PNG.sync.read(await page.screenshot());
      const palette = quantize(png.data, 256);
      gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, {
        palette,
        delay: ms,
      });
    };

    const adminContext = await browser.newContext({ viewport: size });
    const viewerContext = await browser.newContext({ viewport: size });
    const admin = await adminContext.newPage();
    const viewer = await viewerContext.newPage();
    await signIn(admin, 'admin');
    await signIn(viewer, 'viewer');
    await waitForLive(viewer);

    // 1. What a viewer sees.
    await expect(viewer.getByText('Health over 20 periods')).toBeVisible();
    await caption(
      viewer,
      'Signed in as Viewer: system health only. No cost figures, owner emails masked.',
    );
    await viewer.waitForTimeout(700);
    await frame(viewer, 3200);

    // 2. An admin, in a different session, breaks a report. The viewer never reloads.
    await viewer.getByText('Live activity').scrollIntoViewIfNeeded();
    await caption(
      viewer,
      'In another session, an admin injects a 42-second load on Analytics Dashboard 41...',
    );
    await frame(viewer, 2400);
    await admin.goto('/reports/RPT_240');
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.getByRole('button', { name: 'Recovery' }).click();
    await admin.waitForTimeout(400);
    await admin.getByRole('button', { name: /Latency spike/ }).click();
    for (let i = 0; i < 6; i++) {
      await viewer.waitForTimeout(140);
      await frame(viewer, 160);
    }
    await expect(viewer.getByText(/Load time 42 s exceeds/).first()).toBeVisible();
    await caption(viewer, '...and the alert reaches the viewer over WebSocket within a second.');
    await frame(viewer, 3600);
    if (process.env.DEMO_KEYFRAME) await viewer.screenshot({ path: process.env.DEMO_KEYFRAME });

    // 3. The same breach again updates the alert instead of opening another.
    await admin.getByRole('button', { name: /Latency spike/ }).click();
    await admin.getByRole('button', { name: /Latency spike/ }).click();
    await admin.waitForTimeout(900);
    await admin.reload();
    await admin.getByText('Open alerts').scrollIntoViewIfNeeded();
    await expect(admin.getByRole('cell', { name: /Load time 42 s exceeds/ })).toBeVisible();
    await caption(
      admin,
      'Still one alert: repeat breaches raise its count instead of opening new alerts.',
    );
    await frame(admin, 3600);

    // 4. Orphaned reports, ranked by cost, with a suggested owner.
    await admin.goto('/orphans');
    await expect(admin.getByText('Remediation queue')).toBeVisible();
    await caption(
      admin,
      'Admin: 14 reports with no owner, ranked by monthly cost at risk, each with a suggested owner.',
    );
    await admin.waitForTimeout(500);
    await frame(admin, 3400);
    await admin
      .getByRole('button', { name: /Assign/ })
      .first()
      .click();
    await expect(admin.getByRole('dialog')).toBeVisible();
    await caption(
      admin,
      "Assigning is audited, broadcast, and re-routes the report's open alerts to the new owner.",
    );
    await frame(admin, 3000);
    await admin.getByRole('button', { name: 'Assign owner' }).click();
    await expect(admin.getByRole('dialog')).toHaveCount(0);
    await admin.waitForTimeout(600);
    await frame(admin, 2600);

    // 5. Cost attribution that reconciles.
    await admin.goto('/costs');
    await expect(admin.getByText('Unit economics by report')).toBeVisible();
    await admin.getByText('Where the metered credits went').scrollIntoViewIfNeeded();
    await caption(
      admin,
      'Cost: every metered Snowflake credit lands in one line. Three attribution methods, cross-checked.',
    );
    await admin.waitForTimeout(600);
    await frame(admin, 4200);

    // 6. Data quality and reconciliation.
    await admin.goto('/data-quality');
    await expect(admin.getByText('16 / 16')).toBeVisible();
    await caption(
      admin,
      'Data quality: 2,000 rows are 100 reports x 20 periods. 16 of 16 reconciliation checks pass.',
    );
    await admin.waitForTimeout(500);
    await frame(admin, 4200);

    gif.finish();
    writeFileSync('docs/demo.gif', gif.bytes());
    await adminContext.close();
    await viewerContext.close();
  });
});
