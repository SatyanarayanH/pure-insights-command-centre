import { createServer } from 'node:http';
import { SSE_PATH } from '@picc/contracts';
import express from 'express';
import { type Config, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import type { Logger } from './logger.js';
import { Metrics, metricsHandler } from './metrics.js';
import { EventBus } from './realtime/bus.js';
import { DEFAULT_GATEWAY_OPTIONS, RealtimeGateway } from './realtime/gateway.js';
import { connectRedis, RedisEventLog, RedisTicketStore, whenReady } from './realtime/redis.js';

/**
 * A connection-only node. It holds WebSocket and SSE connections and delivers events; it has
 * no database, no warehouse and no business logic, so any number of them can run behind a load
 * balancer that sends `/ws` and `/api/v1/stream` here and everything else to the core.
 *
 * It can enforce the same access rules as the core without a database because everything those
 * rules need travels with the data: who the caller is, inside the ticket; who may see an
 * event, on the event.
 */
export async function startEdge(config: Config, logger: Logger): Promise<void> {
  if (!config.redisUrl) throw new Error('ROLE=edge needs REDIS_URL.');
  const redis = connectRedis(config.redisUrl);
  redis.on('error', (error) => logger.warn({ reason: error.message }, 'redis connection error'));
  await whenReady(redis, 15_000);

  const eventLog = new RedisEventLog(
    redis,
    (error, what) => logger.error({ err: error, what }, 'redis event log error'),
    config.redisPrefix,
  );
  const resume = await eventLog.load(2000);
  const bus = new EventBus(2000, undefined, resume);
  const gateway = new RealtimeGateway(
    bus,
    new RedisTicketStore(redis, config.redisPrefix),
    logger,
    {
      ...DEFAULT_GATEWAY_OPTIONS,
      allowedOrigins: config.corsOrigins,
      enforceOrigin: config.env === 'production',
    },
  );

  const metrics = new Metrics();
  metrics.gauge('picc_realtime_connections', 'Open real-time connections by transport.', () => {
    const { webSocketClients, sseClients } = gateway.stats();
    return [
      { labels: { transport: 'websocket' }, value: webSocketClients },
      { labels: { transport: 'sse' }, value: sseClients },
    ];
  });
  metrics.gauge(
    'picc_realtime_latest_event_id',
    'Id of the newest event received.',
    () => bus.latestId,
  );

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, version: SERVICE_VERSION, role: 'edge' });
  });
  app.get('/readyz', (_req, res) => {
    const ready = redis.status === 'ready';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      role: 'edge',
      redis: redis.status,
      streamId: bus.streamId,
      latestEventId: bus.latestId,
    });
  });
  app.get('/metrics', metricsHandler(config, metrics));
  app.get(SSE_PATH, gateway.handleSse);
  app.use((_req, res) => {
    res.status(404).type('application/problem+json').json({
      type: 'https://pure-insights.example/problems/not_found',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail: 'This node serves the real-time stream only.',
    });
  });

  const server = createServer(app);
  gateway.attach(server);
  eventLog.follow(bus, () => {
    logger.fatal('the event stream in redis was reset; exiting so the node restarts clean');
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, streamId: resume.streamId, resumedAfter: resume.lastId },
      'edge node listening',
    );
  });

  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled promise rejection'),
  );
  process.on('uncaughtException', (error) => logger.error({ err: error }, 'uncaught exception'));

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    eventLog.stop();
    gateway.close();
    metrics.close();
    server.close(() => {
      redis.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
