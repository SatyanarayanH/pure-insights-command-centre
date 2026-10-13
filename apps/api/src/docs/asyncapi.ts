import {
  CLIENT_MESSAGE_DEFINITIONS,
  DEFAULT_TOPICS,
  PROTOCOL_VERSION,
  SERVER_EVENT_DEFINITIONS,
  SERVER_EVENT_TYPES,
  SSE_PATH,
  serverEventSchema,
  TOPICS,
  WS_CLOSE_CODES,
  WS_PATH,
} from '@picc/contracts';
import type { z } from 'zod';
import { API_PREFIX, SERVICE_VERSION } from '../config.js';
import { TICKET_TTL_MS } from '../realtime/tickets.js';
import { type Json, jsonSchemaOf, sortKeys } from './json-schema.js';

const messageId = (type: string): string =>
  type.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase());

const payload = (schema: z.ZodType, components: Record<string, unknown>): Json =>
  jsonSchemaOf(schema, 'output', components);

/** Builds the AsyncAPI 3.0 document for the real-time protocol from the contract definitions. */
export function buildAsyncApi(): Json {
  const schemas: Record<string, unknown> = {};
  const messages: Record<string, Json> = {};

  for (const type of SERVER_EVENT_TYPES) {
    const definition = SERVER_EVENT_DEFINITIONS[type];
    messages[messageId(type)] = {
      name: type,
      title: definition.summary,
      summary: definition.summary,
      description: `${definition.description}\n\nTopic: ${definition.topic ? `\`${definition.topic}\`` : 'none (connection-scoped, id is 0, never replayed)'}.`,
      contentType: 'application/json',
      payload: payload(serverEventSchema(type), schemas),
      'x-topic': definition.topic,
    };
  }
  const clientTypes = Object.keys(
    CLIENT_MESSAGE_DEFINITIONS,
  ) as (keyof typeof CLIENT_MESSAGE_DEFINITIONS)[];
  for (const type of clientTypes) {
    const definition = CLIENT_MESSAGE_DEFINITIONS[type];
    messages[`client${messageId(type)[0]!.toUpperCase()}${messageId(type).slice(1)}`] = {
      name: type,
      title: definition.summary,
      summary: definition.summary,
      description: definition.description,
      contentType: 'application/json',
      payload: payload(definition.schema, schemas),
    };
  }

  const ref = (name: string): Json => ({ $ref: `#/components/messages/${name}` });
  const serverRefs = SERVER_EVENT_TYPES.map((t) => messageId(t));
  const clientRefs = clientTypes.map(
    (t) => `client${messageId(t)[0]!.toUpperCase()}${messageId(t).slice(1)}`,
  );
  const channelMessages = (names: string[]): Json =>
    Object.fromEntries(names.map((n) => [n, ref(n)]));
  const sseRefs = serverRefs.filter((n) => !['pong', 'subscribed', 'error'].includes(n));

  const bindings = {
    query: {
      type: 'object',
      required: ['ticket'],
      properties: {
        ticket: {
          type: 'string',
          description: `Single-use ticket from \`POST ${API_PREFIX}/realtime/ticket\`. Valid for ${TICKET_TTL_MS / 1000} seconds.`,
        },
        topics: {
          type: 'string',
          description: `Comma-separated topics. One or more of: ${TOPICS.join(', ')}. Default: ${DEFAULT_TOPICS.join(',')}.`,
        },
        lastEventId: {
          type: 'integer',
          description:
            'Resume point: the server replays every buffered event with a greater id before sending live events.',
        },
      },
    },
  };

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'Pure Insights Command Centre real-time protocol',
      version: `${SERVICE_VERSION}+protocol.${PROTOCOL_VERSION}`,
      description: [
        'Operational events pushed to browsers: alert lifecycle, ownership changes and raw telemetry.',
        '',
        'Two transports carry the same events in the same envelope `{ v, id, type, ts, data }`:',
        `- **WebSocket** at \`${WS_PATH}\`: bidirectional; the client can ping and change its topic subscriptions.`,
        `- **Server-Sent Events** at \`${SSE_PATH}\`: server-to-client only; for networks or proxies that block WebSocket.`,
        '',
        '**Authentication.** Browsers cannot set an Authorization header on either transport, so the client first calls',
        `\`POST ${API_PREFIX}/realtime/ticket\` with its bearer token and opens the stream with \`?ticket=\`. A ticket works once and expires in ${TICKET_TTL_MS / 1000} seconds.`,
        '',
        '**Authorisation.** Applied per event at delivery: a Report Owner only receives events for reports they own, and callers without `pii:read` receive masked email addresses. The rules are the same functions the REST API uses.',
        '',
        '**Delivery.** At-least-once within the replay buffer. Each topic event has a monotonically increasing `id`; reconnect with `lastEventId` to receive what was missed. If the gap has left the buffer the server sends `replay.gap` and the client refetches state over REST. Handlers should be idempotent on `id`.',
        '',
        '**Liveness.** The server sends a protocol-level ping every heartbeat interval and closes connections that do not answer. Clients may also send an application `ping` to measure round-trip time.',
        '',
        `**Close codes.** ${Object.values(WS_CLOSE_CODES)
          .map((c) => `\`${c.code}\` ${c.reason}`)
          .join(' · ')}.`,
      ].join('\n'),
    },
    defaultContentType: 'application/json',
    servers: {
      local: { host: 'localhost:4000', protocol: 'ws', description: 'Local development' },
      production: {
        host: 'command-centre.example.com',
        protocol: 'wss',
        description: 'Behind TLS',
      },
    },
    channels: {
      events: {
        address: WS_PATH,
        title: 'WebSocket event stream',
        description: 'Server events, plus client control messages.',
        messages: channelMessages([...serverRefs, ...clientRefs]),
        bindings: { ws: { ...bindings, bindingVersion: '0.1.0' } },
      },
      eventsSse: {
        address: SSE_PATH,
        title: 'Server-Sent Events stream',
        description:
          "Same server events as the WebSocket channel. Each is sent as `event: <type>`, `id: <id>` and `data: <envelope JSON>`. The browser's EventSource resends `Last-Event-ID` on reconnect, which the server honours exactly like `lastEventId`.",
        messages: channelMessages(sseRefs),
        bindings: { http: { method: 'GET', ...bindings, bindingVersion: '0.3.0' } },
      },
    },
    operations: {
      receiveEvents: {
        action: 'receive',
        channel: { $ref: '#/channels/events' },
        title: 'Receive server events',
        summary: 'Events the server pushes to the client over WebSocket.',
        messages: serverRefs.map((n) => ({ $ref: `#/channels/events/messages/${n}` })),
      },
      sendControl: {
        action: 'send',
        channel: { $ref: '#/channels/events' },
        title: 'Send control messages',
        summary: 'Heartbeat and subscription changes sent by the client over WebSocket.',
        messages: clientRefs.map((n) => ({ $ref: `#/channels/events/messages/${n}` })),
      },
      receiveEventsSse: {
        action: 'receive',
        channel: { $ref: '#/channels/eventsSse' },
        title: 'Receive server events (SSE)',
        summary: 'Events the server pushes to the client over Server-Sent Events.',
        messages: sseRefs.map((n) => ({ $ref: `#/channels/eventsSse/messages/${n}` })),
      },
    },
    components: {
      messages,
      schemas: sortKeys(schemas),
    },
  };
}
