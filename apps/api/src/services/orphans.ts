import type { AssignOwnerRequest, OrphanQueue, OwnerAssignment } from '@picc/contracts';
import type { AlertService } from '../alerts/service.js';
import { can, type Principal } from '../auth/principal.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import type { AuditLog, ReportStateRepository, UserRepository } from '../opsdb/repositories.js';
import type { EventBus } from '../realtime/bus.js';
import type { WarehouseSnapshot } from '../warehouse/snapshot.js';
import type { OwnershipService } from './ownership.js';
import { latencySeverityOf, type OwnerChangedPayload, presentEmail } from './presenters.js';

export class OrphanService {
  constructor(
    private readonly snapshot: WarehouseSnapshot,
    private readonly ownership: OwnershipService,
    private readonly users: UserRepository,
    private readonly state: ReportStateRepository,
    private readonly alerts: AlertService,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly now: () => Date,
  ) {}

  /** Reports with no owner right now, most expensive first. */
  queue(principal: Principal): OrphanQueue {
    const showCost = can(principal, 'costs:read');
    const activeAlerts = this.alerts.activeByReport();
    const latencyRule = this.alerts.listRules().find((rule) => rule.id === 'latency');
    const dim = new Map(this.snapshot.dim.map((d) => [d.report_id, d]));

    const items = this.snapshot.orphanQueue
      .filter((row) => this.ownership.isOrphaned(row.report_id))
      .map((row, index) => {
        const state = this.state.get(row.report_id);
        const report = dim.get(row.report_id)!;
        return {
          priorityRank: index + 1,
          reportId: row.report_id,
          reportName: row.report_name,
          orphanEncoding: row.orphan_encoding,
          periodsSinceOwned: row.periods_since_owned,
          suggestedOwner: presentEmail(principal, row.suggested_owner),
          suggestionBasis: row.suggestion_basis,
          mostFrequentOwner: presentEmail(principal, row.most_frequent_owner),
          refreshStatus: state?.refreshStatus ?? report.refresh_status,
          latencySeverity: latencySeverityOf(state?.loadTimeSec ?? report.avg_load_time_sec, latencyRule),
          monthlyActiveViews: report.monthly_active_views,
          activeAlerts: activeAlerts.get(row.report_id)?.count ?? 0,
          costAtRiskUsd: showCost ? row.cost_at_risk_usd : null,
          lifetimeCostWhileOrphanedUsd: showCost ? row.lifetime_cost_while_orphaned_usd : null,
        };
      });

    return {
      items,
      total: items.length,
      totalCostAtRiskUsd: showCost ? items.reduce((a, b) => a + (b.costAtRiskUsd ?? 0), 0) : null,
      assignableOwners: this.users
        .list()
        .filter((u) => u.role === 'owner')
        .map((u) => ({ email: u.email, name: u.name, reportsOwned: this.ownership.reportsOwnedBy(u.email).length })),
    };
  }

  assign(principal: Principal, reportId: string, body: AssignOwnerRequest, requestId: string | null): OwnerAssignment {
    if (!this.ownership.exists(reportId)) throw notFound('Report');
    const user = this.users.findByEmail(body.ownerEmail);
    if (!user || user.role !== 'owner') {
      throw badRequest(`${body.ownerEmail} is not a Report Owner account.`, [
        { path: 'ownerEmail', message: 'Must be the email of an existing Report Owner.' },
      ]);
    }
    const current = this.ownership.ownerOf(reportId);
    if (current.email === user.email) throw conflict(`${reportId} is already owned by ${user.email}.`);

    const assignment = this.ownership.assign(reportId, user.email, principal.email, this.now().toISOString(), body.note ?? null);
    this.audit.record({
      actor: principal.email,
      actorRole: principal.role,
      action: 'report.owner.assign',
      targetType: 'report',
      targetId: reportId,
      detail: { ownerEmail: user.email, previousOwnerEmail: current.email, note: body.note ?? null },
      requestId,
    });
    const payload: OwnerChangedPayload = {
      reportId,
      ownerEmail: user.email,
      previousOwnerEmail: current.email,
      assignedBy: principal.email,
    };
    this.bus.publish('report.owner_changed', 'reports', payload, reportId);
    // Open alerts on this report stop escalating to admins and start reaching the new owner.
    this.alerts.rerouteForReport(reportId, principal.email, `Routed to ${user.email}`);
    return assignment;
  }
}
