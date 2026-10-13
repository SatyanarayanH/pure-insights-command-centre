import type {
  AlertEventType,
  AlertRule,
  AlertRuleId,
  AlertStatus,
  Severity,
  UpdateAlertRuleRequest,
} from '@picc/contracts';
import type { OpsDb, SqlValue } from '../opsdb/db.js';
import { DEFAULT_ALERT_RULES } from './rules.js';
import type { AlertRecord } from './types.js';

interface AlertRow {
  id: string;
  fingerprint: string;
  rule_id: string;
  report_id: string;
  severity: string;
  status: string;
  message: string;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  occurrences: number;
  reopen_count: number;
  flap_count: number;
  breach_streak: number;
  ok_streak: number;
  obs_since_resolved: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  ack_note: string | null;
  snoozed_until: string | null;
  source: string;
  seq: number;
}

const toRecord = (r: AlertRow): AlertRecord => ({
  id: r.id,
  fingerprint: r.fingerprint,
  ruleId: r.rule_id as AlertRuleId,
  reportId: r.report_id,
  severity: r.severity as Severity,
  status: r.status as AlertStatus,
  message: r.message,
  value: r.value,
  threshold: r.threshold,
  unit: r.unit,
  occurrences: r.occurrences,
  reopenCount: r.reopen_count,
  flapCount: r.flap_count,
  breachStreak: r.breach_streak,
  okStreak: r.ok_streak,
  obsSinceResolved: r.obs_since_resolved,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  resolvedAt: r.resolved_at,
  acknowledgedBy: r.acknowledged_by,
  acknowledgedAt: r.acknowledged_at,
  ackNote: r.ack_note,
  snoozedUntil: r.snoozed_until,
  source: r.source as AlertRecord['source'],
  seq: r.seq,
});

export interface AlertFilter {
  statuses?: readonly AlertStatus[];
  severity?: Severity;
  ruleId?: AlertRuleId;
  reportId?: string;
  /** Row-level security: restrict to these reports. `undefined` means no restriction. */
  reportIds?: readonly string[];
}

export interface AlertTimelineRow {
  id: number;
  alert_id: string;
  type: AlertEventType;
  at: string;
  actor: string;
  severity: Severity | null;
  value: number | null;
  detail: string | null;
}

export class AlertRepository {
  private seq: number;

  constructor(private readonly db: OpsDb) {
    this.seq = db.get<{ max: number | null }>('SELECT MAX(seq) AS max FROM alerts')?.max ?? 0;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The newest alert for a fingerprint, open or resolved. */
  latestForFingerprint(fingerprint: string): AlertRecord | undefined {
    const row = this.db.get<AlertRow>(
      'SELECT * FROM alerts WHERE fingerprint = ? ORDER BY seq DESC LIMIT 1',
      fingerprint,
    );
    return row && toRecord(row);
  }

  get(id: string): AlertRecord | undefined {
    const row = this.db.get<AlertRow>('SELECT * FROM alerts WHERE id = ?', id);
    return row && toRecord(row);
  }

  insert(a: AlertRecord): void {
    this.db.run(
      `INSERT INTO alerts (id, fingerprint, rule_id, report_id, severity, status, message, value, threshold, unit,
         occurrences, reopen_count, flap_count, breach_streak, ok_streak, obs_since_resolved, first_seen_at,
         last_seen_at, resolved_at, acknowledged_by, acknowledged_at, ack_note, snoozed_until, source, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.fingerprint,
      a.ruleId,
      a.reportId,
      a.severity,
      a.status,
      a.message,
      a.value,
      a.threshold,
      a.unit,
      a.occurrences,
      a.reopenCount,
      a.flapCount,
      a.breachStreak,
      a.okStreak,
      a.obsSinceResolved,
      a.firstSeenAt,
      a.lastSeenAt,
      a.resolvedAt,
      a.acknowledgedBy,
      a.acknowledgedAt,
      a.ackNote,
      a.snoozedUntil,
      a.source,
      a.seq,
    );
  }

  update(a: AlertRecord): void {
    this.db.run(
      `UPDATE alerts SET severity = ?, status = ?, message = ?, value = ?, threshold = ?, unit = ?, occurrences = ?,
         reopen_count = ?, flap_count = ?, breach_streak = ?, ok_streak = ?, obs_since_resolved = ?,
         last_seen_at = ?, resolved_at = ?, acknowledged_by = ?, acknowledged_at = ?, ack_note = ?,
         snoozed_until = ?
       WHERE id = ?`,
      a.severity,
      a.status,
      a.message,
      a.value,
      a.threshold,
      a.unit,
      a.occurrences,
      a.reopenCount,
      a.flapCount,
      a.breachStreak,
      a.okStreak,
      a.obsSinceResolved,
      a.lastSeenAt,
      a.resolvedAt,
      a.acknowledgedBy,
      a.acknowledgedAt,
      a.ackNote,
      a.snoozedUntil,
      a.id,
    );
  }

  addEvent(
    alertId: string,
    type: AlertEventType,
    at: string,
    actor: string,
    severity: Severity | null,
    value: number | null,
    detail: string | null,
  ): void {
    this.db.run(
      'INSERT INTO alert_events (alert_id, type, at, actor, severity, value, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      alertId,
      type,
      at,
      actor,
      severity,
      value,
      detail,
    );
  }

  timeline(alertId: string): AlertTimelineRow[] {
    return this.db.all<AlertTimelineRow>(
      'SELECT * FROM alert_events WHERE alert_id = ? ORDER BY id',
      alertId,
    );
  }

  private where(filter: AlertFilter): { sql: string; params: SqlValue[] } {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    const inList = (column: string, values: readonly string[]) => {
      clauses.push(values.length ? `${column} IN (${values.map(() => '?').join(', ')})` : '1 = 0');
      params.push(...values);
    };
    if (filter.statuses) inList('status', filter.statuses);
    if (filter.reportIds) inList('report_id', filter.reportIds);
    if (filter.severity) {
      clauses.push('severity = ?');
      params.push(filter.severity);
    }
    if (filter.ruleId) {
      clauses.push('rule_id = ?');
      params.push(filter.ruleId);
    }
    if (filter.reportId) {
      clauses.push('report_id = ?');
      params.push(filter.reportId);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /** Worst first, then most recent. */
  list(filter: AlertFilter): AlertRecord[] {
    const { sql, params } = this.where(filter);
    return this.db
      .all<AlertRow>(
        `SELECT * FROM alerts ${sql}
         ORDER BY CASE status WHEN 'firing' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
                  CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                  last_seen_at DESC, seq DESC`,
        ...params,
      )
      .map(toRecord);
  }

  active(reportIds?: readonly string[]): AlertRecord[] {
    return this.list({ statuses: ['firing', 'acknowledged'], reportIds });
  }
}

interface RuleRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  in_brief: number;
  warning_threshold: number | null;
  high_threshold: number | null;
  critical_threshold: number | null;
  escalate_after: number | null;
  resolve_after: number;
  updated_at: string;
  updated_by: string;
}

const toRule = (r: RuleRow): AlertRule => ({
  id: r.id as AlertRuleId,
  name: r.name,
  description: r.description,
  enabled: r.enabled === 1,
  inBrief: r.in_brief === 1,
  warningThreshold: r.warning_threshold,
  highThreshold: r.high_threshold,
  criticalThreshold: r.critical_threshold,
  escalateAfter: r.escalate_after,
  resolveAfter: r.resolve_after,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

export class AlertRuleRepository {
  private cache: AlertRule[] | null = null;

  constructor(private readonly db: OpsDb) {}

  seedDefaults(now: string): void {
    for (const rule of DEFAULT_ALERT_RULES) {
      this.db.run(
        `INSERT INTO alert_rules (id, name, description, enabled, in_brief, warning_threshold, high_threshold,
           critical_threshold, escalate_after, resolve_after, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system')
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, in_brief = excluded.in_brief`,
        rule.id,
        rule.name,
        rule.description,
        rule.enabled ? 1 : 0,
        rule.inBrief ? 1 : 0,
        rule.warningThreshold,
        rule.highThreshold,
        rule.criticalThreshold,
        rule.escalateAfter,
        rule.resolveAfter,
        now,
      );
    }
    this.cache = null;
  }

  list(): AlertRule[] {
    this.cache ??= this.db
      .all<RuleRow>('SELECT * FROM alert_rules ORDER BY in_brief DESC, id')
      .map(toRule);
    return this.cache;
  }

  get(id: string): AlertRule | undefined {
    return this.list().find((rule) => rule.id === id);
  }

  update(id: AlertRuleId, patch: UpdateAlertRuleRequest, actor: string, now: string): AlertRule {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown alert rule ${id}`);
    const next: AlertRule = { ...current, ...patch, updatedAt: now, updatedBy: actor };
    this.db.run(
      `UPDATE alert_rules SET enabled = ?, warning_threshold = ?, high_threshold = ?, critical_threshold = ?,
         escalate_after = ?, resolve_after = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      next.enabled ? 1 : 0,
      next.warningThreshold,
      next.highThreshold,
      next.criticalThreshold,
      next.escalateAfter,
      next.resolveAfter,
      now,
      actor,
      id,
    );
    this.cache = null;
    return next;
  }
}
