import {
  type Alert,
  type AlertDetail,
  type AlertListQuery,
  type AlertRule,
  type AlertRuleId,
  type AlertStats,
  type AlertStatus,
  SEVERITY_RANK,
  type Severity,
  type UpdateAlertRuleRequest,
} from '@picc/contracts';
import { can, type Principal } from '../auth/principal.js';
import { conflict, forbidden, notFound } from '../http/errors.js';
import type { AuditLog } from '../opsdb/repositories.js';
import type { EventBus } from '../realtime/bus.js';
import {
  type AlertPayload,
  type PresenterContext,
  presentAlert,
  presentEmail,
} from '../services/presenters.js';
import { FLAPPING_REOPEN_COUNT } from './engine.js';
import type { AlertRepository, AlertRuleRepository } from './repository.js';
import type { AlertRecord, EngineEvent } from './types.js';

export interface ActiveAlertSummary {
  count: number;
  highest: Severity;
}

export class AlertService {
  constructor(
    private readonly alerts: AlertRepository,
    private readonly rules: AlertRuleRepository,
    private readonly bus: EventBus,
    private readonly audit: AuditLog,
    private readonly ctx: PresenterContext,
    private readonly now: () => Date,
  ) {}

  /** Puts engine output on the bus. One bus event per engine event, in order. */
  publish(events: readonly EngineEvent[]): void {
    for (const event of events) {
      const payload: AlertPayload = {
        alert: { ...event.alert },
        ...(event.type === 'updated' ? { change: event.change } : {}),
      };
      this.bus.publish(`alert.${event.type}`, 'alerts', payload, event.alert.reportId);
    }
  }

  list(
    principal: Principal,
    query: AlertListQuery,
  ): { items: Alert[]; total: number; page: number; pageSize: number } {
    const statuses: readonly AlertStatus[] | undefined =
      query.status === 'all'
        ? undefined
        : query.status === 'active'
          ? ['firing', 'acknowledged']
          : [query.status];
    let records = this.alerts.list({
      statuses,
      severity: query.severity,
      ruleId: query.ruleId,
      reportId: query.reportId,
      reportIds: this.ctx.ownership.visibleReportIds(principal) ?? undefined,
    });
    if (query.escalated) {
      const want = query.escalated === 'true';
      records = records.filter((r) => this.ctx.ownership.isOrphaned(r.reportId) === want);
    }
    const start = (query.page - 1) * query.pageSize;
    return {
      items: records
        .slice(start, start + query.pageSize)
        .map((r) => presentAlert(r, principal, this.ctx)),
      total: records.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** 404 rather than 403 for an alert outside the caller's scope: do not confirm it exists. */
  private visible(principal: Principal, id: string): AlertRecord {
    const record = this.alerts.get(id);
    if (!record || !this.ctx.ownership.canSee(principal, record.reportId)) throw notFound('Alert');
    return record;
  }

  get(principal: Principal, id: string): AlertDetail {
    const record = this.visible(principal, id);
    return {
      ...presentAlert(record, principal, this.ctx),
      timeline: this.alerts.timeline(id).map((e) => ({
        id: e.id,
        alertId: e.alert_id,
        type: e.type,
        at: e.at,
        actor: e.actor === 'system' ? 'system' : (presentEmail(principal, e.actor) ?? 'system'),
        severity: e.severity,
        value: e.value,
        detail: e.detail,
      })),
    };
  }

  acknowledge(
    principal: Principal,
    id: string,
    note: string | undefined,
    requestId: string | null,
  ): Alert {
    const record = this.visible(principal, id);
    if (record.status === 'resolved') throw conflict('The alert has already resolved.');
    if (record.status === 'acknowledged')
      throw conflict(`Already acknowledged by ${record.acknowledgedBy}.`);
    const at = this.now().toISOString();
    record.status = 'acknowledged';
    record.acknowledgedBy = principal.email;
    record.acknowledgedAt = at;
    record.ackNote = note ?? null;
    this.alerts.update(record);
    this.alerts.addEvent(
      id,
      'acknowledged',
      at,
      principal.email,
      record.severity,
      record.value,
      note ?? null,
    );
    this.audit.record({
      actor: principal.email,
      actorRole: principal.role,
      action: 'alert.acknowledge',
      targetType: 'alert',
      targetId: id,
      detail: { reportId: record.reportId, ruleId: record.ruleId, note: note ?? null },
      requestId,
    });
    this.publish([{ type: 'updated', change: 'acknowledged', alert: record }]);
    return presentAlert(record, principal, this.ctx);
  }

  snooze(principal: Principal, id: string, minutes: number, requestId: string | null): Alert {
    const record = this.visible(principal, id);
    if (record.status === 'resolved') throw conflict('The alert has already resolved.');
    const at = this.now();
    record.snoozedUntil = new Date(at.getTime() + minutes * 60_000).toISOString();
    this.alerts.update(record);
    this.alerts.addEvent(
      id,
      'snoozed',
      at.toISOString(),
      principal.email,
      record.severity,
      record.value,
      `${minutes} minutes`,
    );
    this.audit.record({
      actor: principal.email,
      actorRole: principal.role,
      action: 'alert.snooze',
      targetType: 'alert',
      targetId: id,
      detail: { reportId: record.reportId, minutes, until: record.snoozedUntil },
      requestId,
    });
    this.publish([{ type: 'updated', change: 'snoozed', alert: record }]);
    return presentAlert(record, principal, this.ctx);
  }

  /** After an ownership change, open alerts on that report now route to the new owner. */
  rerouteForReport(reportId: string, actor: string, detail: string): void {
    const at = this.now().toISOString();
    const open = this.alerts.active([reportId]);
    for (const record of open) {
      this.alerts.addEvent(record.id, 'rerouted', at, actor, record.severity, record.value, detail);
    }
    this.publish(
      open.map((alert) => ({ type: 'updated' as const, change: 'rerouted' as const, alert })),
    );
  }

  stats(principal: Principal): AlertStats {
    const visible = this.ctx.ownership.visibleReportIds(principal) ?? undefined;
    const all = this.alerts.list({ reportIds: visible });
    const stats: AlertStats = {
      firing: 0,
      acknowledged: 0,
      resolved: 0,
      escalated: 0,
      flapping: 0,
      bySeverity: { info: 0, warning: 0, high: 0, critical: 0 },
      byRule: {},
    };
    for (const a of all) {
      stats[a.status] += 1;
      if (a.status === 'resolved') continue;
      stats.bySeverity[a.severity] += 1;
      stats.byRule[a.ruleId] = (stats.byRule[a.ruleId] ?? 0) + 1;
      if (this.ctx.ownership.isOrphaned(a.reportId)) stats.escalated += 1;
      if (a.reopenCount >= FLAPPING_REOPEN_COUNT) stats.flapping += 1;
    }
    return stats;
  }

  activeRecords(principal: Principal): AlertRecord[] {
    return this.alerts.active(this.ctx.ownership.visibleReportIds(principal) ?? undefined);
  }

  activeForReport(principal: Principal, reportId: string): Alert[] {
    return this.alerts.active([reportId]).map((r) => presentAlert(r, principal, this.ctx));
  }

  /** Open-alert count and worst severity per report, for list views. */
  activeByReport(): Map<string, ActiveAlertSummary> {
    const byReport = new Map<string, ActiveAlertSummary>();
    for (const alert of this.alerts.active()) {
      const current = byReport.get(alert.reportId);
      if (!current) byReport.set(alert.reportId, { count: 1, highest: alert.severity });
      else {
        current.count += 1;
        if (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[current.highest])
          current.highest = alert.severity;
      }
    }
    return byReport;
  }

  listRules(): AlertRule[] {
    return this.rules.list();
  }

  updateRule(
    principal: Principal,
    id: AlertRuleId,
    patch: UpdateAlertRuleRequest,
    requestId: string | null,
  ): AlertRule {
    if (!can(principal, 'alert-rules:write')) throw forbidden();
    const before = this.rules.get(id);
    if (!before) throw notFound('Alert rule');
    const merged = { ...before, ...patch };
    const tiers = [merged.warningThreshold, merged.highThreshold, merged.criticalThreshold].filter(
      (t): t is number => t !== null,
    );
    if (tiers.some((t, i) => i > 0 && t <= tiers[i - 1]!)) {
      throw conflict('Thresholds must increase: warning < high < critical.');
    }
    const after = this.rules.update(id, patch, principal.email, this.now().toISOString());
    this.audit.record({
      actor: principal.email,
      actorRole: principal.role,
      action: 'alert_rule.update',
      targetType: 'alert_rule',
      targetId: id,
      detail: { before, patch },
      requestId,
    });
    this.bus.publish('system.notice', 'system', {
      level: 'info',
      code: 'alert_rule.updated',
      message: `Alert rule "${after.name}" was changed. New thresholds apply from the next observation.`,
    });
    return after;
  }
}
