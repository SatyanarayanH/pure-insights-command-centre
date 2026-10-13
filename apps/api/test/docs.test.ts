import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SERVER_EVENT_TYPES } from '@picc/contracts';
import request from 'supertest';
import { API_PREFIX } from '../src/config.js';
import { buildAsyncApi } from '../src/docs/asyncapi.js';
import { buildApiReference, buildDataQualityReport } from '../src/docs/markdown.js';
import { buildOpenApi } from '../src/docs/openapi.js';
import { DOCS_DIR } from '../src/paths.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
before(async () => {
  ctx = await createTestContext();
});
after(() => ctx.close());

// biome-ignore lint/suspicious/noExplicitAny: specification documents are navigated structurally
type Json = Record<string, any>;

/** Every `$ref` in a document must point at something that exists in it. */
function danglingRefs(doc: Json): string[] {
  const missing: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          const target = value
            .replace(/^#\//, '')
            .split('/')
            .reduce<unknown>((at, part) => (at as Json | undefined)?.[part], doc);
          if (target === undefined) missing.push(value);
        } else walk(value);
      }
    }
  };
  walk(doc);
  return missing;
}

describe('OpenAPI document', () => {
  it('has exactly one operation per mounted route, with its permission', () => {
    const doc = buildOpenApi(ctx.routes) as Json;
    assert.equal(doc.openapi, '3.1.0');
    const operations = Object.values(doc.paths as Json).flatMap((p) => Object.values(p as Json));
    assert.equal(operations.length, ctx.routes.length);
    for (const route of ctx.routes) {
      const path = `${API_PREFIX}${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
      const operation = doc.paths[path]?.[route.method];
      assert.ok(operation, `${route.method} ${path}`);
      assert.equal(operation.operationId, route.operationId);
      assert.equal(operation['x-required-permission'], route.permission);
      assert.equal(operation.security.length === 0, route.auth === 'public');
    }
    assert.equal(
      new Set(ctx.routes.map((r) => r.operationId)).size,
      ctx.routes.length,
      'operation ids are unique',
    );
  });

  it('has no dangling references and documents every path parameter', () => {
    const doc = buildOpenApi(ctx.routes) as Json;
    assert.deepEqual(danglingRefs(doc), []);
    for (const [path, item] of Object.entries(doc.paths as Json)) {
      const expected = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const operation of Object.values(item as Json)) {
        const declared = (operation.parameters as Json[])
          .filter((p) => p.in === 'path')
          .map((p) => p.name);
        assert.deepEqual(declared.sort(), expected.sort(), path);
      }
    }
  });

  it('is served by the running application and matches the committed file', async () => {
    const served = await request(ctx.app).get('/openapi.json');
    assert.equal(served.status, 200);
    const committed = JSON.parse(readFileSync(join(DOCS_DIR, 'api', 'openapi.json'), 'utf8'));
    assert.deepEqual(
      served.body,
      committed,
      'docs/api/openapi.json is stale: run npm run docs:generate',
    );
  });
});

describe('AsyncAPI document', () => {
  it('describes every server event and client message, with no dangling references', () => {
    const doc = buildAsyncApi() as Json;
    assert.equal(doc.asyncapi, '3.0.0');
    const names = Object.values(doc.components.messages as Json).map((m) => (m as Json).name);
    for (const type of SERVER_EVENT_TYPES) assert.ok(names.includes(type), type);
    for (const type of ['ping', 'subscribe', 'unsubscribe']) assert.ok(names.includes(type), type);
    assert.deepEqual(danglingRefs(doc), []);
    assert.ok(
      doc.channels.events.address === '/ws' && doc.channels.eventsSse.address === '/api/v1/stream',
    );
  });

  it('matches the committed file', async () => {
    const served = await request(ctx.app).get('/asyncapi.json');
    const committed = JSON.parse(readFileSync(join(DOCS_DIR, 'api', 'asyncapi.json'), 'utf8'));
    assert.deepEqual(
      served.body,
      committed,
      'docs/api/asyncapi.json is stale: run npm run docs:generate',
    );
  });
});

describe('generated markdown', () => {
  it('keeps the committed API reference and data-quality report in step with the code', () => {
    assert.equal(
      readFileSync(join(DOCS_DIR, 'api-reference.md'), 'utf8'),
      buildApiReference(ctx.routes),
      'docs/api-reference.md is stale: run npm run docs:generate',
    );
    assert.equal(
      readFileSync(join(DOCS_DIR, 'data-quality-report.md'), 'utf8'),
      buildDataQualityReport(ctx.container.snapshot),
      'docs/data-quality-report.md is stale: run npm run docs:generate',
    );
  });
});
