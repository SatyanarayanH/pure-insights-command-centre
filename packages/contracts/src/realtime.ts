import { z } from 'zod';
import { AlertSchema } from './alerts.js';
import { IsoDateTimeSchema, RefreshStatusSchema, ReportIdSchema } from './common.js';

/**
 * Real-time protocol, shared by the WebSocket endpoint (`/ws`) and the Server-Sent Events
 * endpoint (`/api/v1/stream`). Both carry the same server events in the same envelope.
 *
 * Every server event has a monotonically increasing `id`. A client that reconnects passes the
 * last id it saw and the server replays what it missed, so a dropped connection loses nothing
 * as long as the gap is still in the server's buffer.
 */
export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';
export const SSE_PATH = '/api/v1/stream';

export const TOPICS = ['alerts', 'reports', 'telemetry', 'system'] as const;
export const TopicSchema = z.enum(TOPICS).meta({
  id: 'Topic',
  description:
    'alerts: alert lifecycle. reports: ownership changes. telemetry: every observation (high volume, opt-in). system: operational notices.',
});
export type Topic = z.infer<typeof TopicSchema>;
export const DEFAULT_TOPICS: readonly Topic[] = ['alerts', 'reports', 'system'];

// ---- server -> client --------------------------------------------------------------------

const ConnectionReadyData = z.object({
  connectionId: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  user: z.object({ email: z.string(), role: z.string(), scope: z.enum(['all', 'own']) }),
  topics: z.array(TopicSchema),
  heartbeatIntervalMs: z.number().int(),
  latestEventId: z.number().int(),
  resumedFrom: z.number().int().nullable(),
  replayed: z
    .number()
    .int()
    .meta({ description: 'Missed events about to be delivered after this message.' }),
});

const AlertFiredData = z.object({ alert: AlertSchema });
const AlertUpdatedData = z.object({
  alert: AlertSchema,
  change: z.enum([
    'occurrence',
    'escalated',
    'deescalated',
    'acknowledged',
    'snoozed',
    'rerouted',
    'reopened',
  ]),
});
const AlertResolvedData = z.object({ alert: AlertSchema });

const TelemetryObservedData = z.object({
  reportId: ReportIdSchema,
  observedAt: IsoDateTimeSchema,
  loadTimeSec: z.number().nullable(),
  refreshStatus: RefreshStatusSchema.nullable(),
  breach: z
    .boolean()
    .meta({ description: 'True when this observation violates at least one alert rule.' }),
  source: z.string(),
});

const ReportOwnerChangedData = z.object({
  reportId: ReportIdSchema,
  ownerEmail: z.string().nullable(),
  previousOwnerEmail: z.string().nullable(),
  assignedBy: z.string(),
});

const SystemNoticeData = z.object({
  level: z.enum(['info', 'warning']),
  code: z.string(),
  message: z.string(),
});

const ReplayGapData = z.object({
  requestedFrom: z.number().int(),
  oldestAvailable: z.number().int(),
  message: z.string(),
});

const PongData = z.object({ clientTs: z.number().nullable() });
const SubscribedData = z.object({ topics: z.array(TopicSchema) });
const ErrorData = z.object({ code: z.string(), message: z.string() });

export const SERVER_EVENT_DEFINITIONS = {
  'connection.ready': {
    data: ConnectionReadyData,
    topic: null,
    summary: 'Handshake accepted',
    description:
      'First message on every connection. States who the server thinks you are and how many missed events follow.',
  },
  'alert.fired': {
    data: AlertFiredData,
    topic: 'alerts',
    summary: 'A new alert opened',
    description:
      'A report crossed an alert rule and no alert was open for that rule and report. Sent once per incident, not once per breaching observation.',
  },
  'alert.updated': {
    data: AlertUpdatedData,
    topic: 'alerts',
    summary: 'An open alert changed',
    description:
      'Another breaching observation was folded in (`occurrence`), severity moved, or a person acknowledged or snoozed it.',
  },
  'alert.resolved': {
    data: AlertResolvedData,
    topic: 'alerts',
    summary: 'An alert cleared',
    description:
      "The condition stayed healthy for the rule's `resolveAfter` consecutive observations.",
  },
  'telemetry.observed': {
    data: TelemetryObservedData,
    topic: 'telemetry',
    summary: 'One telemetry observation was ingested',
    description:
      'Raw feed for live tickers. High volume; clients must opt in to the `telemetry` topic.',
  },
  'report.owner_changed': {
    data: ReportOwnerChangedData,
    topic: 'reports',
    summary: 'A report was assigned an owner',
    description: 'Clients should refetch report lists and the orphan queue.',
  },
  'system.notice': {
    data: SystemNoticeData,
    topic: 'system',
    summary: 'Operational notice',
    description: 'For example: the telemetry simulator was paused or an alert rule was changed.',
  },
  'replay.gap': {
    data: ReplayGapData,
    topic: null,
    summary: 'Resume was not possible',
    description:
      'The client asked to resume from an event id that has left the buffer. It must refetch state over REST; live events continue from here.',
  },
  subscribed: {
    data: SubscribedData,
    topic: null,
    summary: 'Subscription changed',
    description: 'Reply to `subscribe` / `unsubscribe` with the resulting topic set.',
  },
  pong: {
    data: PongData,
    topic: null,
    summary: 'Heartbeat reply',
    description:
      'Reply to a client `ping`. Echoes the client timestamp so the client can measure round-trip time.',
  },
  error: {
    data: ErrorData,
    topic: null,
    summary: 'Protocol error',
    description:
      'A client message was malformed or not allowed. The connection stays open unless the code is `unauthorized`.',
  },
} as const;

export type ServerEventType = keyof typeof SERVER_EVENT_DEFINITIONS;
export const SERVER_EVENT_TYPES = Object.keys(SERVER_EVENT_DEFINITIONS) as ServerEventType[];

export type ServerEventData<T extends ServerEventType> = z.infer<
  (typeof SERVER_EVENT_DEFINITIONS)[T]['data']
>;

export interface ServerEvent<T extends ServerEventType = ServerEventType> {
  /** Protocol version. */
  v: typeof PROTOCOL_VERSION;
  /** Monotonic event id. 0 for connection-scoped messages that are never replayed. */
  id: number;
  type: T;
  /** Server time, ISO-8601. */
  ts: string;
  data: ServerEventData<T>;
}

export type AnyServerEvent = { [T in ServerEventType]: ServerEvent<T> }[ServerEventType];

export function serverEventSchema<T extends ServerEventType>(type: T) {
  return z.object({
    v: z.literal(PROTOCOL_VERSION),
    id: z.number().int(),
    type: z.literal(type),
    ts: IsoDateTimeSchema,
    data: SERVER_EVENT_DEFINITIONS[type].data,
  });
}

// ---- client -> server (WebSocket only) -----------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), ts: z.number().optional() }),
  z.object({ type: z.literal('subscribe'), topics: z.array(TopicSchema).min(1) }),
  z.object({ type: z.literal('unsubscribe'), topics: z.array(TopicSchema).min(1) }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const CLIENT_MESSAGE_DEFINITIONS = {
  ping: {
    schema: z.object({ type: z.literal('ping'), ts: z.number().optional() }),
    summary: 'Heartbeat',
    description:
      'Send at least every `heartbeatIntervalMs`. The server closes connections that stay silent for twice that.',
  },
  subscribe: {
    schema: z.object({ type: z.literal('subscribe'), topics: z.array(TopicSchema).min(1) }),
    summary: 'Add topics',
    description:
      'Adds topics to the connection. Row-level security still applies to everything delivered.',
  },
  unsubscribe: {
    schema: z.object({ type: z.literal('unsubscribe'), topics: z.array(TopicSchema).min(1) }),
    summary: 'Remove topics',
    description: 'Stops delivery for the given topics.',
  },
} as const;

/** WebSocket close codes the server uses. */
export const WS_CLOSE_CODES = {
  UNAUTHORIZED: { code: 4401, reason: 'Missing, expired or already-used ticket' },
  HEARTBEAT_TIMEOUT: { code: 4408, reason: 'No heartbeat received' },
  SLOW_CONSUMER: { code: 4429, reason: 'Client is not reading fast enough' },
  SERVER_SHUTDOWN: { code: 1001, reason: 'Server is shutting down' },
} as const;
