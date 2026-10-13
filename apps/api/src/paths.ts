import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Walks up from this module until it finds the repository root (the folder holding the SQL
 *  suite), so paths resolve the same from `src/` under tsx and from the bundled `dist/`. */
function findRepoRoot(): string {
  if (process.env.PICC_ROOT) return resolve(process.env.PICC_ROOT);
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'sql', '00_setup.sql'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the repository root (no sql/00_setup.sql found).');
}

export const REPO_ROOT = findRepoRoot();
export const SQL_DIR = join(REPO_ROOT, 'sql');
export const DOCS_DIR = join(REPO_ROOT, 'docs');
export const DEFAULT_RAW_CSV = join(
  REPO_ROOT,
  'data',
  'raw',
  'Case_Study_3_Pure_Insights_Monitoring.csv',
);
export const DEFAULT_GENERATED_DIR = join(REPO_ROOT, 'data', 'generated');
export const DEFAULT_RUNTIME_DIR = join(REPO_ROOT, 'data', 'runtime');
export const DEFAULT_WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
