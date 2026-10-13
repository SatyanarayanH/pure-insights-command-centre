import {
  type AlertSource,
  type TelemetryEvent,
  TelemetryEventSchema,
  type TelemetryIngestResponse,
} from '@picc/contracts';
import type { AlertEngine } from '../alerts/engine.js';
import type { AlertService } from '../alerts/service.js';
import type { EngineEvent, Observation } from '../alerts/types.js';
import type { OpsDb } from '../opsdb/db.js';
import type { ReportStateRepository } from '../opsdb/repositories.js';
import type { EventBus } from '../realtime/bus.js';
import type { OwnershipService } from '../services/ownership.js';
import type { WarehouseSnapshot } from '../warehouse/snapshot.js';
import type { ObservationRepository } from './observations.js';

export interface IngestOptions {
  source: AlertSource;
  /** Update state and alerts without broadcasting. Used to load history at start-up. */
  silent?: boolean;
}

const BACKFILL_KEY = 'telemetry.backfilled';
/** How far ahead of the server clock an emitter's timestamp may be. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The single path every observation takes, whoever sent it: the portal over HTTP, the
 * built-in simulator, the incident injector, or the start-up backfill.
 *
 *   validate -> drop resends -> update report state -> store the reading
 *            -> evaluate alert rules -> commit -> broadcast
 *
 * State, the stored reading and alerts are written in one transaction and events are broadcast
 * only after it commits, so a client is never told about an alert that a rollback then erases.
 */
export class TelemetryService {
  /** Running totals by outcome, read by the metrics endpoint. */
  readonly counts = { accepted: 0, rejected: 0, duplicate: 0 };
  /** When anything at all was last received, and when each report was. Drives "no data". */
  private lastReceived: string | null = null;
  private readonly lastReceivedByReport: Map<string, string>;

  constructor(
    private readonly db: OpsDb,
    private readonly state: ReportStateRepository,
    private readonly observations: ObservationRepository,
    private readonly engine: AlertEngine,
    private readonly alertService: AlertService,
    private readonly ownership: OwnershipService,
    private readonly bus: EventBus,
    private readonly now: () => Date,
  ) {
    this.lastReceivedByReport = observations.lastReceivedByReport();
    for (const at of this.lastReceivedByReport.values()) {
      if (this.lastReceived === null || at > this.lastReceived) this.lastReceived = at;
    }
  }

  get lastReceivedAt(): string | null {
    return this.lastReceived;
  }

  lastReceivedFor(reportId: string): string | null {
    return this.lastReceivedByReport.get(reportId) ?? null;
  }

  /** Validates each element on its own: one malformed event does not reject the batch. */
  ingestRaw(rawEvents: readonly unknown[], options: IngestOptions): TelemetryIngestResponse {
    const valid: TelemetryEvent[] = [];
    const rejected: TelemetryIngestResponse['rejected'] = [];
    let duplicates = 0;
    /** Newest explicit timestamp accepted so far in this batch, per report. */
    const newest = new Map<string, string>();
    const idsInBatch = new Set<string>();
    rawEvents.forEach((raw, index) => {
      const parsed = TelemetryEventSchema.safeParse(raw);
      if (!parsed.success) {
        rejected.push({
          index,
          reason: parsed.error.issues
            .map((i) => `${i.path.join('.') || 'event'}: ${i.message}`)
            .join('; '),
        });
      } else if (!this.ownership.exists(parsed.data.reportId)) {
        rejected.push({ index, reason: `Unknown report ${parsed.data.reportId}` });
      } else if (
        parsed.data.eventId &&
        (idsInBatch.has(parsed.data.eventId) || this.observations.hasEventId(parsed.data.eventId))
      ) {
        // A resend, usually because the emitter timed out waiting for the first response.
        // Checked before the ordering rule so it is acknowledged, not reported as out of order.
        duplicates += 1;
      } else {
        const reason = this.timestampProblem(parsed.data, newest);
        if (reason) rejected.push({ index, reason });
        else {
          if (parsed.data.observedAt) {
            // Normalise to UTC so later comparisons are plain string comparisons.
            parsed.data.observedAt = new Date(parsed.data.observedAt).toISOString();
            newest.set(parsed.data.reportId, parsed.data.observedAt);
          }
          if (parsed.data.eventId) idsInBatch.add(parsed.data.eventId);
          valid.push(parsed.data);
        }
      }
    });
    const events = this.ingest(valid, options);
    this.counts.rejected += rejected.length;
    this.counts.duplicate += duplicates;
    return {
      accepted: valid.length,
      duplicates,
      rejected,
      alertsFired: events.filter(
        (e) => e.type === 'fired' || (e.type === 'updated' && e.change === 'reopened'),
      ).length,
      alertsResolved: events.filter((e) => e.type === 'resolved').length,
    };
  }

  /**
   * An emitter-supplied timestamp is refused when it cannot be right: in the future beyond
   * clock skew, or older than what is already held for the report. Applying a late event would
   * overwrite the report's current state with a stale one. Events without a timestamp are
   * stamped on receipt and are always in order.
   */
  private timestampProblem(
    event: TelemetryEvent,
    newestInBatch: Map<string, string>,
  ): string | null {
    if (!event.observedAt) return null;
    const observedAt = new Date(event.observedAt);
    if (observedAt.getTime() > this.now().getTime() + MAX_CLOCK_SKEW_MS) {
      return 'observedAt is in the future';
    }
    const held = newestInBatch.get(event.reportId) ?? this.state.get(event.reportId)?.observedAt;
    if (held && observedAt.toISOString() < held) {
      return `Out of order: older than the latest observation held for ${event.reportId} (${held})`;
    }
    return null;
  }

  ingest(events: readonly TelemetryEvent[], options: IngestOptions): EngineEvent[] {
    if (events.length === 0) return [];
    const receivedAt = this.now().toISOString();
    const engineEvents: EngineEvent[] = [];
    const observed: { observation: Observation; breach: boolean }[] = [];
    // History replayed at start-up is not a live reading: it is neither stored nor counted as
    // the feed being alive.
    const live = options.source !== 'backfill';

    this.db.transaction(() => {
      for (const event of events) {
        const observedAt = event.observedAt ?? receivedAt;
        const previous = this.state.get(event.reportId);
        let streak = previous?.refreshFailureStreak ?? 0;
        if (event.refreshStatus === 'FAILED' || event.refreshStatus === 'TIMED_OUT') streak += 1;
        else if (event.refreshStatus === 'SUCCESS') streak = 0;
        // UNKNOWN leaves the streak alone: no evidence either way.

        this.state.save({
          reportId: event.reportId,
          loadTimeSec: event.loadTimeSec ?? previous?.loadTimeSec ?? null,
          refreshStatus: event.refreshStatus ?? previous?.refreshStatus ?? null,
          refreshFailureStreak: streak,
          observedAt,
          source: options.source,
        });

        const observation: Observation = {
          reportId: event.reportId,
          observedAt,
          loadTimeSec: event.loadTimeSec,
          refreshStatus: event.refreshStatus,
          refreshFailureStreak: streak,
          creditsConsumed: event.creditsConsumed,
          ...(live ? { silentForMin: 0 } : {}),
          source: options.source,
        };
        if (live) {
          this.observations.insert({
            reportId: event.reportId,
            observedAt,
            receivedAt,
            loadTimeSec: event.loadTimeSec ?? null,
            refreshStatus: event.refreshStatus ?? null,
            creditsConsumed: event.creditsConsumed ?? null,
            source: options.source,
            eventId: event.eventId ?? null,
          });
        }
        const produced = this.engine.process(observation);
        engineEvents.push(...produced);
        observed.push({
          observation,
          breach: produced.some(
            (e) => e.type === 'fired' || (e.type === 'updated' && e.change !== 'recovering'),
          ),
        });
      }
    });

    if (live) {
      this.counts.accepted += events.length;
      this.lastReceived = receivedAt;
      for (const event of events) this.lastReceivedByReport.set(event.reportId, receivedAt);
    }

    if (!options.silent) {
      for (const { observation, breach } of observed) {
        this.bus.publish(
          'telemetry.observed',
          'telemetry',
          {
            reportId: observation.reportId,
            observedAt: observation.observedAt,
            loadTimeSec: observation.loadTimeSec ?? null,
            refreshStatus: observation.refreshStatus ?? null,
            breach,
            source: observation.source,
          },
          observation.reportId,
        );
      }
      this.alertService.publish(engineEvents);
    }
    return engineEvents;
  }

  /**
   * Applies an observation that no emitter sent: the staleness monitor's "this report has gone
   * quiet". It goes through the same engine, so a stale report gets an ordinary alert with the
   * ordinary lifecycle, and the next real reading resolves it.
   */
  applySynthetic(observation: Observation): EngineEvent[] {
    const events = this.db.transaction(() => this.engine.process(observation));
    this.alertService.publish(events);
    return events;
  }

  /**
   * Replays the dataset's 20 periods through the same pipeline, oldest first, once. The alert
   * history a new installation starts with is therefore computed by the real engine from the
   * real data rather than invented: streaks, reopen counts and timelines are all genuine.
   */
  backfill(snapshot: WarehouseSnapshot): { ran: boolean; observations: number } {
    if (this.db.getMeta(BACKFILL_KEY)) return { ran: false, observations: 0 };
    const byPeriod = [...snapshot.facts].sort(
      (a, b) => a.period_seq - b.period_seq || a.row_seq - b.row_seq,
    );
    this.ingest(
      byPeriod.map((fact) => ({
        reportId: fact.report_id,
        observedAt: fact.period_end,
        loadTimeSec: fact.avg_load_time_sec ?? undefined,
        refreshStatus: fact.refresh_status,
        creditsConsumed: fact.credits_reported ?? undefined,
      })),
      { source: 'backfill', silent: true },
    );
    this.db.setMeta(BACKFILL_KEY, this.now().toISOString());
    return { ran: true, observations: byPeriod.length };
  }
}
