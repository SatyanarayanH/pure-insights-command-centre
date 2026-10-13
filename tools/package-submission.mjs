// Builds the upload: submission/pure-insights-command-centre.zip
// Source, docs, SQL and git history; no node_modules, build output or local state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = basename(root);
const outDir = join(root, 'submission');
const out = join(outDir, `${name}.zip`);

for (const required of [
  'docs/Technical-Specification.pdf',
  'docs/api/openapi.json',
  'sql/07_reconciliation_tests.sql',
  'README.md',
]) {
  if (!existsSync(join(root, required))) {
    console.error(`Missing ${required}. Run "npm run docs:generate && npm run docs:pdf" first.`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
rmSync(out, { force: true });
const exclude = [
  'node_modules/*',
  '*/node_modules/*',
  '*/dist/*',
  'data/generated/*',
  'data/runtime/*',
  'submission/*',
  'test-results/*',
  'playwright-report/*',
  '.env',
  '*.DS_Store',
  '*.tsbuildinfo',
].flatMap((pattern) => ['-x', `${name}/${pattern}`]);

// Zip from the parent so the archive unpacks into one tidy folder.
execFileSync('zip', ['-r', '-q', out, name, ...exclude], { cwd: dirname(root), stdio: 'inherit' });
console.log(`${out}  (${(statSync(out).size / 1_048_576).toFixed(1)} MB)`);
