import { z } from 'zod';
import { UserSchema } from './auth.js';
import { IsoDateTimeSchema, PageQuerySchema, ReportIdSchema } from './common.js';

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
    }),
    realtime: z.object({
      webSocketClients: z.number().int(),
      sseClients: z.number().int(),
      latestEventId: z.number().int(),
      bufferedEvents: z.number().int(),
    }),
    simulator: SimulatorStateSchema,
  })
  .meta({ id: 'SystemStatus' });
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
