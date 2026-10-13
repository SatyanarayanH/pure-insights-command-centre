import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { createLogger } from './logger.js';
import { REPO_ROOT } from './paths.js';

// A .env file in the repository root is honoured. It never overrides the real environment.
const envFile = join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const logger = createLogger(config);

try {
  logger.info(
    { service: SERVICE_NAME, version: SERVICE_VERSION, env: config.env, role: config.role },
    'starting',
  );
  // Loaded on demand: an edge node never touches the warehouse or the database drivers.
  if (config.role === 'edge') await (await import('./edge.js')).startEdge(config, logger);
  else await (await import('./core.js')).startCore(config, logger);
} catch (error) {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
