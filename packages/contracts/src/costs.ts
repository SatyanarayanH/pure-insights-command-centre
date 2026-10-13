import { z } from 'zod';
import { EfficiencyQuadrantSchema, IsoDateTimeSchema, ReportIdSchema } from './common.js';

export const CostPeriodSchema = z
  .object({
    periodSeq: z.number().int(),
    periodLabel: z.string(),
    periodStart: IsoDateTimeSchema,
    periodEnd: IsoDateTimeSchema,
    reports: z.number().int(),
    views: z.number(),
    creditsAttributed: z.number(),
    creditsFullyLoaded: z.number(),
    snowflakeCostLoadedUsd: z.number(),
    awsHostingCostUsd: z.number(),
    totalCostUsd: z.number(),
    orphanedCostUsd: z.number(),
    totalCostPerViewUsd: z.number().nullable(),
    // Platform-wide figures; null for callers scoped to their own reports.
    creditsMeteredCompute: z.number().nullable(),
    creditsIdle: z.number().nullable(),
    creditsUnattributed: z.number().nullable(),
  })
  .meta({ id: 'CostPeriod' });
export type CostPeriod = z.infer<typeof CostPeriodSchema>;

export const CostSummarySchema = z
  .object({
    scope: z.enum(['all', 'own']),
    creditPriceUsd: z.number(),
    latestPeriodSeq: z.number().int(),
    latest: CostPeriodSchema,
    lifetime: z.object({
      totalCostUsd: z.number(),
      snowflakeCostLoadedUsd: z.number(),
      awsHostingCostUsd: z.number(),
      orphanedCostUsd: z.number(),
      creditsAttributed: z.number(),
      creditsFullyLoaded: z.number(),
      totalCostPerViewUsd: z.number().nullable(),
    }),
    periods: z.array(CostPeriodSchema),
    platform: z
      .object({
        creditsMeteredCompute: z.number(),
        creditsAttributedToReports: z.number(),
        creditsIdle: z.number(),
        creditsUnattributed: z.number(),
        creditsQuarantinedImputed: z.number(),
        idleShare: z.number(),
        unattributed: z.array(
          z.object({
            attributionClass: z.string(),
            tagApp: z.string(),
            tagReportId: z.string(),
            queryRows: z.number().int(),
            credits: z.number(),
          }),
        ),
        methods: z.object({
          creditsDirect: z.number(),
          creditsIdleLoaded: z.number(),
          creditsTimeWeighted: z.number(),
          medianAbsDifferencePct: z.number().nullable(),
          correlation: z.number().nullable(),
        }),
        quarantine: z.object({
          reportPeriods: z.number().int(),
          creditsReported: z.number(),
          creditsImputed: z.number(),
          costImputedUsd: z.number(),
        }),
        correlations: z.array(
          z.object({
            usageMeasure: z.string(),
            costMeasure: z.string(),
            pearsonR: z.number().nullable(),
            observations: z.number().int(),
          }),
        ),
      })
      .nullable()
      .meta({ description: 'Whole-platform reconciliation. Null for callers scoped to their own reports.' }),
  })
  .meta({ id: 'CostSummary' });
export type CostSummary = z.infer<typeof CostSummarySchema>;

export const CostReportRowSchema = z
  .object({
    reportId: ReportIdSchema,
    reportName: z.string(),
    ownerEmail: z.string().nullable(),
    isOrphaned: z.boolean(),
    efficiencyQuadrant: EfficiencyQuadrantSchema.nullable(),
    monthlyActiveViews: z.number().nullable(),
    queryCount30d: z.number().nullable(),
    creditsAttributed: z.number().nullable(),
    creditsFullyLoaded: z.number().nullable(),
    snowflakeCostLoadedUsd: z.number().nullable(),
    awsHostingCostUsd: z.number().nullable(),
    totalCostUsd: z.number().nullable(),
    snowflakeCostPerViewUsd: z.number().nullable(),
    totalCostPerViewUsd: z.number().nullable(),
    snowflakeCostPerQueryUsd: z.number().nullable(),
    isCostImputed: z.boolean(),
    runRateViews: z.number().nullable(),
    runRateTotalCostUsd: z.number().nullable(),
  })
  .meta({ id: 'CostReportRow' });
export type CostReportRow = z.infer<typeof CostReportRowSchema>;

export const CostReportsQuerySchema = z.object({
  period: z
    .string()
    .regex(/^(latest|lifetime|\d{1,3})$/)
    .default('latest')
    .meta({ description: '`latest`, `lifetime`, or a zero-based period number.' }),
});

export const CostReportsSchema = z
  .object({
    period: z.string(),
    periodLabel: z.string(),
    items: z.array(CostReportRowSchema),
  })
  .meta({ id: 'CostReports' });
export type CostReports = z.infer<typeof CostReportsSchema>;

export const ChargebackRowSchema = z
  .object({
    ownerKey: z.string(),
    isUnowned: z.boolean(),
    reportPeriods: z.number().int(),
    reportsNow: z.number().int(),
    views: z.number(),
    creditsFullyLoaded: z.number(),
    snowflakeCostLoadedUsd: z.number(),
    awsHostingCostUsd: z.number(),
    totalCostUsd: z.number(),
    totalCostPerViewUsd: z.number().nullable(),
    shareOfTotalCost: z.number(),
    latestPeriodCostUsd: z.number(),
  })
  .meta({ id: 'ChargebackRow' });
export type ChargebackRow = z.infer<typeof ChargebackRowSchema>;

export const ChargebackSchema = z.object({ items: z.array(ChargebackRowSchema) }).meta({ id: 'Chargeback' });
export type Chargeback = z.infer<typeof ChargebackSchema>;

export const CostAnomalySchema = z
  .object({
    anomalyType: z.enum([
      'ZOMBIE_REPORT',
      'ORPHANED_SPEND',
      'COST_PER_VIEW_OUTLIER',
      'ZERO_VIEW_SPEND',
      'QUARANTINED_CREDITS',
    ]),
    reportId: ReportIdSchema,
    reportName: z.string(),
    periodSeq: z.number().int().nullable(),
    periodLabel: z.string().nullable(),
    metricValue: z.number().nullable(),
    metricUnit: z.string(),
    estMonthlyImpactUsd: z.number().nullable(),
    detail: z.string(),
  })
  .meta({ id: 'CostAnomaly' });
export type CostAnomaly = z.infer<typeof CostAnomalySchema>;

export const CostAnomaliesSchema = z
  .object({
    items: z.array(CostAnomalySchema),
    byType: z.array(
      z.object({ anomalyType: z.string(), count: z.number().int(), estMonthlyImpactUsd: z.number() }),
    ),
  })
  .meta({ id: 'CostAnomalies' });
export type CostAnomalies = z.infer<typeof CostAnomaliesSchema>;
