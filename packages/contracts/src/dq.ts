import { z } from 'zod';
import { PageQuerySchema, ReportIdSchema } from './common.js';

export const DqRuleSchema = z
  .object({
    ruleId: z.string(),
    ruleName: z.string(),
    category: z.string(),
    severity: z.string(),
    action: z.enum(['NORMALIZE', 'QUARANTINE', 'FLAG', 'RESTRUCTURE']),
    inBrief: z
      .boolean()
      .meta({ description: 'Listed in the case-study brief. False = found by profiling.' }),
    description: z.string(),
    rowsAffected: z.number().int(),
    reportsAffected: z.number().int(),
    pctOfRows: z.number(),
  })
  .meta({ id: 'DqRule' });
export type DqRule = z.infer<typeof DqRuleSchema>;

export const ReconciliationCheckSchema = z
  .object({
    checkId: z.string(),
    description: z.string(),
    expectedValue: z.number().nullable(),
    actualValue: z.number().nullable(),
    difference: z.number().nullable(),
    tolerance: z.number(),
    status: z.enum(['PASS', 'FAIL']),
  })
  .meta({ id: 'ReconciliationCheck' });
export type ReconciliationCheck = z.infer<typeof ReconciliationCheckSchema>;

export const DqSummarySchema = z
  .object({
    rowsLanded: z.number().int(),
    reports: z.number().int(),
    periods: z.number().int(),
    rowsQuarantined: z.number().int(),
    rulesTriggered: z.number().int(),
    rules: z.array(DqRuleSchema),
    reconciliation: z.array(ReconciliationCheckSchema),
    warehouse: z.object({
      dialect: z.string(),
      builtAt: z.string(),
      suiteDurationMs: z.number().int(),
      queryRowsSimulated: z.number().int(),
      queriesPerRow: z.number().int(),
    }),
  })
  .meta({ id: 'DqSummary' });
export type DqSummary = z.infer<typeof DqSummarySchema>;

export const DqFindingSchema = z
  .object({
    ruleId: z.string(),
    rowSeq: z.number().int().meta({ description: '1-based line number in the source file.' }),
    reportId: ReportIdSchema,
    periodSeq: z.number().int(),
    observedValue: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .meta({ id: 'DqFinding' });
export type DqFinding = z.infer<typeof DqFindingSchema>;

export const DqFindingsQuerySchema = PageQuerySchema.extend({
  ruleId: z
    .string()
    .regex(/^DQ-\d{2}$/)
    .optional(),
  reportId: ReportIdSchema.optional(),
});

export const QuarantineRowSchema = z
  .object({
    rowSeq: z.number().int(),
    reportId: ReportIdSchema,
    periodSeq: z.number().int(),
    ruleId: z.string(),
    reasonCode: z.string(),
    rawValue: z.string().nullable(),
    creditsReported: z.number().nullable(),
    creditsImputed: z.number().nullable(),
    costImputedUsd: z.number().nullable(),
  })
  .meta({ id: 'QuarantineRow' });
export type QuarantineRow = z.infer<typeof QuarantineRowSchema>;
