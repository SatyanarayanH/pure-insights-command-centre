import { evaluate } from '../alerts/rules.js';
import type { AlertService } from '../alerts/service.js';
import type { Observation } from '../alerts/types.js';
import type { NotificationService } from '../notifications/service.js';
import type { EventBus } from '../realtime/bus.js';
import type { OwnershipService } from '../services/ownership.js';
import type { ObservationRepository } from './observations.js';
import type { TelemetryService } from './service.js';

export interface StalenessOptions {
  /** No telemetry from anything for this long means the feed itself is down. */
  feedSilentAfterSec: number;
  sweepIntervalMs: number;
  /** Stored readings older than this are deleted. */
  retentionDays: number;
}

const PRUNE_EVERY_MS = 10 * 60_000;

/**
 * Notices when data stops arriving. Every other rule judges a reading; this one judges the
 * absence of one, which nothing else in the pipeline can see.
 *
 * Two different failures look the same from one report's point of view, so they are told apart:
 *
 *   the whole feed is silent  -> one system-wide condition, one notification to the admins.
 *                                Raising an alert per report would bury the single real cause
 *                                under a hundred symptoms, so per-report checks are suspended.
 *   one report is silent      -> an ordinary `telemetry_stale` alert on that report, routed to
 *                                its owner, cleared by its next reading.
 *
 * A report is measured from the latest of: its last reading, process start, and the moment the
 * feed last came back. A restart or an outage therefore grants a fresh grace period rather than
 * firing for everything at once.
 */
export class StalenessMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt: number;
  private feedRecoveredAt = 0;
  private feedSilent = false;
  private lastPrunedAt = 0;

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly observations: ObservationRepository,
    private readonly alerts: AlertService,
    private readonly ownership: OwnershipService,
    private readonly bus: EventBus,
    private readonly notifications: NotificationService,
    private readonly now: () => Date,
    private readonly options: StalenessOptions,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.startedAt = now().getTime();
  }

  get isFeedSilent(): boolean {
    return this.feedSilent;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
        this.notifications.sweep();
      } catch (error) {
        this.onError(error);
      }
    }, this.options.sweepIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sweep(): { feedSilent: boolean; markedStale: number } {
    const now = this.now();
    const nowMs = now.getTime();
    const last = this.telemetry.lastReceivedAt;
    const lastFeedMs = Math.max(this.startedAt, last ? Date.parse(last) : 0);
    const silent = nowMs - lastFeedMs > this.options.feedSilentAfterSec * 1000;

    if (silent !== this.feedSilent) {
      this.feedSilent = silent;
      const minutes = Math.round((nowMs - lastFeedMs) / 60_000);
      if (silent) {
        const message = `No telemetry has been received from any report for ${minutes} minute${minutes === 1 ? '' : 's'}. Health figures are as of the last reading; per-report staleness alerts are suspended until the feed returns.`;
        this.bus.publish('system.notice', 'system', {
          level: 'warning',
          code: 'telemetry.feed_silent',
          message,
        });
        this.notifications.enqueueSystem(
          'feed_silent',
          new Date(lastFeedMs).toISOString(),
          '[FEED DOWN] No telemetry is arriving',
          message,
        );
      } else {
        this.feedRecoveredAt = nowMs;
        const message = 'Telemetry is arriving again.';
        this.bus.publish('system.notice', 'system', {
          level: 'info',
          code: 'telemetry.feed_recovered',
          message,
        });
        this.notifications.enqueueSystem(
          'feed_recovered',
          now.toISOString(),
          '[FEED RESTORED] Telemetry is arriving again',
          message,
        );
      }
    }

    let markedStale = 0;
    const rule = this.alerts.listRules().find((r) => r.id === 'telemetry_stale');
    if (!silent && rule?.enabled) {
      const baseline = Math.max(this.startedAt, this.feedRecoveredAt);
      for (const reportId of this.ownership.reportIds()) {
        const seen = this.telemetry.lastReceivedFor(reportId);
        const sinceMs = Math.max(baseline, seen ? Date.parse(seen) : 0);
        const observation: Observation = {
          reportId,
          observedAt: now.toISOString(),
          silentForMin: (nowMs - sinceMs) / 60_000,
          source: 'monitor',
        };
        const evaluation = evaluate(rule, observation);
        if (!evaluation?.breach) continue;
        // Already open at this severity: nothing new to say until it worsens or clears.
        if (this.alerts.openAlert('telemetry_stale', reportId)?.severity === evaluation.severity)
          continue;
        this.telemetry.applySynthetic(observation);
        markedStale += 1;
      }
    }

    if (nowMs - this.lastPrunedAt > PRUNE_EVERY_MS) {
      this.lastPrunedAt = nowMs;
      this.observations.prune(
        new Date(nowMs - this.options.retentionDays * 86_400_000).toISOString(),
      );
    }
    return { feedSilent: silent, markedStale };
  }
}
