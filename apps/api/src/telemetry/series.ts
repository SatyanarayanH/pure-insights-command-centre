import type { TelemetrySeries, TelemetryWindow } from '@picc/contracts';
import type { AlertService } from '../alerts/service.js';
import type { Principal } from '../auth/principal.js';
import { notFound } from '../http/errors.js';
import type { OwnershipService } from '../services/ownership.js';
import type { ObservationRepository, SeriesRow } from './observations.js';

const WINDOWS: Record<TelemetryWindow, { minutes: number; bucketMinutes: number }> = {
  '1h': { minutes: 60, bucketMinutes: 2 },
  '6h': { minutes: 360, bucketMinutes: 10 },
  '24h': { minutes: 1440, bucketMinutes: 30 },
};
const POINTS_FOR_ONE_REPORT = 200;

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100) / 100;

/**
 * Live load time and refresh outcomes over the last hours, from the stored readings.
 *
 * The 20 periods in the dataset say how a report behaved month to month; this says how it is
 * behaving now. Buckets are fixed-width and aligned to the clock, and an empty bucket is
 * returned as empty rather than skipped, so a gap in the feed shows as a gap in the chart.
 */
export class TelemetrySeriesService {
  /** Charts poll, and most polls find nothing new. A result is reused for as long as no reading
   *  has arrived and the clock has not moved into the next bucket, so it is never stale. */
  private readonly cache = new Map<
    string,
    { version: number; firstStart: number; value: TelemetrySeries }
  >();

  constructor(
    private readonly observations: ObservationRepository,
    private readonly ownership: OwnershipService,
    private readonly alerts: AlertService,
    private readonly now: () => Date,
    /** Changes whenever a reading is stored. */
    private readonly version: () => number,
  ) {}

  series(principal: Principal, window: TelemetryWindow, reportId?: string): TelemetrySeries {
    // 404, not 403, for a report outside the caller's scope: do not confirm it exists.
    if (reportId && !this.ownership.canSee(principal, reportId)) throw notFound('Report');
    const nowMs = this.now().getTime();
    const threshold =
      this.alerts.listRules().find((rule) => rule.id === 'latency')?.warningThreshold ?? 15;
    // An owner's view depends on what they own today, which can change with no new reading;
    // it is small and cheap, so it is simply computed each time.
    const key =
      reportId || principal.scope === 'all' ? `${window}:${reportId ?? '*'}:${threshold}` : null;

    const { minutes, bucketMinutes } = WINDOWS[window];
    const bucketMs = bucketMinutes * 60_000;
    const buckets = minutes / bucketMinutes;
    // The newest bucket is the one in progress; the window is the `buckets` ending with it.
    const firstStart = (Math.floor(nowMs / bucketMs) - (buckets - 1)) * bucketMs;
    const version = this.version();
    const held = key ? this.cache.get(key) : undefined;
    if (held && held.version === version && held.firstStart === firstStart) return held.value;
    const scope = reportId ? [reportId] : (this.ownership.visibleReportIds(principal) ?? undefined);
    const rows = this.observations.since(new Date(firstStart).toISOString(), scope);

    const perBucket: SeriesRow[][] = Array.from({ length: buckets }, () => []);
    for (const row of rows) {
      const index = Math.floor((Date.parse(row.observed_at) - firstStart) / bucketMs);
      // A reading stamped slightly ahead of the server clock belongs in the newest bucket.
      perBucket[Math.min(Math.max(index, 0), buckets - 1)]!.push(row);
    }

    const isBreach = (row: SeriesRow) =>
      row.load_time_sec !== null && row.load_time_sec > threshold;
    const isFailure = (row: SeriesRow) =>
      row.refresh_status === 'FAILED' || row.refresh_status === 'TIMED_OUT';

    const value: TelemetrySeries = {
      window,
      bucketMinutes,
      thresholdSec: threshold,
      reportId: reportId ?? null,
      totals: {
        observations: rows.length,
        latencyBreaches: rows.filter(isBreach).length,
        refreshFailures: rows.filter(isFailure).length,
        reports: new Set(rows.map((row) => row.report_id)).size,
      },
      buckets: perBucket.map((bucket, index) => {
        const loads = bucket
          .map((row) => row.load_time_sec)
          .filter((v): v is number => v !== null)
          .sort((a, b) => a - b);
        return {
          start: new Date(firstStart + index * bucketMs).toISOString(),
          observations: bucket.length,
          p50LoadSec: round(quantile(loads, 0.5)),
          p95LoadSec: round(quantile(loads, 0.95)),
          maxLoadSec: loads.at(-1) ?? null,
          latencyBreaches: bucket.filter(isBreach).length,
          refreshFailures: bucket.filter(isFailure).length,
        };
      }),
      points: reportId
        ? rows.slice(-POINTS_FOR_ONE_REPORT).map((row) => ({
            observedAt: row.observed_at,
            loadTimeSec: row.load_time_sec,
            refreshStatus: row.refresh_status,
            source: row.source,
          }))
        : [],
    };
    if (key) this.cache.set(key, { version, firstStart, value });
    if (this.cache.size > 500) this.cache.clear();
    return value;
  }
}
