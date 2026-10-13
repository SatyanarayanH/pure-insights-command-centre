import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SSE_PATH } from '@picc/contracts';
import cookieParser from 'cookie-parser';
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
  Router,
} from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { API_PREFIX, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import type { Container } from './container.js';
import { buildAsyncApi } from './docs/asyncapi.js';
import { buildOpenApi } from './docs/openapi.js';
import { HttpError } from './http/errors.js';
import { mountRoutes, type RouteDefinition } from './http/registry.js';
import { buildRoutes } from './http/routes.js';
import { metricsHandler } from './metrics.js';

export interface App {
  app: Express;
  routes: RouteDefinition[];
}

export function createApp(c: Container): App {
  const { config, logger } = c;
  const app = express();
  app.disable('x-powered-by');
  // With no proxy in front, X-Forwarded-For is whatever the caller types, and believing it
  // would let anyone reset their own rate limit. Trust is opt-in: TRUST_PROXY=1 behind an ALB.
  app.set('trust proxy', config.trustProxy);

  // Request id first, so every log line and every error body can be correlated.
  const requestId: RequestHandler = (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  };
  app.use(requestId);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'ws:', 'wss:'],
          // No inline scripts anywhere. Inline styles are needed by the charts and Swagger UI.
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          // Only meaningful behind TLS. Left on, it breaks plain-HTTP runs on localhost in
          // browsers that upgrade same-origin asset requests.
          'upgrade-insecure-requests': config.forceHttps ? [] : null,
        },
      },
    }),
  );

  // CORS for split-origin development. In production the API serves the web app itself.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'authorization, content-type, x-api-key, x-request-id',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      const durationMs = performance.now() - started;
      // The route pattern, never the raw path: `/reports/:reportId` is one series, not one
      // per report, and a scanner probing random URLs cannot inflate the label set.
      const mounted = (req.route as { path?: unknown } | undefined)?.path;
      const route =
        typeof res.locals.routePattern === 'string'
          ? `${API_PREFIX}${res.locals.routePattern}`
          : typeof mounted === 'string'
            ? mounted
            : 'other';
      c.metrics.inc('picc_http_requests_total', 'HTTP requests by route pattern and status.', {
        method: req.method,
        route,
        status: res.statusCode,
      });
      c.metrics.observe(
        'picc_http_request_duration_seconds',
        'HTTP request duration by route pattern.',
        { method: req.method, route },
        durationMs / 1000,
      );
      if (req.path === '/metrics' || req.path === '/healthz') return;
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs),
          user: req.principal?.email,
        },
        'request',
      );
    });
    next();
  });

  // Liveness and readiness, unauthenticated, for the load balancer and the container runtime.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, version: SERVICE_VERSION });
  });
  app.get('/readyz', (_req, res) => {
    const passed = c.snapshot.reconciliation.every((r) => r.status !== 'FAIL');
    res.status(passed ? 200 : 503).json({
      status: passed ? 'ready' : 'degraded',
      warehouse: {
        dialect: c.snapshot.dialect,
        builtAt: c.snapshot.builtAt,
        reports: c.snapshot.dim.length,
      },
    });
  });

  registerGauges(c);
  app.get('/metrics', metricsHandler(config, c.metrics));

  const limited = config.env !== 'test';
  const limiter = (limit: number) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => !limited,
      // Same error shape as everything else, not the library's plain-text default.
      handler: (_req, _res, next) => {
        next(
          new HttpError(
            429,
            'rate_limited',
            'Too many requests',
            'Rate limit exceeded. Retry after the window resets.',
          ),
        );
      },
    });
  const apiLimiter = limiter(config.rateLimitPerMin);
  // Credential endpoints get a far tighter budget than the rest of the API.
  const authLimiter = limiter(20);

  const routes = buildRoutes(c);
  const api = Router();
  api.use('/auth/login', authLimiter);
  api.use('/auth/demo-login', authLimiter);
  mountRoutes(api, routes, {
    tokens: c.tokens,
    users: c.users,
    ingestApiKey: config.ingestApiKey,
    validateResponses: config.env !== 'production',
    logger,
  });

  app.get(SSE_PATH, c.gateway.handleSse);
  app.use(API_PREFIX, apiLimiter, api);

  // Specifications are served by the running system, generated from the code that is running.
  const openApi = buildOpenApi(routes);
  const asyncApi = buildAsyncApi();
  app.get('/openapi.json', (_req, res) => {
    res.json(openApi);
  });
  app.get('/asyncapi.json', (_req, res) => {
    res.json(asyncApi);
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApi, { customSiteTitle: 'Command Centre API' }),
  );

  app.use(API_PREFIX, (_req, _res, next) => {
    next(new HttpError(404, 'not_found', 'Not found', 'No such endpoint.'));
  });

  // The built web app, when present: one container serves both.
  if (existsSync(join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(
      /^(?!\/(api|ws|docs|openapi\.json|asyncapi\.json|healthz|readyz|metrics)).*/,
      (_req, res) => {
        res.sendFile(join(config.webDist, 'index.html'));
      },
    );
  }

  const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    const isBodyError =
      error instanceof SyntaxError || (error as { type?: string }).type === 'entity.too.large';
    const httpError =
      error instanceof HttpError
        ? error
        : isBodyError
          ? new HttpError(
              400,
              'bad_request',
              'Bad request',
              'The request body could not be read as JSON.',
            )
          : new HttpError(500, 'internal_error', 'Internal error', 'An unexpected error occurred.');
    if (httpError.status >= 500)
      logger.error({ err: error, requestId: req.requestId }, 'unhandled error');
    res
      .status(httpError.status)
      .type('application/problem+json')
      .send(JSON.stringify(httpError.toProblem(req.requestId)));
  };
  app.use(errorHandler);

  return { app, routes };
}

/** Values read from their owners at scrape time, so they are never stale. */
function registerGauges(c: Container): void {
  const m = c.metrics;
  m.gauge('picc_alerts_open', 'Open alerts by severity.', () =>
    Object.entries(c.alerts.openBySeverity()).map(([severity, value]) => ({
      labels: { severity },
      value,
    })),
  );
  m.gauge('picc_telemetry_events', 'Telemetry events since start, by outcome.', () =>
    Object.entries(c.telemetry.counts).map(([outcome, value]) => ({ labels: { outcome }, value })),
  );
  m.gauge('picc_telemetry_feed_silent', '1 when no telemetry is arriving from any report.', () =>
    c.staleness.isFeedSilent ? 1 : 0,
  );
  m.gauge(
    'picc_telemetry_last_received_timestamp_seconds',
    'When the last telemetry event was received. 0 if none since the readings were last pruned.',
    () => (c.telemetry.lastReceivedAt ? Date.parse(c.telemetry.lastReceivedAt) / 1000 : 0),
  );
  m.gauge('picc_realtime_connections', 'Open real-time connections by transport.', () => {
    const { webSocketClients, sseClients } = c.gateway.stats();
    return [
      { labels: { transport: 'websocket' }, value: webSocketClients },
      { labels: { transport: 'sse' }, value: sseClients },
    ];
  });
  m.gauge(
    'picc_realtime_latest_event_id',
    'Id of the newest event on the bus.',
    () => c.bus.latestId,
  );
  m.gauge('picc_notifications', 'Notifications by delivery status.', () =>
    Object.entries(c.notifications.stats()).map(([status, value]) => ({
      labels: { status },
      value,
    })),
  );
  m.gauge('picc_warehouse_reconciliation_checks', 'Reconciliation checks by result.', () => {
    const counts: Record<string, number> = { PASS: 0, WARN: 0, FAIL: 0 };
    for (const check of c.snapshot.reconciliation)
      counts[check.status] = (counts[check.status] ?? 0) + 1;
    return Object.entries(counts).map(([status, value]) => ({ labels: { status }, value }));
  });
  m.gauge(
    'picc_warehouse_built_timestamp_seconds',
    'When the warehouse snapshot in service was built.',
    () => Date.parse(c.snapshot.builtAt) / 1000 || 0,
  );
  m.gauge('picc_warehouse_refreshes', 'Warehouse refreshes since start, by outcome.', () =>
    Object.entries(c.warehouse.counts).map(([outcome, value]) => ({ labels: { outcome }, value })),
  );
}
