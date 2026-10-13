# Browser test run

`npm run test:e2e` (Playwright, Chromium) against the production build, 2026-10-13T16:55Z.

```
Running 24 tests using 1 worker
  -   1 [chromium] › e2e/demo-gif.spec.ts:17:3 › demo recording › record the walkthrough
  ✓   2 [chromium] › e2e/quality.spec.ts:59:5 › admin, light: no errors, no broken text, no accessibility violations
  ✓   3 [chromium] › e2e/quality.spec.ts:59:5 › admin, dark: no errors, no broken text, no accessibility violations
  ✓   4 [chromium] › e2e/quality.spec.ts:59:5 › finops, light: no errors, no broken text, no accessibility violations
  ✓   5 [chromium] › e2e/quality.spec.ts:59:5 › finops, dark: no errors, no broken text, no accessibility violations
  ✓   6 [chromium] › e2e/quality.spec.ts:59:5 › viewer, light: no errors, no broken text, no accessibility violations
  ✓   7 [chromium] › e2e/quality.spec.ts:59:5 › viewer, dark: no errors, no broken text, no accessibility violations
  ✓   8 [chromium] › e2e/quality.spec.ts:59:5 › owner, light: no errors, no broken text, no accessibility violations
  ✓   9 [chromium] › e2e/quality.spec.ts:59:5 › owner, dark: no errors, no broken text, no accessibility violations
  ✓  10 [chromium] › e2e/quality.spec.ts:99:1 › sign-in page: accessible in both colour schemes
  ✓  11 [chromium] › e2e/quality.spec.ts:111:1 › API explorer loads under the content security policy
  ✓  12 [chromium] › e2e/quality.spec.ts:123:1 › a first visit makes no failing request and logs nothing
  ✓  13 [chromium] › e2e/quality.spec.ts:136:3 › layout holds at 390px: the page itself never scrolls sideways
  ✓  14 [chromium] › e2e/quality.spec.ts:136:3 › layout holds at 768px: the page itself never scrolls sideways
  ✓  15 [chromium] › e2e/quality.spec.ts:136:3 › layout holds at 1024px: the page itself never scrolls sideways
  -  16 [chromium] › e2e/screenshots.spec.ts:8:3 › screenshots › capture the main pages
  ✓  17 [chromium] › e2e/smoke.spec.ts:5:3 › role-based access in the browser › admin sees every section
  ✓  18 [chromium] › e2e/smoke.spec.ts:22:3 › role-based access in the browser › finops sees cost and data quality but no admin section and no write actions
  ✓  19 [chromium] › e2e/smoke.spec.ts:35:3 › role-based access in the browser › viewer sees health only: no cost anywhere, masked emails, no restricted pages
  ✓  20 [chromium] › e2e/smoke.spec.ts:52:3 › role-based access in the browser › report owner sees only their own reports
  ✓  21 [chromium] › e2e/smoke.spec.ts:67:3 › real-time alerting across two sessions › an injected latency spike reaches another signed-in user within moments
  ✓  22 [chromium] › e2e/smoke.spec.ts:94:3 › real-time alerting across two sessions › an owner is not told about a report that belongs to someone else
  ✓  23 [chromium] › e2e/smoke.spec.ts:122:3 › orphan remediation › assigning an owner removes the report from the queue and records it in the audit log
  ✓  24 [chromium] › e2e/smoke.spec.ts:159:3 › cost and data quality › the cost page reconciles and the data-quality page shows every check passing
  2 skipped
  22 passed (1.7m)
```
