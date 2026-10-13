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

export interface IngestOptions {
  source: AlertSource;
  /** Update state and alerts without broadcasting. Used to load history at start-up. */
  silent?: boolean;
}

const BACKFILL_KEY = 'telemetry.backfilled';

/**
 * The single path every observation takes, whoever sent it: the portal over HTTP, the
 * built-in simulator, the incident injector, or the start-up backfill.
 *
 *   validate -> update report state -> evaluate alert rules -> commit -> broadcast
 *
 * State and alerts are written in one transaction and events are broadcast only after it
 * commits, so a client is never told about an alert that a rollback then erases.
 */
export class TelemetryService {
  constructor(
    private readonly db: OpsDb,
    private readonly state: ReportStateRepository,
    private readonly engine: AlertEngine,
    private readonly alertService: AlertService,
    private readonly ownership: OwnershipService,
    private readonly bus: EventBus,
    private readonly now: () => Date,
  ) {}

  /** Validates each element on its own: one malformed event does not reject the batch. */
  ingestRaw(rawEvents: readonly unknown[], options: IngestOptions): TelemetryIngestResponse {
    const valid: TelemetryEvent[] = [];
    const rejected: TelemetryIngestResponse['rejected'] = [];
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
      } else {
        valid.push(parsed.data);
      }
    });
    const events = this.ingest(valid, options);
    return {
      accepted: valid.length,
      rejected,
      alertsFired: events.filter(
        (e) => e.type === 'fired' || (e.type === 'updated' && e.change === 'reopened'),
      ).length,
      alertsResolved: events.filter((e) => e.type === 'resolved').length,
    };
  }

  ingest(events: readonly TelemetryEvent[], options: IngestOptions): EngineEvent[] {
    if (events.length === 0) return [];
    const receivedAt = this.now().toISOString();
    const engineEvents: EngineEvent[] = [];
    const observed: { observation: Observation; breach: boolean }[] = [];

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
          source: options.source,
        };
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
