// Deletes local runtime state (alerts, sessions, audit log) and the cached warehouse.
// The next start rebuilds both from the dataset.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const path of ['data/runtime', 'data/generated']) {
  rmSync(join(root, path), { recursive: true, force: true });
  console.log(`removed ${path}`);
}
