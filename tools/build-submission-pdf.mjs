// Builds the single PDF the submission form accepts (one file, 1 MB at most):
//   Part A  summary of the work, with screenshots
//   Part B  the REST API and WebSocket technical specification, in full
//   Part C  the Snowflake cost allocation SQL suite, in full
//
//   REPO_URL=https://github.com/<user>/pure-insights-command-centre npm run submission:pdf
//
// Without REPO_URL it writes a DRAFT file, so a PDF with no repository link cannot be
// uploaded by mistake.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { marked } from 'marked';

const MAX_BYTES = 1_000_000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const repoUrl = (process.env.REPO_URL ?? '')
  .trim()
  .replace(/\/$/, '')
  .replace(/\.git$/, '');
const isDraft = repoUrl === '';
if (!isDraft && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoUrl)) {
  console.error('REPO_URL must look like https://github.com/<user>/<repository>');
  process.exit(2);
}

const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
try {
  // Screenshots are PNG in the repository; here they are re-encoded small enough to fit the limit.
  const shotPage = await browser.newPage({
    viewport: { width: 980, height: 640 },
    deviceScaleFactor: 1,
  });
  const shot = async (name) => {
    // Loaded through a real file:// page: a page made with setContent has no origin and is
    // not allowed to read local images.
    const holder = join(docs, 'screenshots', '.holder.html');
    writeFileSync(
      holder,
      `<body style="margin:0"><img src="${name}.png" style="width:980px;display:block"></body>`,
    );
    await shotPage.goto(pathToFileURL(holder).href, { waitUntil: 'load' });
    const loaded = await shotPage.evaluate(() => document.images[0].naturalWidth > 0);
    rmSync(holder, { force: true });
    if (!loaded) throw new Error(`screenshot ${name}.png did not load`);
    const jpeg = await shotPage.screenshot({
      type: 'jpeg',
      quality: 62,
      clip: { x: 0, y: 0, width: 980, height: 640 },
    });
    return `<img alt="${name}" src="data:image/jpeg;base64,${jpeg.toString('base64')}">`;
  };

  let summary = read('docs', 'Submission.md')
    .replaceAll(
      '{{REPO_LINK}}',
      isDraft ? '**not set: this is a draft**' : `[${repoUrl}](${repoUrl})`,
    )
    .replaceAll('{{REPO_URL}}', isDraft ? '<repository url>' : `${repoUrl}.git`);
  const shots = [...summary.matchAll(/!\[[^\]]*\]\(shot:([\w-]+?)(?:-top)?\)/g)];
  for (const match of shots) {
    const tag = await shot(match[1]);
    // A function replacement, so nothing in the base64 can be read as a `$` pattern.
    summary = summary.replace(match[0], () => `\n${tag}\n`);
  }
  await shotPage.close();

  const spec = read('docs', 'Technical-Specification.md')
    .replace(
      /^# Pure Insights Command Centre\n+## REST API and WebSocket Technical Specification/,
      '# Part B: REST API and WebSocket Technical Specification',
    )
    .replace(/<!--[\s\S]*?-->/g, '');
  const reference = read('docs', 'api-reference.md')
    .replace('# API reference', '## Appendix A: API reference')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^## (?!Appendix)/gm, '### ')
    .replace(
      /^### (Auth|Real-time|Reports|Ownership|Alerts|Telemetry|Cost|Data quality|Admin|System)$/gm,
      '#### $1',
    );

  const sqlFiles = [
    '00_setup.sql',
    'loaders/duckdb_load.sql',
    'loaders/snowflake_load.sql',
    '01_staging_clean.sql',
    '02_attribution_direct.sql',
    '03_attribution_time_weighted.sql',
    '04_unit_economics.sql',
    '05_chargeback.sql',
    '06_cost_anomalies.sql',
    '07_reconciliation_tests.sql',
  ];
  const escape = (text) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const sqlIntro = read('sql', 'README.md')
    .replace(
      '# Snowflake Cloud Cost Allocation SQL Suite',
      '# Part C: Snowflake Cloud Cost Allocation SQL Suite',
    )
    .replace(/\]\(\.\.\/docs\/[^)]*\)/g, ']')
    .replace(/\[([^\]]+)\](?!\()/g, '$1')
    .replace(/\(#running-on-snowflake\)/g, '');
  const sqlListing = sqlFiles
    .map(
      (file) =>
        `<h3 class="sqlfile">sql/${file}</h3><pre class="sql"><code>${escape(read('sql', file).trimEnd())}</code></pre>`,
    )
    .join('\n');

  const body = [
    isDraft
      ? '<div class="draft">DRAFT: the repository link is not set. Rebuild with REPO_URL before uploading.</div>'
      : '',
    marked.parse(summary, { gfm: true }),
    '<div class="page-break"></div>',
    marked.parse(spec, { gfm: true }),
    marked.parse(reference, { gfm: true }),
    '<div class="page-break"></div>',
    marked.parse(sqlIntro, { gfm: true }),
    '<h2>The scripts</h2>',
    sqlListing,
  ].join('\n');

  // Core PDF fonts keep the file small: nothing has to be embedded in bulk.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pure Insights Command Centre: Case Study 3 submission</title>
<base href="${pathToFileURL(docs).href}/"><style>
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body { font: 10pt/1.45 Helvetica, Arial, sans-serif; color: #111; }
  h1 { font-size: 19pt; margin: 0 0 6pt; break-after: avoid; }
  h2 { font-size: 13.5pt; margin: 16pt 0 5pt; padding-bottom: 2pt; border-bottom: 1px solid #ddd; break-after: avoid; }
  h3 { font-size: 11pt; margin: 12pt 0 4pt; break-after: avoid; }
  h4 { font-size: 10pt; margin: 10pt 0 3pt; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  ul, ol { padding-left: 16pt; margin: 4pt 0; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 8.4pt; }
  th, td { border: 1px solid #d5d5d0; padding: 3pt 4.5pt; text-align: left; vertical-align: top; }
  th { background: #f1f0ec; }
  tr { break-inside: avoid; }
  code { font: 8.4pt Courier, monospace; background: #f1f0ec; padding: 0 2pt; }
  pre { background: #f6f6f4; border: 1px solid #e1e0d9; padding: 6pt 8pt; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: 8pt; }
  pre.sql { break-inside: auto; font-size: 6.6pt; line-height: 1.28; padding: 5pt 7pt; }
  pre.sql code { font-size: 6.6pt; }
  h3.sqlfile { font-family: Courier, monospace; margin-top: 14pt; }
  img { max-width: 100%; margin: 5pt 0; border: 1px solid #e1e0d9; }
  blockquote { margin: 8pt 0; padding: 5pt 11pt; border-left: 3px solid #2a78d6; background: #f3f7fd; }
  blockquote p { margin: 3pt 0; }
  a { color: #1c5cab; text-decoration: none; }
  .page-break { break-after: page; }
  .draft { background: #d03b3b; color: #fff; font-weight: bold; padding: 8pt 10pt; margin-bottom: 10pt; }
</style></head><body>${body}</body></html>`;

  const htmlPath = join(docs, '.submission.html');
  writeFileSync(htmlPath, html);
  const outDir = join(root, 'submission');
  mkdirSync(outDir, { recursive: true });
  const out = join(
    outDir,
    isDraft ? 'DRAFT-Case_Study_3_Satyanarayan_H.pdf' : 'Case_Study_3_Satyanarayan_H.pdf',
  );
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="width:100%;font:7pt Helvetica;color:#888;padding:0 15mm;display:flex;justify-content:space-between"><span>Pure Insights Command Centre · Case Study 3 · Satyanarayan H</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
  rmSync(htmlPath, { force: true });
  const bytes = statSync(out).size;
  console.log(
    `${out}\n${(bytes / 1000).toFixed(0)} KB of ${MAX_BYTES / 1000} KB allowed${isDraft ? '  (DRAFT: set REPO_URL)' : ''}`,
  );
  if (bytes > MAX_BYTES) {
    console.error('Too large for the form. Lower the screenshot quality or drop a screenshot.');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
