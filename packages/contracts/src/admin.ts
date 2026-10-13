import { z } from 'zod';
import { UserSchema } from './auth.js';
import { IsoDateTimeSchema, PageQuerySchema, ReportIdSchema, SeveritySchema } from './common.js';

export const UserListSchema = z.object({
  items: z.array(
    UserSchema.extend({
      reportsOwned: z.number().int(),
      lastLoginAt: IsoDateTimeSchema.nullable(),
    }),
  ),
});

export const AuditEntrySchema = z
  .object({
    id: z.number().int(),
    at: IsoDateTimeSchema,
    actor: z.string(),
    actorRole: z.string(),
    action: z.string().meta({ example: 'report.owner.assign' }),
    targetType: z.string(),
    targetId: z.string(),
    detail: z.record(z.string(), z.unknown()),
    requestId: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry' });
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = PageQuerySchema.extend({
  action: z.string().max(100).optional(),
});

export const InjectIncidentRequestSchema = z
  .object({
    reportId: ReportIdSchema,
    kind: z.enum(['latency_spike', 'refresh_failure', 'refresh_timeout', 'recovery']),
    loadTimeSec: z.number().min(0).max(3600).optional().meta({
      description: 'For latency_spike. Defaults to 42 seconds.',
    }),
  })
  .meta({ id: 'InjectIncidentRequest' });
export type InjectIncidentRequest = z.infer<typeof InjectIncidentRequestSchema>;

export const SimulatorStateSchema = z
  .object({
    running: z.boolean(),
    intervalMs: z.number().int(),
    eventsEmitted: z.number().int(),
    lastEventAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'SimulatorState' });
export type SimulatorState = z.infer<typeof SimulatorStateSchema>;

export const UpdateSimulatorRequestSchema = z.object({
  running: z.boolean().optional(),
  intervalMs: z.number().int().min(250).max(60_000).optional(),
});

export const NotificationChannelSchema = z.enum(['webhook', 'none']).meta({
  id: 'NotificationChannel',
  description: 'none: no webhook is configured, so notifications are recorded but not sent.',
});

export const WarehouseRefreshOutcomeSchema = z.enum(['refreshed', 'unchanged', 'failed']).meta({
  id: 'WarehouseRefreshOutcome',
  description:
    'refreshed: new data is live. unchanged: the warehouse has not been rebuilt since the last read. failed: the previous data stays in service.',
});

export const SystemStatusSchema = z
  .object({
    service: z.string(),
    version: z.string(),
    uptimeSec: z.number(),
    demoMode: z.boolean(),
    warehouse: z.object({
      dialect: z.string(),
      builtAt: z.string(),
      suiteDurationMs: z.number().int(),
      reconciliationPassed: z.number().int(),
      reconciliationTotal: z.number().int(),
      source: z.enum(['duckdb', 'snowflake']).meta({
        description: 'Where the cost model is read from. Set with WAREHOUSE.',
      }),
      refreshEveryMin: z.number().int().meta({ description: '0: scheduled refresh is off.' }),
      lastRefreshAt: IsoDateTimeSchema.nullable(),
      lastRefreshOutcome: WarehouseRefreshOutcomeSchema.nullable(),
      lastRefreshError: z.string().nullable().meta({
        description: 'Set when the last refresh failed. The previous data stays in service.',
      }),
    }),
    realtime: z.object({
      webSocketClients: z.number().int(),
      sseClients: z.number().int(),
      latestEventId: z.number().int(),
      bufferedEvents: z.number().int(),
    }),
    simulator: SimulatorStateSchema,
    telemetry: z.object({
      lastReceivedAt: IsoDateTimeSchema.nullable(),
      feedSilent: z.boolean().meta({
        description:
          'True when no telemetry at all has arrived for longer than the feed-silence window.',
      }),
      feedSilentAfterSec: z.number().int(),
      observationsStored: z.number().int(),
      retentionDays: z.number().int(),
    }),
    notifications: z.object({
      channel: NotificationChannelSchema,
      minSeverity: SeveritySchema,
      escalateAfterMin: z.number().int(),
      pending: z.number().int(),
      sent: z.number().int(),
      failed: z.number().int(),
      skipped: z.number().int(),
    }),
  })
  .meta({ id: 'SystemStatus' });
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const NOTIFICATION_KINDS = [
  'fired',
  'escalated',
  'reopened',
  'resolved',
  'unacknowledged',
  'feed_silent',
  'feed_recovered',
  'warehouse_refresh_failed',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS).meta({
  id: 'NotificationKind',
  description:
    'unacknowledged: nobody took a high-severity alert within the escalation window, so it went to the platform admins. feed_silent: no telemetry is arriving at all.',
});
export const NotificationStatusSchema = z.enum(['pending', 'sent', 'failed', 'skipped']).meta({
  id: 'NotificationStatus',
  description:
    'pending: waiting to be delivered or retried. failed: gave up after the retry limit. skipped: no channel is configured, so it was only recorded.',
});

export const NotificationSchema = z
  .object({
    id: z.number().int(),
    kind: NotificationKindSchema,
    alertId: z.string().nullable(),
    reportId: z.string().nullable(),
    severity: SeveritySchema.nullable(),
    recipient: z.string().meta({
      description:
        'Owner email, or `platform-admins` when the report has no owner or the matter is system-wide.',
    }),
    title: z.string(),
    body: z.string(),
    channel: NotificationChannelSchema,
    status: NotificationStatusSchema,
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    sentAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationQuerySchema = PageQuerySchema.extend({
  status: NotificationStatusSchema.optional(),
});

export const WarehouseRefreshResultSchema = z
  .object({
    outcome: WarehouseRefreshOutcomeSchema,
    builtAt: z.string(),
    durationMs: z.number().int(),
    error: z.string().nullable(),
  })
  .meta({ id: 'WarehouseRefreshResult' });
export type WarehouseRefreshResult = z.infer<typeof WarehouseRefreshResultSchema>;
