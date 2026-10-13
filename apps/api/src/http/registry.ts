import type { Permission } from '@picc/contracts';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import { safeEqual } from '../auth/passwords.js';
import { can, type Principal, SERVICE_PRINCIPAL, userPrincipal } from '../auth/principal.js';
import type { TokenService } from '../auth/tokens.js';
import type { Logger } from '../logger.js';
import type { UserRepository } from '../opsdb/repositories.js';
import { badRequest, forbidden, HttpError, unauthorized } from './errors.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';
export type AuthMode = 'public' | 'user' | 'user-or-service';

export interface RouteContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  /** Always set unless the route is `public`. */
  principal: Principal;
  requestId: string;
  req: Request;
  res: Response;
}

/**
 * One declaration per endpoint. The same object mounts the Express handler, validates the
 * request, enforces the permission, validates the response against its schema and generates
 * the OpenAPI operation. The specification cannot drift from the code because it is the code.
 */
export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  auth: AuthMode;
  permission?: Permission;
  /** True when results are filtered to the caller's own reports (row-level security). */
  rowScoped?: boolean;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  status?: number;
  handler: (ctx: RouteContext<never, never, never>) => unknown;
}

export function defineRoute<P = unknown, Q = unknown, B = unknown, R = unknown>(
  def: Omit<RouteDefinition, 'params' | 'query' | 'body' | 'response' | 'handler'> & {
    params?: z.ZodType<P>;
    query?: z.ZodType<Q>;
    body?: z.ZodType<B>;
    response: z.ZodType<R>;
    handler: (ctx: RouteContext<P, Q, B>) => R | Promise<R>;
  },
): RouteDefinition {
  return def as unknown as RouteDefinition;
}

export interface RouteDeps {
  tokens: TokenService;
  users: UserRepository;
  ingestApiKey: string;
  validateResponses: boolean;
  logger: Logger;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    principal?: Principal;
  }
}

async function authenticate(
  req: Request,
  mode: AuthMode,
  deps: RouteDeps,
): Promise<Principal | undefined> {
  if (mode === 'public') return undefined;

  if (mode === 'user-or-service') {
    const apiKey = req.get('x-api-key');
    if (apiKey) {
      if (!safeEqual(apiKey, deps.ingestApiKey)) throw unauthorized('Invalid API key.');
      return SERVICE_PRINCIPAL;
    }
  }

  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  const claims = await deps.tokens.verifyAccessToken(token);
  if (!claims) throw unauthorized('The access token is invalid or has expired.');
  // Role and existence come from the database, not the token: a demoted or deleted user loses
  // access on the next request, not when the token happens to expire.
  const user = deps.users.findById(claims.sub);
  if (!user) throw unauthorized('The account no longer exists.');
  return userPrincipal(user);
}

function parse<T>(schema: z.ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return value as T;
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw badRequest(
    `Invalid ${where}.`,
    result.error.issues.map((issue) => ({
      path: [where, ...issue.path].join('.'),
      message: issue.message,
    })),
  );
}

export function toHandler(route: RouteDefinition, deps: RouteDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // For metrics: the pattern, set here because Express forgets where a request was mounted
    // by the time an error has travelled out to the error handler.
    res.locals.routePattern = route.path;
    try {
      const principal = await authenticate(req, route.auth, deps);
      req.principal = principal;
      if (route.permission && (!principal || !can(principal, route.permission))) {
        throw forbidden(`This action requires the "${route.permission}" permission.`);
      }
      const result = await route.handler({
        params: parse(route.params, req.params, 'path'),
        query: parse(route.query, req.query, 'query'),
        body: parse(route.body, req.body, 'body'),
        principal: principal as Principal,
        requestId: req.requestId ?? '',
        req,
        res,
      } as RouteContext<never, never, never>);

      if (deps.validateResponses) {
        const checked = route.response.safeParse(result);
        if (!checked.success) {
          deps.logger.error(
            { operationId: route.operationId, issues: checked.error.issues },
            'response violates its contract',
          );
          throw new HttpError(
            500,
            'response_contract_violation',
            'Internal error',
            `${route.operationId} produced a response that does not match its schema.`,
          );
        }
      }
      res.status(route.status ?? 200).json(result);
    } catch (error) {
      next(error);
    }
  };
}

export function mountRoutes(
  router: Router,
  routes: readonly RouteDefinition[],
  deps: RouteDeps,
): void {
  for (const route of routes) {
    router[route.method](route.path, toHandler(route, deps));
  }
}
