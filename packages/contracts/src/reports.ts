import { z } from 'zod';
import { AlertSchema } from './alerts.js';
import {
  EfficiencyQuadrantSchema,
  IsoDateTimeSchema,
  LatencySeveritySchema,
  PageQuerySchema,
  QueryBoolSchema,
  RefreshStatusSchema,
  ReportIdSchema,
  SeveritySchema,
} from './common.js';

/** Cost block. Absent (`null`) when the caller lacks `costs:read`: redaction happens on the
 *  server, so a viewer never receives the numbers at all. */
export const ReportCostSchema = z
  .object({
    creditsAttributed: z
      .number()
      .nullable()
      .meta({ description: 'Method A. Null when the reported figure was quarantined.' }),
    creditsFullyLoaded: z
      .number()
      .nullable()
      .meta({ description: "Includes the report's share of warehouse idle time." }),
    snowflakeCostUsd: z.number().nullable(),
    snowflakeCostLoadedUsd: z.number().nullable(),
    awsHostingCostUsd: z.number().nullable(),
    totalCostUsd: z.number().nullable(),
    snowflakeCostPerViewUsd: z
      .number()
      .nullable()
      .meta({ description: 'Unit cost per active view, attributed basis.' }),
    totalCostPerViewUsd: z
      .number()
      .nullable()
      .meta({ description: 'Unit cost per active view, fully loaded incl. AWS.' }),
    isCostImputed: z
      .boolean()
      .meta({ description: 'True when the cost was estimated from execution time (Method C).' }),
    isCostQuarantined: z.boolean(),
  })
  .meta({ id: 'ReportCost' });
export type ReportCost = z.infer<typeof ReportCostSchema>;

export const OwnerSourceSchema = z.enum(['telemetry', 'assigned']).meta({
  id: 'OwnerSource',
  description:
    'telemetry: owner as reported by the portal. assigned: set by an admin in the Command Centre.',
});

export const ReportSummarySchema = z
  .object({
    reportId: ReportIdSchema,
    reportName: z.string(),
    ownerEmail: z.string().nullable(),
    ownerSource: OwnerSourceSchema.nullable(),
    isOrphaned: z.boolean(),
    refreshStatus: RefreshStatusSchema,
    refreshFailureStreak: z.number().int(),
    loadTimeSec: z.number().nullable(),
    latencySeverity: LatencySeveritySchema,
    lastObservedAt: IsoDateTimeSchema.nullable(),
    monthlyActiveViews: z.number().int().nullable(),
    queryCount30d: z.number().int().nullable(),
    concurrentUserPeak: z.number().int().nullable(),
    efficiencyQuadrant: EfficiencyQuadrantSchema.nullable(),
    activeAlerts: z.number().int(),
    highestAlertSeverity: SeveritySchema.nullable(),
    cost: ReportCostSchema.nullable(),
  })
  .meta({ id: 'ReportSummary' });
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const REPORT_SORT_FIELDS = [
  'reportId',
  'ownerEmail',
  'loadTimeSec',
  'refreshFailureStreak',
  'monthlyActiveViews',
  'activeAlerts',
  'totalCostUsd',
  'totalCostPerViewUsd',
] as const;

export const ReportListQuerySchema = PageQuerySchema.extend({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .meta({ description: 'Matches report id, name or owner email.' }),
  owner: z.string().trim().max(200).optional(),
  orphaned: QueryBoolSchema.optional(),
  refreshStatus: RefreshStatusSchema.optional(),
  latencySeverity: LatencySeveritySchema.optional(),
  quadrant: EfficiencyQuadrantSchema.optional(),
  hasAlerts: QueryBoolSchema.optional(),
  sort: z.enum(REPORT_SORT_FIELDS).default('reportId'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ReportListQuery = z.infer<typeof ReportListQuerySchema>;

export const PeriodObservationSchema = z
  .object({
    periodSeq: z.number().int(),
    periodLabel: z.string(),
    periodStart: IsoDateTimeSchema,
    periodEnd: IsoDateTimeSchema,
    ownerEmail: z.string().nullable(),
    isOrphaned: z.boolean(),
    refreshStatus: RefreshStatusSchema,
    loadTimeSec: z.number().nullable(),
    latencySeverity: LatencySeveritySchema,
    monthlyActiveViews: z.number().int().nullable(),
    queryCount30d: z.number().int().nullable(),
    concurrentUserPeak: z.number().int().nullable(),
    flags: z.object({
      zeroViews: z.boolean(),
      concurrencyExceedsViews: z.boolean(),
      costQuarantined: z.boolean(),
    }),
    cost: ReportCostSchema.nullable(),
  })
  .meta({ id: 'PeriodObservation' });
export type PeriodObservation = z.infer<typeof PeriodObservationSchema>;

export const OwnershipChangeSchema = z
  .object({
    periodSeq: z.number().int(),
    periodLabel: z.string(),
    ownerEmail: z.string().nullable(),
    changeType: z.enum([
      'INITIAL',
      'INITIAL_ORPHANED',
      'UNCHANGED',
      'REASSIGNED',
      'ORPHANED',
      'STILL_ORPHANED',
      'CLAIMED',
    ]),
  })
  .meta({ id: 'OwnershipChange' });

export const OwnerAssignmentSchema = z
  .object({
    id: z.number().int(),
    reportId: ReportIdSchema,
    ownerEmail: z.string(),
    previousOwnerEmail: z.string().nullable(),
    assignedBy: z.string(),
    assignedAt: IsoDateTimeSchema,
    note: z.string().nullable(),
  })
  .meta({ id: 'OwnerAssignment' });
export type OwnerAssignment = z.infer<typeof OwnerAssignmentSchema>;

export const ReportFindingSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  periodSeq: z.number().int(),
  observedValue: z.string().nullable(),
  detail: z.string().nullable(),
});

export const ReportDetailSchema = ReportSummarySchema.extend({
  ownership: z.object({
    distinctOwners: z.number().int(),
    ownershipChanges: z.number().int(),
    periodsOrphaned: z.number().int(),
    lastKnownOwner: z.string().nullable(),
    mostFrequentOwner: z.string().nullable(),
    history: z.array(OwnershipChangeSchema),
    assignments: z.array(OwnerAssignmentSchema),
  }),
  history: z.array(PeriodObservationSchema),
  alerts: z.array(AlertSchema),
  findings: z.array(ReportFindingSchema),
}).meta({ id: 'ReportDetail' });
export type ReportDetail = z.infer<typeof ReportDetailSchema>;

export const OrphanQueueItemSchema = z
  .object({
    priorityRank: z.number().int(),
    reportId: ReportIdSchema,
    reportName: z.string(),
    orphanEncoding: z
      .string()
      .nullable()
      .meta({ description: 'How the source encoded "no owner": NAN_LITERAL or SENTINEL.' }),
    periodsSinceOwned: z.number().int().nullable(),
    suggestedOwner: z.string().nullable(),
    suggestionBasis: z.string().nullable(),
    mostFrequentOwner: z.string().nullable(),
    refreshStatus: RefreshStatusSchema,
    latencySeverity: LatencySeveritySchema,
    monthlyActiveViews: z.number().int().nullable(),
    activeAlerts: z.number().int(),
    costAtRiskUsd: z.number().nullable().meta({
      description: 'Monthly run-rate with nobody accountable. Null without `costs:read`.',
    }),
    lifetimeCostWhileOrphanedUsd: z.number().nullable(),
  })
  .meta({ id: 'OrphanQueueItem' });
export type OrphanQueueItem = z.infer<typeof OrphanQueueItemSchema>;

export const OrphanQueueSchema = z
  .object({
    items: z.array(OrphanQueueItemSchema),
    total: z.number().int(),
    totalCostAtRiskUsd: z.number().nullable(),
    assignableOwners: z.array(
      z.object({ email: z.string(), name: z.string(), reportsOwned: z.number().int() }),
    ),
  })
  .meta({ id: 'OrphanQueue' });
export type OrphanQueue = z.infer<typeof OrphanQueueSchema>;

export const AssignOwnerRequestSchema = z.object({
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email()),
  note: z.string().trim().max(500).optional(),
});
export type AssignOwnerRequest = z.infer<typeof AssignOwnerRequestSchema>;

export const OverviewSchema = z
  .object({
    scope: z.enum(['all', 'own']),
    asOf: z.object({
      periodSeq: z.number().int(),
      periodLabel: z.string(),
      periodStart: IsoDateTimeSchema,
      periodEnd: IsoDateTimeSchema,
    }),
    reports: z.object({
      total: z.number().int(),
      healthy: z.number().int(),
      orphaned: z.number().int(),
      refreshFailing: z.number().int(),
      refreshUnknown: z.number().int(),
      slow: z.number().int(),
      critical: z.number().int(),
    }),
    alerts: z.object({
      firing: z.number().int(),
      acknowledged: z.number().int(),
      escalated: z.number().int(),
      critical: z.number().int(),
      high: z.number().int(),
      warning: z.number().int(),
      info: z.number().int(),
    }),
    latency: z.object({
      medianSec: z.number().nullable(),
      p95Sec: z.number().nullable(),
      thresholdSec: z.number(),
      distribution: z.array(z.object({ bucket: z.string(), reports: z.number().int() })),
    }),
    trend: z.array(
      z.object({
        periodSeq: z.number().int(),
        periodLabel: z.string(),
        orphaned: z.number().int(),
        refreshFailures: z.number().int(),
        latencyBreaches: z.number().int(),
        medianLoadTimeSec: z.number().nullable(),
        totalCostUsd: z.number().nullable(),
      }),
    ),
    cost: z
      .object({
        totalCostUsd: z.number(),
        snowflakeCostUsd: z.number(),
        awsHostingCostUsd: z.number(),
        costPerViewUsd: z.number().nullable(),
        orphanedCostUsd: z.number(),
        zombieRunRateUsd: z.number(),
        zombieReports: z.number().int(),
      })
      .nullable(),
    attention: z.array(
      z.object({
        reportId: ReportIdSchema,
        reportName: z.string(),
        reason: z.string(),
        severity: SeveritySchema,
      }),
    ),
  })
  .meta({ id: 'Overview' });
export type Overview = z.infer<typeof OverviewSchema>;

export const TELEMETRY_WINDOWS = ['1h', '6h', '24h'] as const;
export const TelemetryWindowSchema = z.enum(TELEMETRY_WINDOWS);
export type TelemetryWindow = z.infer<typeof TelemetryWindowSchema>;

export const TelemetrySeriesQuerySchema = z.object({
  window: TelemetryWindowSchema.default('1h'),
  reportId: ReportIdSchema.optional(),
});

export const TelemetrySeriesSchema = z
  .object({
    window: TelemetryWindowSchema,
    bucketMinutes: z.number().int(),
    thresholdSec: z.number(),
    reportId: ReportIdSchema.nullable(),
    totals: z.object({
      observations: z.number().int(),
      latencyBreaches: z.number().int(),
      refreshFailures: z.number().int(),
      reports: z.number().int(),
    }),
    buckets: z.array(
      z.object({
        start: IsoDateTimeSchema,
        observations: z.number().int(),
        p50LoadSec: z.number().nullable(),
        p95LoadSec: z.number().nullable(),
        maxLoadSec: z.number().nullable(),
        latencyBreaches: z.number().int(),
        refreshFailures: z.number().int(),
      }),
    ),
    points: z
      .array(
        z.object({
          observedAt: IsoDateTimeSchema,
          loadTimeSec: z.number().nullable(),
          refreshStatus: RefreshStatusSchema.nullable(),
          source: z.string(),
        }),
      )
      .meta({
        description: 'The most recent individual readings. Only returned for a single report.',
      }),
  })
  .meta({ id: 'TelemetrySeries' });
export type TelemetrySeries = z.infer<typeof TelemetrySeriesSchema>;
