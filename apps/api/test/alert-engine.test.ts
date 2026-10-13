import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { AlertRule, RefreshStatus } from '@picc/contracts';
import { AlertEngine, FLAPPING_REOPEN_COUNT, REOPEN_WITHIN_OBSERVATIONS } from '../src/alerts/engine.js';
import { AlertRepository, AlertRuleRepository } from '../src/alerts/repository.js';
import { evaluate } from '../src/alerts/rules.js';
import type { EngineEvent, Observation } from '../src/alerts/types.js';
import { OpsDb } from '../src/opsdb/db.js';

const REPORT = 'RPT_200';
let db: OpsDb;
let alerts: AlertRepository;
let rules: AlertRuleRepository;
let engine: AlertEngine;
let tick: number;

const at = (): string => new Date(Date.UTC(2026, 9, 13, 9, 0, tick++)).toISOString();
const observe = (partial: Partial<Observation>): EngineEvent[] =>
  engine.process({ reportId: REPORT, observedAt: at(), source: 'api', ...partial });
const latency = (loadTimeSec: number): EngineEvent[] => observe({ loadTimeSec });
const refresh = (refreshStatus: RefreshStatus, refreshFailureStreak?: number): EngineEvent[] =>
  observe({ refreshStatus, refreshFailureStreak });
const only = (events: EngineEvent[]): EngineEvent => {
  assert.equal(events.length, 1, `expected one event, got ${JSON.stringify(events.map((e) => e.type))}`);
  return events[0]!;
};
const rule = (id: AlertRule['id']): AlertRule => rules.get(id)!;

beforeEach(() => {
  db = new OpsDb(':memory:');
  alerts = new AlertRepository(db);
  rules = new AlertRuleRepository(db);
  rules.seedDefaults('2026-10-13T00:00:00.000Z');
  engine = new AlertEngine(alerts, () => rules.list());
  tick = 0;
});

describe('rule evaluation', () => {
  it('treats "exceeds 15 seconds" as strictly greater than', () => {
    const r = rule('latency');
    assert.equal(evaluate(r, { reportId: REPORT, observedAt: '', source: 'api', loadTimeSec: 15 })!.breach, false);
    assert.equal(evaluate(r, { reportId: REPORT, observedAt: '', source: 'api', loadTimeSec: 15.1 })!.breach, true);
  });

  it('tiers latency severity at 15 / 30 / 45 seconds', () => {
    const r = rule('latency');
    const severity = (s: number) => evaluate(r, { reportId: REPORT, observedAt: '', source: 'api', loadTimeSec: s })!.severity;
    assert.equal(severity(20), 'warning');
    assert.equal(severity(30.1), 'high');
    assert.equal(severity(55), 'critical');
  });

  it('has no opinion when the observation lacks the metric', () => {
    assert.equal(evaluate(rule('latency'), { reportId: REPORT, observedAt: '', source: 'api', refreshStatus: 'FAILED' }), null);
    assert.equal(evaluate(rule('refresh_failure'), { reportId: REPORT, observedAt: '', source: 'api', loadTimeSec: 50 }), null);
  });

  it('treats FAILED and TIMED_OUT as failures, and UNKNOWN as neither failure nor success', () => {
    const r = rule('refresh_failure');
    const status = (s: RefreshStatus) => evaluate(r, { reportId: REPORT, observedAt: '', source: 'api', refreshStatus: s });
    assert.equal(status('FAILED')!.breach, true);
    assert.equal(status('TIMED_OUT')!.breach, true);
    assert.equal(status('SUCCESS')!.breach, false);
    assert.equal(status('UNKNOWN'), null);
  });

  it('flags negative credits', () => {
    const r = rule('invalid_telemetry');
    assert.equal(evaluate(r, { reportId: REPORT, observedAt: '', source: 'api', creditsConsumed: -7.88 })!.breach, true);
    assert.equal(evaluate(r, { reportId: REPORT, observedAt: '', source: 'api', creditsConsumed: 0 })!.breach, false);
  });
});

describe('alert lifecycle', () => {
  it('opens one alert on the first breach', () => {
    const event = only(latency(22));
    assert.equal(event.type, 'fired');
    assert.equal(event.alert.status, 'firing');
    assert.equal(event.alert.severity, 'warning');
    assert.equal(event.alert.fingerprint, `latency:${REPORT}`);
    assert.equal(event.alert.occurrences, 1);
  });

  it('does not alert on a healthy observation', () => {
    assert.deepEqual(latency(3), []);
    assert.equal(alerts.active().length, 0);
  });

  it('folds repeated breaches into the same alert instead of opening new ones', () => {
    const first = only(latency(22)).alert.id;
    for (let i = 0; i < 5; i++) {
      const event = only(latency(20 + i));
      assert.equal(event.type, 'updated');
      assert.equal(event.type === 'updated' && event.change, 'occurrence');
      assert.equal(event.alert.id, first);
    }
    assert.equal(alerts.active().length, 1);
    assert.equal(alerts.get(first)!.occurrences, 6);
  });

  it('emits an event for every breaching observation, as the brief requires', () => {
    let events = 0;
    for (const seconds of [16, 18, 40, 50, 17]) events += latency(seconds).length;
    assert.equal(events, 5);
  });

  it('escalates and de-escalates with the observed value', () => {
    latency(20);
    const up = only(latency(50));
    assert.equal(up.type === 'updated' && up.change, 'escalated');
    assert.equal(up.alert.severity, 'critical');
    const down = only(latency(32));
    assert.equal(down.type === 'updated' && down.change, 'deescalated');
    assert.equal(down.alert.severity, 'high');
    assert.deepEqual(
      alerts.timeline(up.alert.id).map((e) => e.type),
      ['fired', 'escalated', 'deescalated'],
    );
  });

  it('resolves only after resolveAfter consecutive healthy observations', () => {
    const id = only(latency(22)).alert.id;
    assert.equal(rule('latency').resolveAfter, 2);
    assert.deepEqual(latency(5), [], 'one healthy observation is not enough');
    assert.equal(alerts.get(id)!.status, 'firing');
    const resolved = only(latency(5));
    assert.equal(resolved.type, 'resolved');
    assert.equal(alerts.get(id)!.status, 'resolved');
    assert.ok(alerts.get(id)!.resolvedAt);
  });

  it('resets the healthy streak when a breach interrupts it', () => {
    const id = only(latency(22)).alert.id;
    latency(5);
    latency(25);
    assert.deepEqual(latency(5), []);
    assert.equal(alerts.get(id)!.status, 'firing');
  });

  it('reopens the same alert when the breach returns soon after resolving', () => {
    const id = only(latency(22)).alert.id;
    latency(5);
    latency(5);
    const reopened = only(latency(30));
    assert.equal(reopened.type === 'updated' && reopened.change, 'reopened');
    assert.equal(reopened.alert.id, id);
    assert.equal(reopened.alert.status, 'firing');
    assert.equal(reopened.alert.reopenCount, 1);
    assert.equal(alerts.list({}).length, 1);
  });

  it('opens a new alert when the report stayed healthy long enough', () => {
    const id = only(latency(22)).alert.id;
    latency(5);
    latency(5);
    for (let i = 0; i < REOPEN_WITHIN_OBSERVATIONS; i++) latency(5);
    const fresh = only(latency(30));
    assert.equal(fresh.type, 'fired');
    assert.notEqual(fresh.alert.id, id);
    assert.equal(alerts.list({}).length, 2);
  });

  it('marks an alert that keeps reopening as flapping', () => {
    const id = only(latency(22)).alert.id;
    for (let i = 0; i < FLAPPING_REOPEN_COUNT; i++) {
      latency(5);
      latency(5);
      latency(22);
    }
    assert.equal(alerts.get(id)!.reopenCount, FLAPPING_REOPEN_COUNT);
  });

  it('tracks rules independently on the same report', () => {
    latency(40);
    refresh('FAILED', 1);
    assert.deepEqual(alerts.active().map((a) => a.ruleId).sort(), ['latency', 'refresh_failure']);
  });

  it('escalates a refresh failure to critical on the third consecutive failure', () => {
    assert.equal(only(refresh('FAILED', 1)).alert.severity, 'high');
    assert.equal(only(refresh('TIMED_OUT', 2)).alert.severity, 'high');
    const third = only(refresh('FAILED', 3));
    assert.equal(third.alert.severity, 'critical');
    assert.equal(third.type === 'updated' && third.change, 'escalated');
  });

  it('resolves a refresh failure on the first success', () => {
    const id = only(refresh('FAILED', 1)).alert.id;
    const events = refresh('SUCCESS');
    assert.equal(events.find((e) => e.alert.id === id)!.type, 'resolved');
  });

  it('does not let an UNKNOWN refresh resolve or extend a refresh-failure alert', () => {
    const id = only(refresh('FAILED', 1)).alert.id;
    const events = refresh('UNKNOWN', 1);
    assert.deepEqual(events.map((e) => `${e.alert.ruleId}:${e.type}`), ['refresh_unknown:fired']);
    assert.equal(alerts.get(id)!.status, 'firing');
    assert.equal(alerts.get(id)!.occurrences, 1);
  });

  it('skips disabled rules', () => {
    rules.update('latency', { enabled: false }, 'admin@company.com', at());
    assert.deepEqual(latency(55), []);
  });

  it('applies changed thresholds to the next observation', () => {
    rules.update('latency', { warningThreshold: 25 }, 'admin@company.com', at());
    assert.deepEqual(latency(22), []);
    assert.equal(only(latency(26)).type, 'fired');
  });

  it('keeps an acknowledgement when further breaches arrive', () => {
    const alert = only(latency(22)).alert;
    alert.status = 'acknowledged';
    alert.acknowledgedBy = 'user_7@company.com';
    alerts.update(alert);
    const next = only(latency(24));
    assert.equal(next.alert.status, 'acknowledged');
    assert.equal(next.alert.acknowledgedBy, 'user_7@company.com');
  });
});
