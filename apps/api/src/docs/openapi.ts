import {
  PERMISSIONS,
  ProblemSchema,
  ROLE_DEFINITIONS,
  ROLES,
  SSE_PATH,
  WS_PATH,
} from '@picc/contracts';
import type { z } from 'zod';
import { API_PREFIX, SERVICE_VERSION } from '../config.js';
import type { RouteDefinition } from '../http/registry.js';
import { type Json, jsonSchemaOf, sortKeys } from './json-schema.js';

/** `/reports/:reportId` -> `/reports/{reportId}` */
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function parameters(route: RouteDefinition, components: Record<string, unknown>): Json[] {
  const out: Json[] = [];
  const add = (schema: z.ZodType | undefined, location: 'path' | 'query') => {
    if (!schema) return;
    const json = jsonSchemaOf(schema, 'input', components) as {
      properties?: Record<string, Json>;
      required?: string[];
    };
    for (const [name, property] of Object.entries(json.properties ?? {})) {
      const { description, ...rest } = property as Json & { description?: string };
      out.push({
        name,
        in: location,
        required: location === 'path' || (json.required ?? []).includes(name),
        ...(description ? { description } : {}),
        schema: rest,
      });
    }
  };
  add(route.params, 'path');
  add(route.query, 'query');
  return out;
}

const problem = (description: string): Json => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

/** Builds the OpenAPI 3.1 document from the route registry: one operation per mounted route. */
export function buildOpenApi(routes: readonly RouteDefinition[]): Json {
  const components: Record<string, unknown> = {};
  jsonSchemaOf(ProblemSchema, 'output', components);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const security =
      route.auth === 'public'
        ? []
        : route.auth === 'user-or-service'
          ? [{ apiKey: [] }, { bearerAuth: [] }]
          : [{ bearerAuth: [] }];
    const roles = route.permission
      ? ROLES.filter((role) => ROLE_DEFINITIONS[role].permissions.includes(route.permission!))
      : [];
    const access = [
      route.auth === 'public' ? 'Public.' : null,
      route.permission
        ? `Requires permission \`${route.permission}\` (roles: ${roles.map((r) => ROLE_DEFINITIONS[r].label).join(', ')}).`
        : null,
      route.rowScoped ? 'Row-level security: Report Owners only see their own reports.' : null,
    ].filter(Boolean);

    const responses: Record<string, unknown> = {
      [String(route.status ?? 200)]: {
        description: 'Success',
        content: {
          'application/json': { schema: jsonSchemaOf(route.response, 'output', components) },
        },
      },
    };
    if (route.params || route.query || route.body)
      responses['400'] = problem('The request failed validation.');
    if (route.auth !== 'public')
      responses['401'] = problem('Missing, invalid or expired credentials.');
    if (route.permission) responses['403'] = problem('The caller lacks the required permission.');
    if (route.params)
      responses['404'] = problem("Not found, or outside the caller's row-level scope.");
    if (route.method !== 'get')
      responses['409'] = problem('The request conflicts with the current state.');
    responses['429'] = problem('Rate limit exceeded.');

    const operation: Json = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      description: [route.description, ...access].filter(Boolean).join('\n\n'),
      security,
      parameters: parameters(route, components),
      responses,
      ...(route.permission
        ? { 'x-required-permission': route.permission, 'x-allowed-roles': roles }
        : {}),
      ...(route.rowScoped ? { 'x-row-level-security': true } : {}),
    };
    if (route.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchemaOf(route.body, 'input', components) } },
      };
    }
    const path = `${API_PREFIX}${toOpenApiPath(route.path)}`;
    paths[path] ??= {};
    paths[path][route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Pure Insights Command Centre API',
      version: SERVICE_VERSION,
      description: [
        'REST API for the Pure Insights Command Centre: report health, ownership, alerting and Snowflake cost attribution.',
        '',
        'This document is generated from the route registry in `apps/api/src/http/routes.ts`. Each operation is the same object that mounts the handler, validates the request and enforces the permission, so the specification cannot describe an endpoint that does not exist or omit one that does.',
        '',
        `Real-time events are delivered over WebSocket (\`${WS_PATH}\`) and Server-Sent Events (\`${SSE_PATH}\`); see the AsyncAPI document.`,
        '',
        'Errors use RFC 9457 `application/problem+json`.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [
      { name: 'Auth', description: 'Sign-in, session refresh and the current user.' },
      { name: 'Real-time', description: 'Tickets for the WebSocket and SSE streams.' },
      { name: 'Reports', description: 'System health and the report catalogue.' },
      { name: 'Ownership', description: 'Orphaned reports and owner assignment.' },
      { name: 'Alerts', description: 'Alert lifecycle and rules.' },
      { name: 'Telemetry', description: 'Ingest endpoint for the portal.' },
      { name: 'Cost', description: 'Snowflake credit attribution, unit economics and chargeback.' },
      { name: 'Data quality', description: 'Rules, findings, quarantine and reconciliation.' },
      { name: 'Admin', description: 'Users, audit log, simulator and incident injection.' },
      { name: 'System', description: 'Service status.' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token from `/auth/login`.',
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Service key for the telemetry emitter.',
        },
      },
      schemas: sortKeys(components),
    },
    'x-rbac': {
      permissions: PERMISSIONS,
      roles: Object.fromEntries(
        ROLES.map((role) => [
          role,
          {
            label: ROLE_DEFINITIONS[role].label,
            scope: ROLE_DEFINITIONS[role].scope,
            permissions: ROLE_DEFINITIONS[role].permissions,
          },
        ]),
      ),
    },
  };
}
