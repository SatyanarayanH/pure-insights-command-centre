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

export interface App {
  app: Express;
  routes: RouteDefinition[];
}

export function createApp(c: Container): App {
  const { config, logger } = c;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

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
          // Swagger UI ships inline styles and an inline bootstrap script.
          'script-src': ["'self'", "'unsafe-inline'"],
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
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
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
    const passed = c.snapshot.reconciliation.every((r) => r.status === 'PASS');
    res.status(passed ? 200 : 503).json({
      status: passed ? 'ready' : 'degraded',
      warehouse: {
        dialect: c.snapshot.dialect,
        builtAt: c.snapshot.builtAt,
        reports: c.snapshot.dim.length,
      },
    });
  });

  const limited = config.env !== 'test';
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !limited,
  });
  // Credential endpoints get a far tighter budget than the rest of the API.
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !limited,
  });

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
    app.get(/^(?!\/(api|ws|docs|openapi\.json|asyncapi\.json|healthz|readyz)).*/, (_req, res) => {
      res.sendFile(join(config.webDist, 'index.html'));
    });
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
