/**
 * ACCOUNT_USAGE simulator.
 *
 * The case-study dataset contains per-report totals only. Task 3 asks for SQL against
 * Snowflake ACCOUNT_USAGE logs, so this module disaggregates those totals into tables shaped
 * like the real views: QUERY_HISTORY, QUERY_ATTRIBUTION_HISTORY, WAREHOUSE_METERING_HISTORY.
 *
 * Design rules:
 *  1. Pure disaggregation. For every (report, period) the simulated query credits sum back to
 *     the dataset value exactly, defects included. Cleaning is the SQL suite's job, not ours.
 *  2. Deterministic. Same input + same params = byte-identical output.
 *  3. Honest about scale. One simulated row stands for ~queriesPerRow real queries (a micro-batch
 *     carrying their combined credits and elapsed time), so the suite runs on a laptop in seconds.
 *
 * Simulator assumptions that are NOT in the dataset are listed in docs/assumptions.md.
 */
import { createHash } from 'node:crypto';
import { csvLine, parseCsvObjects } from './csv.js';
import { createRng, hashSeed } from './prng.js';

export const SIMULATOR_VERSION = 3;

export interface SimulationParams {
  seed: string;
  /** Real queries represented by one simulated row. An integer divisor (not a fraction) so the
   *  row count rounds identically in JavaScript, DuckDB and Snowflake. */
  queriesPerRow: number;
  periodDays: number;
  /** Exclusive end of the last period, ISO-8601 UTC. */
  anchorEnd: string;
}

export const DEFAULT_SIMULATION_PARAMS: SimulationParams = {
  seed: 'pure-insights-2026',
  queriesPerRow: 100,
  periodDays: 30,
  anchorEnd: '2026-10-01T00:00:00.000Z',
};

interface WarehouseDef {
  id: number;
  name: string;
  size: string;
  creditsPerHour: number;
}

export const WAREHOUSES: readonly WarehouseDef[] = [
  { id: 11, name: 'PI_PORTAL_WH', size: 'X-Large', creditsPerHour: 16 },
  { id: 12, name: 'PI_PORTAL_HEAVY_WH', size: '2X-Large', creditsPerHour: 32 },
];

/** Every portal query runs as one service user, which is why QUERY_TAG is the only handle
 *  for attributing spend to a report. */
const PORTAL_SERVICE_USER = 'PI_SVC_PORTAL';

/** Workloads that share the portal warehouses but belong to no catalogued report. Their credits
 *  are sized as a fraction of each period's report credits. */
const OTHER_WORKLOADS = [
  { kind: 'dbt', rows: 40, share: 0.02, warehouse: 1, user: 'DBT_SVC', hours: [1, 2, 3, 4] },
  { kind: 'adhoc', rows: 30, share: 0.015, warehouse: 0, user: null, hours: null },
  { kind: 'legacy', rows: 10, share: 0.005, warehouse: 0, user: PORTAL_SERVICE_USER, hours: null },
  { kind: 'ghost', rows: 5, share: 0.003, warehouse: 1, user: PORTAL_SERVICE_USER, hours: null },
] as const;

export const GHOST_REPORT_ID = 'RPT_999';

// Relative query volume by hour of day (UTC) and by weekday/weekend.
const HOUR_WEIGHTS = [
  0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.5, 0.8, 1.4, 1.8, 1.9, 1.8, 1.5, 1.7, 1.8, 1.7, 1.5, 1.1, 0.8,
  0.6, 0.4, 0.3, 0.25, 0.2,
];
const WEEKEND_WEIGHT = 0.35;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface Period {
  periodSeq: number;
  start: Date;
  end: Date;
}

export interface SimulationManifest {
  simulatorVersion: number;
  params: SimulationParams;
  inputSha256: string;
  periods: number;
  reports: number;
  rows: { telemetry: number; queryHistory: number; queryAttribution: number; warehouseMetering: number };
  totals: {
    creditsReportedPositive: number;
    creditsReportedNegative: number;
    creditsOtherWorkloads: number;
    creditsMeteredCompute: number;
    creditsAttributedInMetering: number;
  };
}

export interface Simulation {
  manifest: SimulationManifest;
  periods: Period[];
  files: Record<SimulationFile, string>;
}

export const SIMULATION_FILES = [
  'period_calendar.csv',
  'sim_params.csv',
  'query_history.csv',
  'query_attribution_history.csv',
  'warehouse_metering_history.csv',
] as const;
export type SimulationFile = (typeof SIMULATION_FILES)[number];

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 'YYYY-MM-DD HH:MM:SS.mmm' in UTC: parses identically in DuckDB and Snowflake. */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function queryId(rng: ReturnType<typeof createRng>): string {
  const h = rng.hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function buildPeriods(count: number, params: SimulationParams): Period[] {
  const anchor = Date.parse(params.anchorEnd);
  const length = params.periodDays * DAY_MS;
  return Array.from({ length: count }, (_, periodSeq) => {
    const start = anchor - (count - periodSeq) * length;
    return { periodSeq, start: new Date(start), end: new Date(start + length) };
  });
}

interface ReportPeriodInput {
  reportId: string;
  periodSeq: number;
  queryCount: number;
  credits: number;
}

/** Reads the raw dataset. Period is the nth occurrence of a report id, in file order. */
export function readReportPeriods(rawCsv: string): ReportPeriodInput[] {
  const seen = new Map<string, number>();
  return parseCsvObjects(rawCsv).map((row) => {
    const reportId = (row.report_id ?? '').trim();
    const periodSeq = seen.get(reportId) ?? 0;
    seen.set(reportId, periodSeq + 1);
    return {
      reportId,
      periodSeq,
      queryCount: Number(row.query_count_last_30d),
      credits: Number(row.snowflake_credits_consumed),
    };
  });
}

/** Number of simulated rows for a report-period. Mirrored by reconciliation check R15. */
export function simulatedQueryRows(queryCount: number, queriesPerRow: number): number {
  return Math.max(1, Math.round(queryCount / queriesPerRow));
}

export function simulateAccountUsage(rawCsv: string, params: SimulationParams): Simulation {
  const inputs = readReportPeriods(rawCsv);
  const periodCount = Math.max(...inputs.map((r) => r.periodSeq)) + 1;
  const periods = buildPeriods(periodCount, params);

  // A negative value is a defect in the reported figure, not evidence that the queries were
  // free. The warehouse still ran them, so elapsed time and metering use the report's median
  // valid credits as the assumed true cost.
  const validCreditsByReport = new Map<string, number[]>();
  for (const r of inputs) {
    if (r.credits >= 0) {
      const list = validCreditsByReport.get(r.reportId) ?? [];
      list.push(r.credits);
      validCreditsByReport.set(r.reportId, list);
    }
  }

  const queryHistory: string[] = [
    csvLine([
      'QUERY_ID',
      'QUERY_TYPE',
      'USER_NAME',
      'ROLE_NAME',
      'WAREHOUSE_ID',
      'WAREHOUSE_NAME',
      'WAREHOUSE_SIZE',
      'QUERY_TAG',
      'EXECUTION_STATUS',
      'START_TIME',
      'END_TIME',
      'TOTAL_ELAPSED_TIME',
      'EXECUTION_TIME',
      'COMPILATION_TIME',
      'BYTES_SCANNED',
    ]),
  ];
  const attribution: string[] = [
    csvLine([
      'QUERY_ID',
      'WAREHOUSE_ID',
      'WAREHOUSE_NAME',
      'QUERY_TAG',
      'USER_NAME',
      'START_TIME',
      'END_TIME',
      'CREDITS_ATTRIBUTED_COMPUTE',
      'CREDITS_USED_QUERY_ACCELERATION',
    ]),
  ];

  /** True compute credits per warehouse-hour, keyed `${warehouseIndex}:${hourStartMs}`. */
  const hourCredits = new Map<string, number>();
  const totals = {
    creditsReportedPositive: 0,
    creditsReportedNegative: 0,
    creditsOtherWorkloads: 0,
    creditsMeteredCompute: 0,
    creditsAttributedInMetering: 0,
  };

  const emitQueries = (opts: {
    rngKey: string;
    period: Period;
    rows: number;
    reportedCredits: number;
    trueCredits: number;
    warehouseIndex: number;
    user: (i: number, rng: ReturnType<typeof createRng>) => string;
    tag: (i: number, rng: ReturnType<typeof createRng>) => string | null;
    hours: readonly number[] | null;
  }): void => {
    const rng = createRng(`${params.seed}:${opts.rngKey}`);
    const warehouse = WAREHOUSES[opts.warehouseIndex]!;
    const msPerCredit = HOUR_MS / warehouse.creditsPerHour;

    const weights = Array.from({ length: opts.rows }, () => rng.logNormal(0, 0.9));
    const weightTotal = weights.reduce((a, b) => a + b, 0);

    // Round each query to 6 dp, then put the rounding residual on the largest query so the
    // period sum equals the dataset value exactly.
    const reported = weights.map((w) => round((opts.reportedCredits * w) / weightTotal, 6));
    const residual = round(opts.reportedCredits - reported.reduce((a, b) => a + b, 0), 6);
    const largest = weights.indexOf(Math.max(...weights));
    reported[largest] = round(reported[largest]! + residual, 6);

    const days = Math.round((opts.period.end.getTime() - opts.period.start.getTime()) / DAY_MS);
    const dayWeights = Array.from({ length: days }, (_, d) => {
      const dow = new Date(opts.period.start.getTime() + d * DAY_MS).getUTCDay();
      return dow === 0 || dow === 6 ? WEEKEND_WEIGHT : 1;
    });

    for (let i = 0; i < opts.rows; i++) {
      const trueCredits = (opts.trueCredits * weights[i]!) / weightTotal;
      // Concurrency means elapsed time is not perfectly proportional to credits.
      const executionMs = Math.max(200, Math.round(trueCredits * msPerCredit * rng.logNormal(0, 0.2)));
      const compilationMs = 40 + rng.int(260);
      const elapsedMs = executionMs + compilationMs;

      const day = rng.weighted(dayWeights);
      const hour = opts.hours ? opts.hours[rng.int(opts.hours.length)]! : rng.weighted(HOUR_WEIGHTS);
      let startMs = opts.period.start.getTime() + day * DAY_MS + hour * HOUR_MS + rng.int(HOUR_MS);
      // Keep each query inside its own period so period totals reconcile exactly.
      if (startMs + elapsedMs > opts.period.end.getTime()) {
        startMs = opts.period.end.getTime() - elapsedMs - rng.int(HOUR_MS);
      }
      const endMs = startMs + elapsedMs;

      const id = queryId(rng);
      const tag = opts.tag(i, rng);
      const user = opts.user(i, rng);
      const start = formatTimestamp(startMs);
      const end = formatTimestamp(endMs);

      queryHistory.push(
        csvLine([
          id,
          'SELECT',
          user,
          user === PORTAL_SERVICE_USER ? 'PI_PORTAL_ROLE' : 'ANALYST_ROLE',
          warehouse.id,
          warehouse.name,
          warehouse.size,
          tag,
          'SUCCESS',
          start,
          end,
          elapsedMs,
          executionMs,
          compilationMs,
          Math.round(trueCredits * 4.2e9 * rng.uniform(0.6, 1.4)),
        ]),
      );
      attribution.push(
        csvLine([id, warehouse.id, warehouse.name, tag, user, start, end, reported[i]!, 0]),
      );

      // Spread the true credits over the warehouse-hours the query was running in.
      for (let hourStart = Math.floor(startMs / HOUR_MS) * HOUR_MS; hourStart < endMs; hourStart += HOUR_MS) {
        const overlap = Math.min(endMs, hourStart + HOUR_MS) - Math.max(startMs, hourStart);
        const key = `${opts.warehouseIndex}:${hourStart}`;
        hourCredits.set(key, (hourCredits.get(key) ?? 0) + (trueCredits * overlap) / elapsedMs);
      }
    }
  };

  const reportCreditsByPeriod = new Array<number>(periodCount).fill(0);

  for (const input of inputs) {
    const isDefective = input.credits < 0;
    const trueCredits = isDefective
      ? median(validCreditsByReport.get(input.reportId) ?? [])
      : input.credits;
    if (isDefective) totals.creditsReportedNegative += input.credits;
    else totals.creditsReportedPositive += input.credits;
    reportCreditsByPeriod[input.periodSeq]! += trueCredits;

    emitQueries({
      rngKey: `${input.reportId}:${input.periodSeq}`,
      period: periods[input.periodSeq]!,
      rows: simulatedQueryRows(input.queryCount, params.queriesPerRow),
      reportedCredits: input.credits,
      trueCredits,
      warehouseIndex: hashSeed(input.reportId) % WAREHOUSES.length,
      user: () => PORTAL_SERVICE_USER,
      tag: (_i, rng) =>
        JSON.stringify({
          app: 'pure-insights',
          report_id: input.reportId,
          component: rng.next() < 0.15 ? 'refresh' : 'dashboard',
        }),
      hours: null,
    });
  }

  for (const period of periods) {
    for (const workload of OTHER_WORKLOADS) {
      const rng = createRng(`${params.seed}:${workload.kind}:${period.periodSeq}:size`);
      const credits = round(
        reportCreditsByPeriod[period.periodSeq]! * workload.share * rng.uniform(0.85, 1.15),
        2,
      );
      totals.creditsOtherWorkloads += credits;
      emitQueries({
        rngKey: `${workload.kind}:${period.periodSeq}`,
        period,
        rows: workload.rows,
        reportedCredits: credits,
        trueCredits: credits,
        warehouseIndex: workload.warehouse,
        user: (_i, r) => workload.user ?? `ANALYST_${String(1 + r.int(8)).padStart(2, '0')}`,
        tag: () => {
          switch (workload.kind) {
            case 'dbt':
              return JSON.stringify({ app: 'dbt', job: 'nightly_models' });
            case 'adhoc':
              return null;
            case 'legacy':
              return 'pure-insights;legacy-export';
            case 'ghost':
              return JSON.stringify({
                app: 'pure-insights',
                report_id: GHOST_REPORT_ID,
                component: 'refresh',
              });
          }
        },
        hours: workload.hours,
      });
    }
  }

  // Hourly metering: credits attributed to queries plus idle time the warehouse stayed up for.
  const metering: string[] = [
    csvLine([
      'START_TIME',
      'END_TIME',
      'WAREHOUSE_ID',
      'WAREHOUSE_NAME',
      'CREDITS_USED',
      'CREDITS_USED_COMPUTE',
      'CREDITS_USED_CLOUD_SERVICES',
      'CREDITS_ATTRIBUTED_COMPUTE_QUERIES',
    ]),
  ];
  const hourKeys = [...hourCredits.keys()].sort((a, b) => {
    const [wa, ha] = a.split(':').map(Number) as [number, number];
    const [wb, hb] = b.split(':').map(Number) as [number, number];
    return ha - hb || wa - wb;
  });
  for (const key of hourKeys) {
    const [warehouseIndex, hourStart] = key.split(':').map(Number) as [number, number];
    const warehouse = WAREHOUSES[warehouseIndex]!;
    const rng = createRng(`${params.seed}:metering:${key}`);
    const attributed = round(hourCredits.get(key)!, 9);
    const compute = round(attributed * (1 + rng.uniform(0.04, 0.3)), 9);
    const cloudServices = round(compute * rng.uniform(0.01, 0.04), 9);
    totals.creditsMeteredCompute += compute;
    totals.creditsAttributedInMetering += attributed;
    metering.push(
      csvLine([
        formatTimestamp(hourStart),
        formatTimestamp(hourStart + HOUR_MS),
        warehouse.id,
        warehouse.name,
        round(compute + cloudServices, 9),
        compute,
        cloudServices,
        attributed,
      ]),
    );
  }

  const calendar = [
    csvLine(['PERIOD_SEQ', 'PERIOD_START', 'PERIOD_END']),
    ...periods.map((p) =>
      csvLine([p.periodSeq, formatTimestamp(p.start.getTime()), formatTimestamp(p.end.getTime())]),
    ),
  ];
  const simParams = [
    csvLine(['QUERIES_PER_ROW', 'PERIOD_DAYS', 'SEED', 'SIMULATOR_VERSION']),
    csvLine([params.queriesPerRow, params.periodDays, params.seed, SIMULATOR_VERSION]),
  ];

  const join = (lines: string[]): string => `${lines.join('\n')}\n`;
  const manifest: SimulationManifest = {
    simulatorVersion: SIMULATOR_VERSION,
    params,
    inputSha256: sha256(rawCsv),
    periods: periodCount,
    reports: new Set(inputs.map((r) => r.reportId)).size,
    rows: {
      telemetry: inputs.length,
      queryHistory: queryHistory.length - 1,
      queryAttribution: attribution.length - 1,
      warehouseMetering: metering.length - 1,
    },
    totals: {
      creditsReportedPositive: round(totals.creditsReportedPositive, 2),
      creditsReportedNegative: round(totals.creditsReportedNegative, 2),
      creditsOtherWorkloads: round(totals.creditsOtherWorkloads, 2),
      creditsMeteredCompute: round(totals.creditsMeteredCompute, 4),
      creditsAttributedInMetering: round(totals.creditsAttributedInMetering, 4),
    },
  };

  return {
    manifest,
    periods,
    files: {
      'period_calendar.csv': join(calendar),
      'sim_params.csv': join(simParams),
      'query_history.csv': join(queryHistory),
      'query_attribution_history.csv': join(attribution),
      'warehouse_metering_history.csv': join(metering),
    },
  };
}
