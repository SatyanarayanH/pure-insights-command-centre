import type { RefreshStatus } from '@picc/contracts';
import type { OpsDb } from '../opsdb/db.js';

export interface StoredObservation {
  reportId: string;
  observedAt: string;
  receivedAt: string;
  loadTimeSec: number | null;
  refreshStatus: RefreshStatus | null;
  creditsConsumed: number | null;
  source: string;
  eventId: string | null;
}

export interface SeriesRow {
  report_id: string;
  observed_at: string;
  load_time_sec: number | null;
  refresh_status: RefreshStatus | null;
  source: string;
}

/**
 * Every live reading, kept for a retention window. It serves two purposes: the trend charts
 * read it, and the unique `event_id` is what makes a resent event a no-op.
 *
 * At production volume this table belongs in a time-series store or back in Snowflake; the
 * queries below are the whole of what the application asks of it.
 */
export class ObservationRepository {
  constructor(private readonly db: OpsDb) {}

  insert(o: StoredObservation): void {
    this.db.run(
      `INSERT INTO observations (report_id, observed_at, received_at, load_time_sec, refresh_status,
         credits_consumed, source, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      o.reportId,
      o.observedAt,
      o.receivedAt,
      o.loadTimeSec,
      o.refreshStatus,
      o.creditsConsumed,
      o.source,
      o.eventId,
    );
  }

  hasEventId(eventId: string): boolean {
    return (
      this.db.get('SELECT 1 AS found FROM observations WHERE event_id = ?', eventId) !== undefined
    );
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM observations')?.n ?? 0;
  }

  /** When each report was last heard from, to carry "no data" detection across a restart. */
  lastReceivedByReport(): Map<string, string> {
    return new Map(
      this.db
        .all<{ report_id: string; last: string }>(
          'SELECT report_id, MAX(received_at) AS last FROM observations GROUP BY report_id',
        )
        .map((row) => [row.report_id, row.last]),
    );
  }

  /** Readings since `since`, oldest first. `reportIds` restricts to those reports. */
  since(since: string, reportIds?: readonly string[]): SeriesRow[] {
    if (reportIds && reportIds.length === 0) return [];
    const scope = reportIds ? `AND report_id IN (${reportIds.map(() => '?').join(', ')})` : '';
    return this.db.all<SeriesRow>(
      `SELECT report_id, observed_at, load_time_sec, refresh_status, source
       FROM observations WHERE observed_at >= ? ${scope} ORDER BY observed_at`,
      since,
      ...(reportIds ?? []),
    );
  }

  prune(before: string): number {
    return this.db.run('DELETE FROM observations WHERE received_at < ?', before).changes;
  }
}
