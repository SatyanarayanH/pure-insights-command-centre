/** Writes the generated documentation: OpenAPI, AsyncAPI, the API reference and the
 *  data-quality report. `--check` exits non-zero if any committed file is out of date. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createContainer } from '../container.js';
import { buildAsyncApi } from '../docs/asyncapi.js';
import { buildApiReference, buildDataQualityReport } from '../docs/markdown.js';
import { buildOpenApi } from '../docs/openapi.js';
import { DOCS_DIR, REPO_ROOT, SQL_DIR } from '../paths.js';
import { buildWarehouseSnapshot } from '../warehouse/snapshot.js';

const check = process.argv.includes('--check');
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  OPS_DB: ':memory:',
  SIMULATOR_ENABLED: 'false',
});
const snapshot = await buildWarehouseSnapshot({
  sqlDir: SQL_DIR,
  rawCsv: config.rawCsv,
  generatedDir: config.generatedDir,
  cache: true,
});
const container = createContainer(config, snapshot);
const { routes } = createApp(container);

const files: Record<string, string> = {
  [join(DOCS_DIR, 'api', 'openapi.json')]: `${JSON.stringify(buildOpenApi(routes), null, 2)}\n`,
  [join(DOCS_DIR, 'api', 'asyncapi.json')]: `${JSON.stringify(buildAsyncApi(), null, 2)}\n`,
  [join(DOCS_DIR, 'api-reference.md')]: buildApiReference(routes),
  [join(DOCS_DIR, 'data-quality-report.md')]: buildDataQualityReport(snapshot),
};
container.close();

let stale = 0;
for (const [path, content] of Object.entries(files)) {
  const name = relative(REPO_ROOT, path);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) {
    console.log(`up to date  ${name}`);
  } else if (check) {
    stale += 1;
    console.error(`STALE       ${name}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`written     ${name}`);
  }
}
if (stale > 0) {
  console.error(`${stale} generated file(s) are out of date. Run: npm run docs:generate`);
  process.exitCode = 1;
}
