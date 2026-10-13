import { z } from 'zod';

export const REFRESH_STATUSES = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'] as const;
export const RefreshStatusSchema = z.enum(REFRESH_STATUSES).meta({
  id: 'RefreshStatus',
  description:
    'Outcome of the last automated refresh. UNKNOWN means the portal reported no outcome.',
});
export type RefreshStatus = z.infer<typeof RefreshStatusSchema>;

export const LatencySeveritySchema = z.enum(['OK', 'WARNING', 'HIGH', 'CRITICAL']).meta({
  id: 'LatencySeverity',
  description:
    'Load-time tier: WARNING above 15 s, HIGH above 30 s, CRITICAL above 45 s (defaults).',
});
export type LatencySeverity = z.infer<typeof LatencySeveritySchema>;

export const SEVERITIES = ['info', 'warning', 'high', 'critical'] as const;
export const SeveritySchema = z.enum(SEVERITIES).meta({ id: 'Severity' });
export type Severity = z.infer<typeof SeveritySchema>;
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3,
};

export const EfficiencyQuadrantSchema = z
  .enum(['ZOMBIE', 'COSTLY', 'WORKHORSE', 'EFFICIENT', 'NICHE'])
  .meta({ id: 'EfficiencyQuadrant' });
export type EfficiencyQuadrant = z.infer<typeof EfficiencyQuadrantSchema>;

export const ReportIdSchema = z
  .string()
  .regex(/^RPT_\d{1,6}$/)
  .meta({ description: 'Report identifier', example: 'RPT_203' });

export const IsoDateTimeSchema = z
  .string()
  .meta({ description: 'ISO-8601 timestamp (UTC)', format: 'date-time' });

/** Query-string booleans arrive as text. */
export const QueryBoolSchema = z.enum(['true', 'false']);

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
}

/** RFC 9457 problem details: the one error shape every endpoint returns. */
export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: z.string(),
    requestId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'Problem' });
export type Problem = z.infer<typeof ProblemSchema>;

export const OkSchema = z.object({ ok: z.literal(true) });
