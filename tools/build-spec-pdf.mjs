// Renders the technical specification (narrative + generated API reference) to one PDF.
//   npm run docs:pdf
// Uses the browser Playwright already has: installed Chrome locally, bundled Chromium in CI.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const read = (name) => readFileSync(join(docs, name), 'utf8');

const body = [
  read('Technical-Specification.md'),
  '<div class="page-break"></div>',
  read('api-reference.md').replace('# API reference', '# Appendix A: API reference'),
]
  .join('\n\n')
  .replace(/<!--[\s\S]*?-->/g, '');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pure Insights Command Centre: Technical Specification</title>
<base href="${pathToFileURL(docs).href}/">
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  body { font: 10.5pt/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; }
  h1 { font-size: 20pt; margin: 0 0 6pt; letter-spacing: -0.01em; }
  h2 { font-size: 14pt; margin: 20pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #ddd; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 14pt 0 4pt; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0 12pt; font-size: 8.8pt; }
  th, td { border: 1px solid #d5d5d0; padding: 3.5pt 5pt; text-align: left; vertical-align: top; }
  th { background: #f1f0ec; font-weight: 600; }
  tr { break-inside: avoid; }
  code { font: 8.8pt ui-monospace, "SF Mono", Menlo, monospace; background: #f1f0ec; padding: 0.5pt 3pt; border-radius: 3px; }
  pre { background: #f6f6f4; border: 1px solid #e1e0d9; border-radius: 6px; padding: 8pt 10pt; overflow-wrap: anywhere; white-space: pre-wrap; break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: 8.4pt; }
  img { max-width: 100%; margin: 6pt 0; }
  blockquote { margin: 8pt 0; padding: 4pt 12pt; border-left: 3px solid #2a78d6; background: #f3f7fd; color: #333; }
  a { color: #1c5cab; text-decoration: none; }
  .page-break { break-after: page; }
</style></head><body>${marked.parse(body, { gfm: true })}</body></html>`;

const htmlPath = join(docs, '.spec.html');
writeFileSync(htmlPath, html);
const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.pdf({
    path: join(docs, 'Technical-Specification.pdf'),
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="width:100%;font:7.5pt system-ui;color:#888;padding:0 16mm;display:flex;justify-content:space-between"><span>Pure Insights Command Centre · REST API and WebSocket Technical Specification</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
  console.log('written docs/Technical-Specification.pdf');
} finally {
  await browser.close();
  (await import('node:fs')).rmSync(htmlPath, { force: true });
}
