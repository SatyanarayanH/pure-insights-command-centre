import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { type PERSONA, signIn, signInAsOwner } from './helpers';

/**
 * A sweep of every page each role can reach, looking for the things a reviewer notices before
 * they read any code: errors in the console, failed requests, "NaN" or "undefined" on screen,
 * content wider than the window, and accessibility violations.
 */
const PAGES: Record<string, string[]> = {
  admin: [
    '/',
    '/reports',
    '/reports/RPT_201',
    '/orphans',
    '/alerts',
    '/costs',
    '/data-quality',
    '/admin',
  ],
  finops: ['/', '/reports', '/reports/RPT_233', '/orphans', '/alerts', '/costs', '/data-quality'],
  viewer: ['/', '/reports', '/reports/RPT_203', '/alerts'],
  owner: ['/', '/reports', '/reports/RPT_230', '/alerts', '/costs'],
};

/** A value that failed to render: a text node that is nothing but a broken token, or one that
 *  carries a unit. Prose that merely mentions "NaN" or "undefined" is not a defect. */
const BROKEN_VALUE =
  /^[-$]?(NaN|undefined|null|Infinity|Invalid Date|\[object Object\])%?( s| ms)?$|\$NaN|NaN%|NaN s\b|Invalid Date|\[object Object\]/;

interface Problems {
  console: string[];
  requests: string[];
}

function watch(page: Page): Problems {
  const problems: Problems = { console: [], requests: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') problems.console.push(message.text());
  });
  page.on('pageerror', (error) => problems.console.push(`uncaught: ${error.message}`));
  page.on('response', (response) => {
    const url = new URL(response.url());
    // The first call of a fresh page is a session restore; 401 there means "not signed in".
    if (response.status() >= 400 && !url.pathname.endsWith('/auth/refresh')) {
      problems.requests.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    }
  });
  return problems;
}

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  await page.waitForTimeout(350);
}

for (const [role, paths] of Object.entries(PAGES)) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${role}, ${scheme}: no errors, no broken text, no accessibility violations`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const problems = watch(page);
      if (role === 'owner') await signInAsOwner(page, 'user_7@company.com');
      else await signIn(page, role as keyof typeof PERSONA);

      const findings: string[] = [];
      for (const path of paths) {
        await page.goto(path);
        await settle(page);
        const broken = await page.locator('main').evaluate((main, source) => {
          const pattern = new RegExp(source);
          const hits: string[] = [];
          const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = (node.textContent ?? '').trim();
            if (text && pattern.test(text)) hits.push(text.slice(0, 60));
          }
          return hits;
        }, BROKEN_VALUE.source);
        for (const value of broken) findings.push(`${path}: renders a broken value "${value}"`);

        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        for (const violation of axe.violations) {
          findings.push(
            `${path}: a11y ${violation.impact} ${violation.id} x${violation.nodes.length} e.g. ${violation.nodes[0]?.html.slice(0, 110)}`,
          );
        }
      }
      expect([
        ...findings,
        ...problems.console.map((c) => `console: ${c}`),
        ...problems.requests.map((r) => `request: ${r}`),
      ]).toEqual([]);
    });
  }
}

test('sign-in page: accessible in both colour schemes', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByText('Demo personas')).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      axe.violations.map((v) => `${scheme}: ${v.impact} ${v.id} ${v.nodes[0]?.html.slice(0, 110)}`),
    ).toEqual([]);
  }
});

test('API explorer loads under the content security policy', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/docs/');
  await expect(
    page.getByRole('heading', { name: /Pure Insights Command Centre API/ }),
  ).toBeVisible();
  await expect(page.getByText('/api/v1/telemetry').first()).toBeVisible();
  expect(
    problems.console.filter((line) => /Content Security Policy|Refused to/i.test(line)),
  ).toEqual([]);
});

test('a first visit makes no failing request and logs nothing', async ({ page }) => {
  const problems = watch(page);
  const failed: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400)
      failed.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto('/');
  await expect(page.getByText('Demo personas')).toBeVisible();
  expect([...failed, ...problems.console]).toEqual([]);
});

for (const width of [390, 768, 1024]) {
  test(`layout holds at ${width}px: the page itself never scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await signIn(page, 'admin');
    const overflowing: string[] = [];
    for (const path of PAGES.admin!) {
      await page.goto(path);
      await settle(page);
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      if (scroll > client + 1)
        overflowing.push(`${path}: content ${scroll}px in a ${client}px window`);
    }
    expect(overflowing).toEqual([]);
  });
}
