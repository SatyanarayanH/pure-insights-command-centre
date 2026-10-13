import { randomUUID } from 'node:crypto';
import type { AlertRule } from '@picc/contracts';
import type { AlertRepository } from './repository.js';
import { evaluate, isMoreSevere } from './rules.js';
import type { AlertRecord, EngineEvent, Evaluation, Observation } from './types.js';

/** A breach this many healthy observations after a resolve reopens the alert instead of
 *  opening a new one. Keeps a flapping report as one incident with a reopen count. */
export const REOPEN_WITHIN_OBSERVATIONS = 3;
/** Reopened at least this often = flapping. Clients stop toasting for it. */
export const FLAPPING_REOPEN_COUNT = 2;

/**
 * Alert lifecycle.
 *
 *            breach                    ack                       healthy x resolveAfter
 *   (none) --------> FIRING ---------------------> ACKNOWLEDGED ------------------------> RESOLVED
 *                      |  ^                              |                                    |
 *                      |  +--- breach (occurrence++) ----+                                    |
 *                      +------------- healthy x resolveAfter ------------------------------->-+
 *                      ^                                                                      |
 *                      +------------- breach within REOPEN_WITHIN_OBSERVATIONS (reopen) ------+
 *
 * The brief's rule is literal ("alert whenever latency exceeds 15 s or a refresh fails") and
 * is honoured: every breaching observation produces an event. What the engine adds is that
 * repeated breaches of the same rule on the same report update one alert rather than opening
 * a new one each time. In this dataset 82% of observations breach a rule, so without that the
 * feed would be unusable.
 */
export class AlertEngine {
  constructor(
    private readonly alerts: AlertRepository,
    private readonly rules: () => readonly AlertRule[],
  ) {}

  /** Applies one observation to every enabled rule. Call inside a transaction. */
  process(obs: Observation): EngineEvent[] {
    const events: EngineEvent[] = [];
    for (const rule of this.rules()) {
      if (!rule.enabled) continue;
      const evaluation = evaluate(rule, obs);
      if (!evaluation) continue;
      const event = this.apply(rule, obs, evaluation);
      if (event) events.push(event);
    }
    return events;
  }

  private apply(rule: AlertRule, obs: Observation, ev: Evaluation): EngineEvent | null {
    const fingerprint = `${rule.id}:${obs.reportId}`;
    const latest = this.alerts.latestForFingerprint(fingerprint);
    const open = latest && latest.status !== 'resolved' ? latest : undefined;

    if (ev.breach) {
      if (open) return this.recordOccurrence(open, obs, ev);
      if (latest && latest.obsSinceResolved < REOPEN_WITHIN_OBSERVATIONS)
        return this.reopen(latest, obs, ev);
      return this.open(rule, fingerprint, obs, ev);
    }

    if (open) {
      open.okStreak += 1;
      if (open.okStreak >= rule.resolveAfter) return this.resolve(open, obs, ev);
      this.alerts.update(open);
      return null;
    }
    if (latest) {
      latest.obsSinceResolved += 1;
      this.alerts.update(latest);
    }
    return null;
  }

  private open(
    rule: AlertRule,
    fingerprint: string,
    obs: Observation,
    ev: Evaluation,
  ): EngineEvent {
    const alert: AlertRecord = {
      id: randomUUID(),
      fingerprint,
      ruleId: rule.id,
      reportId: obs.reportId,
      severity: ev.severity,
      status: 'firing',
      message: ev.message,
      value: ev.value,
      threshold: ev.threshold,
      unit: ev.unit,
      occurrences: 1,
      reopenCount: 0,
      okStreak: 0,
      obsSinceResolved: 0,
      firstSeenAt: obs.observedAt,
      lastSeenAt: obs.observedAt,
      resolvedAt: null,
      acknowledgedBy: null,
      acknowledgedAt: null,
      ackNote: null,
      snoozedUntil: null,
      source: obs.source,
      seq: this.alerts.nextSeq(),
    };
    this.alerts.insert(alert);
    this.alerts.addEvent(
      alert.id,
      'fired',
      obs.observedAt,
      'system',
      ev.severity,
      ev.value,
      ev.message,
    );
    return { type: 'fired', alert };
  }

  private recordOccurrence(alert: AlertRecord, obs: Observation, ev: Evaluation): EngineEvent {
    const previous = alert.severity;
    alert.occurrences += 1;
    alert.okStreak = 0;
    alert.lastSeenAt = obs.observedAt;
    alert.value = ev.value;
    alert.threshold = ev.threshold;
    alert.message = ev.message;
    alert.severity = ev.severity;
    this.alerts.update(alert);

    if (isMoreSevere(ev.severity, previous)) {
      this.alerts.addEvent(
        alert.id,
        'escalated',
        obs.observedAt,
        'system',
        ev.severity,
        ev.value,
        `${previous} -> ${ev.severity}`,
      );
      return { type: 'updated', change: 'escalated', alert };
    }
    if (isMoreSevere(previous, ev.severity)) {
      this.alerts.addEvent(
        alert.id,
        'deescalated',
        obs.observedAt,
        'system',
        ev.severity,
        ev.value,
        `${previous} -> ${ev.severity}`,
      );
      return { type: 'updated', change: 'deescalated', alert };
    }
    return { type: 'updated', change: 'occurrence', alert };
  }

  private reopen(alert: AlertRecord, obs: Observation, ev: Evaluation): EngineEvent {
    alert.status = 'firing';
    alert.reopenCount += 1;
    alert.occurrences += 1;
    alert.okStreak = 0;
    alert.obsSinceResolved = 0;
    alert.resolvedAt = null;
    alert.acknowledgedBy = null;
    alert.acknowledgedAt = null;
    alert.ackNote = null;
    alert.lastSeenAt = obs.observedAt;
    alert.severity = ev.severity;
    alert.value = ev.value;
    alert.threshold = ev.threshold;
    alert.message = ev.message;
    this.alerts.update(alert);
    this.alerts.addEvent(
      alert.id,
      'reopened',
      obs.observedAt,
      'system',
      ev.severity,
      ev.value,
      `Reopened (${alert.reopenCount}x)`,
    );
    return { type: 'updated', change: 'reopened', alert };
  }

  private resolve(alert: AlertRecord, obs: Observation, ev: Evaluation): EngineEvent {
    alert.status = 'resolved';
    alert.resolvedAt = obs.observedAt;
    alert.obsSinceResolved = 0;
    alert.snoozedUntil = null;
    this.alerts.update(alert);
    this.alerts.addEvent(
      alert.id,
      'resolved',
      obs.observedAt,
      'system',
      alert.severity,
      ev.value,
      ev.message,
    );
    return { type: 'resolved', alert };
  }
}
