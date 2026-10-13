import { createServer } from 'node:http';
import type { Redis } from 'ioredis';
import { createApp } from './app.js';
import type { Config } from './config.js';
import { type ContainerOverrides, createContainer } from './container.js';
import type { Logger } from './logger.js';
import { EventBus } from './realtime/bus.js';
import { connectRedis, RedisEventLog, RedisTicketStore, whenReady } from './realtime/redis.js';
import { snapshotBuilderFor } from './warehouse/source.js';

/** The whole application: REST API, alert engine, both stores, and its own real-time gateway. */
export async function startCore(config: Config, logger: Logger): Promise<void> {
  // Nothing is served until the warehouse has been read and has reconciled.
  const snapshot = await snapshotBuilderFor(config)();
  const failed = snapshot.reconciliation.filter((check) => check.status === 'FAIL');
  if (failed.length > 0) {
    throw new Error(
      `The warehouse failed reconciliation: ${failed.map((check) => check.check_id).join(', ')}.`,
    );
  }
  logger.info(
    {
      source: config.warehouse,
      dialect: snapshot.dialect,
      fromCache: snapshot.fromCache,
      suiteDurationMs: snapshot.suiteDurationMs,
      reports: snapshot.dim.length,
      reportPeriods: snapshot.facts.length,
      reconciliationChecks: snapshot.reconciliation.length,
    },
    'warehouse ready',
  );

  // Optional Redis: the event stream and the stream tickets move out of this process, so they
  // survive its restart and can be shared with edge nodes.
  const overrides: ContainerOverrides = { logger };
  let redis: Redis | null = null;
  let eventLog: RedisEventLog | null = null;
  if (config.redisUrl) {
    redis = connectRedis(config.redisUrl);
    redis.on('error', (error) => logger.warn({ reason: error.message }, 'redis connection error'));
    await whenReady(redis);
    eventLog = new RedisEventLog(
      redis,
      (error, what) => logger.error({ err: error, what }, 'redis event log error'),
      config.redisPrefix,
    );
    const resume = await eventLog.load(2000);
    overrides.bus = new EventBus(2000, undefined, resume);
    overrides.tickets = new RedisTicketStore(redis, config.redisPrefix);
    eventLog.mirror(overrides.bus);
    logger.info(
      { streamId: resume.streamId, resumedAfter: resume.lastId, buffered: resume.records.length },
      'event stream is backed by redis',
    );
  }

  const container = createContainer(config, snapshot, overrides);
  if (eventLog) {
    const log = eventLog;
    container.metrics.gauge(
      'picc_redis_mirror_failures',
      'Events that could not be written to Redis; edge nodes did not receive them.',
      () => log.mirrorFailures,
    );
  }
  const { app, routes } = createApp(container);
  const server = createServer(app);
  container.gateway.attach(server);

  if (config.jwtSecretIsEphemeral) {
    logger.warn(
      'JWT_SECRET is not set: using a random key for this process. Sessions will not survive a restart.',
    );
  }
  if (config.demoMode)
    logger.warn('DEMO_MODE is on: one-click sign-in and incident injection are enabled.');

  server.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, routes: routes.length, docs: `http://localhost:${config.port}/docs` },
      'listening',
    );
    if (config.simulatorEnabled) container.simulator.start();
    container.startBackgroundWork();
  });

  // A bug in one request or one timer must be visible, and must not be the end of the process.
  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled promise rejection'),
  );
  process.on('uncaughtException', (error) => logger.error({ err: error }, 'uncaught exception'));

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    container.simulator.stop();
    container.gateway.close();
    server.close(() => {
      container.close();
      eventLog?.stop();
      redis?.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
