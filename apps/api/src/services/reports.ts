import {
  type Overview,
  type PeriodObservation,
  type ReportDetail,
  type ReportListQuery,
  type ReportSummary,
  SEVERITY_RANK,
  type Severity,
} from '@picc/contracts';
import type { AlertService } from '../alerts/service.js';
import { can, type Principal } from '../auth/principal.js';
import { notFound } from '../http/errors.js';
import type { ReportStateRepository } from '../opsdb/repositories.js';
import {
  type DimRow,
  type EfficiencyRow,
  type FactRow,
  periodLabel,
  type WarehouseSnapshot,
} from '../warehouse/snapshot.js';
import type { OwnershipService } from './ownership.js';
import { latencySeverityOf, presentCost, presentEmail } from './presenters.js';

const median = (values: number[]): number | null => quantile(values, 0.5);

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

const sum = (values: (number | null)[]): number => values.reduce<number>((a, b) => a + (b ?? 0), 0);

export class ReportService {
  private readonly dim = new Map<string, DimRow>();
  private readonly factsByReport = new Map<string, FactRow[]>();
  private readonly efficiency = new Map<string, EfficiencyRow>();

  constructor(
    private readonly snapshot: WarehouseSnapshot,
    private readonly state: ReportStateRepository,
    private readonly ownership: OwnershipService,
    private readonly alerts: AlertService,
  ) {
    for (const row of snapshot.dim) this.dim.set(row.report_id, row);
    for (const row of snapshot.efficiency) this.efficiency.set(row.report_id, row);
    for (const fact of snapshot.facts) {
      const list = this.factsByReport.get(fact.report_id) ?? [];
      list.push(fact);
      this.factsByReport.set(fact.report_id, list);
    }
  }

  reportName(reportId: string): string {
    return this.dim.get(reportId)?.report_name ?? reportId;
  }

  private visibleDim(principal: Principal): DimRow[] {
    const visible = this.ownership.visibleReportIds(principal);
    if (!visible) return this.snapshot.dim;
    const allowed = new Set(visible);
    return this.snapshot.dim.filter((row) => allowed.has(row.report_id));
  }

  private summarise(
    principal: Principal,
    row: DimRow,
    activeAlerts = this.alerts.activeByReport(),
  ): ReportSummary {
    const state = this.state.get(row.report_id);
    const owner = this.ownership.ownerOf(row.report_id);
    const loadTimeSec = state?.loadTimeSec ?? row.avg_load_time_sec;
    const alertSummary = activeAlerts.get(row.report_id);
    const latencyRule = this.alerts.listRules().find((rule) => rule.id === 'latency');
    return {
      reportId: row.report_id,
      reportName: row.report_name,
      ownerEmail: presentEmail(principal, owner.email),
      ownerSource: owner.source,
      isOrphaned: owner.email === null,
      refreshStatus: state?.refreshStatus ?? row.refresh_status,
      refreshFailureStreak: state?.refreshFailureStreak ?? row.refresh_failure_streak,
      loadTimeSec,
      latencySeverity: latencySeverityOf(loadTimeSec, latencyRule),
      lastObservedAt: state?.observedAt ?? null,
      monthlyActiveViews: row.monthly_active_views,
      queryCount30d: row.query_count_last_30d,
      concurrentUserPeak: row.concurrent_user_peak,
      efficiencyQuadrant: can(principal, 'costs:read')
        ? (this.efficiency.get(row.report_id)?.efficiency_quadrant ?? null)
        : null,
      activeAlerts: alertSummary?.count ?? 0,
      highestAlertSeverity: alertSummary?.highest ?? null,
      cost: presentCost(principal, row),
    };
  }

  list(
    principal: Principal,
    query: ReportListQuery,
  ): { items: ReportSummary[]; total: number; page: number; pageSize: number } {
    const activeAlerts = this.alerts.activeByReport();
    let items = this.visibleDim(principal).map((row) =>
      this.summarise(principal, row, activeAlerts),
    );

    if (query.q) {
      const needle = query.q.toLowerCase();
      items = items.filter(
        (r) =>
          r.reportId.toLowerCase().includes(needle) ||
          r.reportName.toLowerCase().includes(needle) ||
          (r.ownerEmail ?? '').toLowerCase().includes(needle),
      );
    }
    // Filter on the real address even when the caller only ever sees it masked.
    if (query.owner)
      items = items.filter(
        (r) => this.ownership.ownerOf(r.reportId).email === query.owner!.toLowerCase(),
      );
    if (query.orphaned) items = items.filter((r) => r.isOrphaned === (query.orphaned === 'true'));
    if (query.refreshStatus) items = items.filter((r) => r.refreshStatus === query.refreshStatus);
    if (query.latencySeverity)
      items = items.filter((r) => r.latencySeverity === query.latencySeverity);
    if (query.quadrant) items = items.filter((r) => r.efficiencyQuadrant === query.quadrant);
    if (query.hasAlerts)
      items = items.filter((r) => r.activeAlerts > 0 === (query.hasAlerts === 'true'));

    const costSorts = new Set(['totalCostUsd', 'totalCostPerViewUsd']);
    const sortField =
      costSorts.has(query.sort) && !can(principal, 'costs:read') ? 'reportId' : query.sort;
    const key = (r: ReportSummary): string | number | null => {
      switch (sortField) {
        case 'totalCostUsd':
          return r.cost?.totalCostUsd ?? null;
        case 'totalCostPerViewUsd':
          return r.cost?.totalCostPerViewUsd ?? null;
        case 'reportId':
          return Number(r.reportId.replace(/\D+/g, ''));
        default:
          return r[
            sortField as
              | 'ownerEmail'
              | 'loadTimeSec'
              | 'refreshFailureStreak'
              | 'monthlyActiveViews'
              | 'activeAlerts'
          ];
      }
    };
    const direction = query.order === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      // Nulls last in either direction.
      if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? 1 : -1;
      const cmp =
        typeof ka === 'number' && typeof kb === 'number'
          ? ka - kb
          : String(ka).localeCompare(String(kb));
      return cmp * direction || a.reportId.localeCompare(b.reportId, undefined, { numeric: true });
    });

    const start = (query.page - 1) * query.pageSize;
    return {
      items: items.slice(start, start + query.pageSize),
      total: items.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private observation(principal: Principal, fact: FactRow): PeriodObservation {
    return {
      periodSeq: fact.period_seq,
      periodLabel: periodLabel(fact.period_seq),
      periodStart: fact.period_start,
      periodEnd: fact.period_end,
      ownerEmail: presentEmail(principal, fact.owner_email),
      isOrphaned: fact.is_orphaned,
      refreshStatus: fact.refresh_status,
      loadTimeSec: fact.avg_load_time_sec,
      latencySeverity: fact.latency_severity,
      monthlyActiveViews: fact.monthly_active_views,
      queryCount30d: fact.query_count_last_30d,
      concurrentUserPeak: fact.concurrent_user_peak,
      flags: {
        zeroViews: fact.is_zero_views,
        concurrencyExceedsViews: fact.is_concurrency_gt_views,
        costQuarantined: fact.is_cost_quarantined,
      },
      cost: presentCost(principal, fact),
    };
  }

  detail(principal: Principal, reportId: string): ReportDetail {
    const row = this.dim.get(reportId);
    // Same answer for "does not exist" and "not yours": existence is not disclosed.
    if (!row || !this.ownership.canSee(principal, reportId)) throw notFound('Report');
    const ruleNames = new Map(this.snapshot.dqRules.map((rule) => [rule.rule_id, rule.rule_name]));
    return {
      ...this.summarise(principal, row),
      ownership: {
        distinctOwners: row.distinct_owners,
        ownershipChanges: row.ownership_changes,
        periodsOrphaned: row.periods_orphaned,
        lastKnownOwner: presentEmail(principal, row.last_known_owner),
        mostFrequentOwner: presentEmail(principal, row.most_frequent_owner),
        history: this.snapshot.ownershipHistory
          .filter((h) => h.report_id === reportId)
          .map((h) => ({
            periodSeq: h.period_seq,
            periodLabel: periodLabel(h.period_seq),
            ownerEmail: presentEmail(principal, h.owner_email),
            changeType: h.change_type as ReportDetail['ownership']['history'][number]['changeType'],
          })),
        assignments: this.ownership.history(reportId).map((a) => ({
          ...a,
          ownerEmail: presentEmail(principal, a.ownerEmail)!,
          previousOwnerEmail: presentEmail(principal, a.previousOwnerEmail),
          assignedBy: presentEmail(principal, a.assignedBy)!,
        })),
      },
      history: (this.factsByReport.get(reportId) ?? []).map((fact) =>
        this.observation(principal, fact),
      ),
      alerts: this.alerts.activeForReport(principal, reportId),
      // Structural rules (every row is a "repeat", owners change constantly) are noise per report.
      findings: this.snapshot.dqFindings
        .filter(
          (f) =>
            f.report_id === reportId &&
            f.rule_id !== 'DQ-06' &&
            f.rule_id !== 'DQ-07' &&
            f.rule_id !== 'DQ-03' &&
            f.rule_id !== 'DQ-11',
        )
        .map((f) => ({
          ruleId: f.rule_id,
          ruleName: ruleNames.get(f.rule_id) ?? f.rule_id,
          periodSeq: f.period_seq,
          observedValue: f.observed_value,
          detail: f.detail,
        })),
    };
  }

  overview(principal: Principal): Overview {
    const rows = this.visibleDim(principal);
    const ids = new Set(rows.map((r) => r.report_id));
    const activeAlerts = this.alerts.activeByReport();
    const summaries = rows.map((row) => this.summarise(principal, row, activeAlerts));
    // The newest period in the file, not any one report's: reports can start or stop mid-way.
    const latest = this.snapshot.periodSummary.at(-1);
    const latestSeq = latest?.period_seq ?? 0;
    const showCost = can(principal, 'costs:read');
    const latencyRule = this.alerts.listRules().find((rule) => rule.id === 'latency');
    const threshold = latencyRule?.warningThreshold ?? this.snapshot.params.latency_warning_sec;
    const high = latencyRule?.highThreshold ?? this.snapshot.params.latency_high_sec;
    const critical = latencyRule?.criticalThreshold ?? this.snapshot.params.latency_critical_sec;

    const loadTimes = summaries.map((s) => s.loadTimeSec).filter((v): v is number => v !== null);
    const open = this.alerts.activeRecords(principal);
    const bySeverity = (severity: Severity) => open.filter((a) => a.severity === severity).length;

    const facts = this.snapshot.facts.filter((f) => ids.has(f.report_id));
    const periods = [...new Set(facts.map((f) => f.period_seq))].sort((a, b) => a - b);
    const latestFacts = facts.filter((f) => f.period_seq === latestSeq);
    const zombies = this.snapshot.efficiency.filter(
      (e) => ids.has(e.report_id) && e.efficiency_quadrant === 'ZOMBIE',
    );

    const attention = [...open]
      .sort(
        (a, b) =>
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          Number(this.ownership.isOrphaned(b.reportId)) -
            Number(this.ownership.isOrphaned(a.reportId)) ||
          b.occurrences - a.occurrences,
      )
      .filter((a, index, all) => all.findIndex((x) => x.reportId === a.reportId) === index)
      .slice(0, 6)
      .map((a) => ({
        reportId: a.reportId,
        reportName: this.reportName(a.reportId),
        reason: `${a.message}${this.ownership.isOrphaned(a.reportId) ? ' · no owner' : ''}`,
        severity: a.severity,
      }));

    return {
      scope: principal.scope,
      asOf: {
        periodSeq: latestSeq,
        periodLabel: periodLabel(latestSeq),
        periodStart: latest?.period_start ?? '',
        periodEnd: latest?.period_end ?? '',
      },
      reports: {
        total: summaries.length,
        healthy: summaries.filter((s) => s.activeAlerts === 0 && !s.isOrphaned).length,
        orphaned: summaries.filter((s) => s.isOrphaned).length,
        refreshFailing: summaries.filter(
          (s) => s.refreshStatus === 'FAILED' || s.refreshStatus === 'TIMED_OUT',
        ).length,
        refreshUnknown: summaries.filter((s) => s.refreshStatus === 'UNKNOWN').length,
        slow: summaries.filter((s) => s.latencySeverity !== 'OK').length,
        critical: summaries.filter((s) => s.latencySeverity === 'CRITICAL').length,
      },
      alerts: {
        firing: open.filter((a) => a.status === 'firing').length,
        acknowledged: open.filter((a) => a.status === 'acknowledged').length,
        escalated: open.filter((a) => this.ownership.isOrphaned(a.reportId)).length,
        critical: bySeverity('critical'),
        high: bySeverity('high'),
        warning: bySeverity('warning'),
        info: bySeverity('info'),
      },
      latency: {
        medianSec: median(loadTimes),
        p95Sec: quantile(loadTimes, 0.95),
        thresholdSec: threshold,
        distribution: [
          { bucket: `≤ ${threshold} s`, reports: loadTimes.filter((v) => v <= threshold).length },
          {
            bucket: `${threshold}–${high} s`,
            reports: loadTimes.filter((v) => v > threshold && v <= high).length,
          },
          {
            bucket: `${high}–${critical} s`,
            reports: loadTimes.filter((v) => v > high && v <= critical).length,
          },
          { bucket: `> ${critical} s`, reports: loadTimes.filter((v) => v > critical).length },
        ],
      },
      trend: periods.map((periodSeq) => {
        const inPeriod = facts.filter((f) => f.period_seq === periodSeq);
        return {
          periodSeq,
          periodLabel: periodLabel(periodSeq),
          orphaned: inPeriod.filter((f) => f.is_orphaned).length,
          refreshFailures: inPeriod.filter((f) => f.is_refresh_failure).length,
          latencyBreaches: inPeriod.filter((f) => f.is_latency_breach).length,
          medianLoadTimeSec: median(
            inPeriod.map((f) => f.avg_load_time_sec).filter((v): v is number => v !== null),
          ),
          totalCostUsd: showCost ? sum(inPeriod.map((f) => f.total_cost_usd)) : null,
        };
      }),
      cost: showCost
        ? {
            totalCostUsd: sum(latestFacts.map((f) => f.total_cost_usd)),
            snowflakeCostUsd: sum(latestFacts.map((f) => f.snowflake_cost_loaded_usd)),
            awsHostingCostUsd: sum(latestFacts.map((f) => f.aws_hosting_cost_usd)),
            costPerViewUsd: (() => {
              const views = sum(latestFacts.map((f) => f.monthly_active_views));
              return views > 0 ? sum(latestFacts.map((f) => f.total_cost_usd)) / views : null;
            })(),
            orphanedCostUsd: sum(
              latestFacts
                .filter((f) => this.ownership.isOrphaned(f.report_id))
                .map((f) => f.total_cost_usd),
            ),
            zombieRunRateUsd: sum(zombies.map((z) => z.run_rate_total_cost_usd)),
            zombieReports: zombies.length,
          }
        : null,
      attention,
    };
  }
}
