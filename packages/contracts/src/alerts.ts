import { z } from 'zod';
import {
  IsoDateTimeSchema,
  PageQuerySchema,
  RefreshStatusSchema,
  ReportIdSchema,
  SeveritySchema,
} from './common.js';

export const ALERT_RULE_IDS = [
  'latency',
  'refresh_failure',
  'refresh_unknown',
  'invalid_telemetry',
] as const;
export const AlertRuleIdSchema = z.enum(ALERT_RULE_IDS).meta({ id: 'AlertRuleId' });
export type AlertRuleId = z.infer<typeof AlertRuleIdSchema>;

export const AlertStatusSchema = z.enum(['firing', 'acknowledged', 'resolved']).meta({
  id: 'AlertStatus',
  description:
    'firing: condition holds, nobody has taken it. acknowledged: condition holds, someone owns it. resolved: condition cleared.',
});
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

export const AlertSourceSchema = z
  .enum(['backfill', 'live', 'injected', 'api'])
  .meta({ id: 'AlertSource' });
export type AlertSource = z.infer<typeof AlertSourceSchema>;

export const AlertRoutingSchema = z
  .object({
    kind: z.enum(['owner', 'admins']),
    ownerEmail: z.string().nullable(),
    escalated: z.boolean().meta({
      description: 'True when the report has no owner, so the alert went to platform admins.',
    }),
  })
  .meta({ id: 'AlertRouting' });

export const AlertSchema = z
  .object({
    id: z.string(),
    fingerprint: z
      .string()
      .meta({ description: '`<ruleId>:<reportId>`. One open alert per fingerprint.' }),
    ruleId: AlertRuleIdSchema,
    ruleName: z.string(),
    reportId: ReportIdSchema,
    reportName: z.string(),
    severity: SeveritySchema,
    status: AlertStatusSchema,
    message: z.string(),
    value: z.number().nullable().meta({
      description: 'Latest observed value (seconds for latency, streak length for refresh).',
    }),
    threshold: z.number().nullable(),
    unit: z.string().nullable(),
    occurrences: z
      .number()
      .int()
      .meta({ description: 'Breaching observations folded into this alert.' }),
    reopenCount: z.number().int(),
    isFlapping: z.boolean(),
    healthyStreak: z.number().int().meta({
      description:
        'Consecutive healthy observations since the last breach. Above 0 on an open alert means it is recovering: the latest reading was fine but the alert has not cleared yet.',
    }),
    resolveAfter: z.number().int().meta({
      description: 'Healthy observations in a row needed before this alert resolves.',
    }),
    firstSeenAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
    resolvedAt: IsoDateTimeSchema.nullable(),
    acknowledgedBy: z.string().nullable(),
    acknowledgedAt: IsoDateTimeSchema.nullable(),
    ackNote: z.string().nullable(),
    snoozedUntil: IsoDateTimeSchema.nullable(),
    routing: AlertRoutingSchema,
    source: AlertSourceSchema,
  })
  .meta({ id: 'Alert' });
export type Alert = z.infer<typeof AlertSchema>;

export const AlertEventTypeSchema = z
  .enum([
    'fired',
    'escalated',
    'deescalated',
    'acknowledged',
    'snoozed',
    'resolved',
    'reopened',
    'rerouted',
  ])
  .meta({ id: 'AlertEventType' });
export type AlertEventType = z.infer<typeof AlertEventTypeSchema>;

export const AlertTimelineEntrySchema = z
  .object({
    id: z.number().int(),
    alertId: z.string(),
    type: AlertEventTypeSchema,
    at: IsoDateTimeSchema,
    actor: z.string().meta({ description: 'User email, or `system` for engine transitions.' }),
    severity: SeveritySchema.nullable(),
    value: z.number().nullable(),
    detail: z.string().nullable(),
  })
  .meta({ id: 'AlertTimelineEntry' });
export type AlertTimelineEntry = z.infer<typeof AlertTimelineEntrySchema>;

export const AlertDetailSchema = AlertSchema.extend({
  timeline: z.array(AlertTimelineEntrySchema),
}).meta({
  id: 'AlertDetail',
});
export type AlertDetail = z.infer<typeof AlertDetailSchema>;

export const AlertListQuerySchema = PageQuerySchema.extend({
  status: z.enum(['active', 'firing', 'acknowledged', 'resolved', 'all']).default('active'),
  severity: SeveritySchema.optional(),
  ruleId: AlertRuleIdSchema.optional(),
  reportId: ReportIdSchema.optional(),
  escalated: z.enum(['true', 'false']).optional(),
});
export type AlertListQuery = z.infer<typeof AlertListQuerySchema>;

export const AlertStatsSchema = z
  .object({
    firing: z.number().int(),
    acknowledged: z.number().int(),
    resolved: z.number().int(),
    escalated: z.number().int(),
    flapping: z.number().int(),
    bySeverity: z.object({
      info: z.number().int(),
      warning: z.number().int(),
      high: z.number().int(),
      critical: z.number().int(),
    }),
    byRule: z.record(z.string(), z.number().int()),
  })
  .meta({ id: 'AlertStats' });
export type AlertStats = z.infer<typeof AlertStatsSchema>;

export const AckAlertRequestSchema = z.object({ note: z.string().trim().max(500).optional() });
export const SnoozeAlertRequestSchema = z.object({
  minutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60),
});

export const AlertRuleSchema = z
  .object({
    id: AlertRuleIdSchema,
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    inBrief: z
      .boolean()
      .meta({ description: 'True for the two conditions the case-study brief mandates.' }),
    warningThreshold: z
      .number()
      .nullable()
      .meta({ description: 'Latency: seconds above which a warning fires.' }),
    highThreshold: z.number().nullable(),
    criticalThreshold: z.number().nullable(),
    escalateAfter: z.number().int().nullable().meta({
      description: 'Refresh: consecutive failures after which severity becomes critical.',
    }),
    resolveAfter: z.number().int().meta({
      description:
        'Consecutive healthy observations required before an alert auto-resolves (flap damping).',
    }),
    updatedAt: IsoDateTimeSchema,
    updatedBy: z.string(),
  })
  .meta({ id: 'AlertRule' });
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const UpdateAlertRuleRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    warningThreshold: z.number().positive().max(600).optional(),
    highThreshold: z.number().positive().max(600).optional(),
    criticalThreshold: z.number().positive().max(600).optional(),
    escalateAfter: z.number().int().min(1).max(50).optional(),
    resolveAfter: z.number().int().min(1).max(20).optional(),
  })
  .refine(
    (r) =>
      (r.warningThreshold === undefined ||
        r.highThreshold === undefined ||
        r.warningThreshold < r.highThreshold) &&
      (r.highThreshold === undefined ||
        r.criticalThreshold === undefined ||
        r.highThreshold < r.criticalThreshold),
    { message: 'Thresholds must increase: warning < high < critical.' },
  )
  .refine((r) => Object.values(r).some((value) => value !== undefined), {
    message: 'Provide at least one field to change.',
  });
export type UpdateAlertRuleRequest = z.infer<typeof UpdateAlertRuleRequestSchema>;

/** One observation of a report, as the portal would push it. */
export const TelemetryEventSchema = z
  .object({
    reportId: ReportIdSchema,
    observedAt: z.iso.datetime({ offset: true }).optional().meta({
      description:
        'ISO-8601 with a time zone. Defaults to the time of receipt. Rejected if more than five minutes in the future, or older than the newest observation already held for the report.',
    }),
    loadTimeSec: z
      .number()
      .min(0)
      .max(3600)
      .optional()
      .meta({ description: 'Dashboard load latency in seconds.' }),
    refreshStatus: RefreshStatusSchema.optional(),
    creditsConsumed: z.number().optional().meta({
      description:
        'Snowflake credits for the observation window. Negative values are accepted, flagged and never used for cost.',
    }),
  })
  .refine(
    (e) =>
      e.loadTimeSec !== undefined ||
      e.refreshStatus !== undefined ||
      e.creditsConsumed !== undefined,
    {
      message: 'An event must carry at least one of loadTimeSec, refreshStatus, creditsConsumed.',
    },
  )
  .meta({ id: 'TelemetryEvent' });
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export const TelemetryIngestRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(1000).meta({
    description:
      'Array of TelemetryEvent. Each element is validated on its own, so one bad event does not reject the batch.',
  }),
});

export const TelemetryIngestResponseSchema = z
  .object({
    accepted: z.number().int(),
    rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
    alertsFired: z.number().int(),
    alertsResolved: z.number().int(),
  })
  .meta({ id: 'TelemetryIngestResponse' });
export type TelemetryIngestResponse = z.infer<typeof TelemetryIngestResponseSchema>;
