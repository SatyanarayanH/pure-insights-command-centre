import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { createContainer } from './container.js';
import { createLogger } from './logger.js';
import { SQL_DIR } from './paths.js';
import { buildWarehouseSnapshot } from './warehouse/snapshot.js';

const config = loadConfig();
const logger = createLogger(config);

try {
  logger.info({ service: SERVICE_NAME, version: SERVICE_VERSION, env: config.env }, 'starting');

  // Nothing is served until the warehouse has been built and has reconciled.
  const snapshot = await buildWarehouseSnapshot({
    sqlDir: SQL_DIR,
    rawCsv: config.rawCsv,
    generatedDir: config.generatedDir,
    cache: true,
  });
  logger.info(
    {
      dialect: snapshot.dialect,
      fromCache: snapshot.fromCache,
      suiteDurationMs: snapshot.suiteDurationMs,
      reports: snapshot.dim.length,
      reportPeriods: snapshot.facts.length,
      reconciliationChecks: snapshot.reconciliation.length,
    },
    'warehouse ready',
  );

  const container = createContainer(config, snapshot, { logger });
  const { app, routes } = createApp(container);
  const server = createServer(app);
  container.gateway.attach(server);

  if (config.jwtSecretIsEphemeral) {
    logger.warn('JWT_SECRET is not set: using a random key for this process. Sessions will not survive a restart.');
  }
  if (config.demoMode) logger.warn('DEMO_MODE is on: one-click sign-in and incident injection are enabled.');

  server.listen(config.port, config.host, () => {
    logger.info({ port: config.port, routes: routes.length, docs: `http://localhost:${config.port}/docs` }, 'listening');
    if (config.simulatorEnabled) container.simulator.start();
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    container.simulator.stop();
    container.gateway.close();
    server.close(() => {
      container.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
