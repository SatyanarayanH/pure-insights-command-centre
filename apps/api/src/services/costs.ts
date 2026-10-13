import type { Chargeback, CostAnomalies, CostPeriod, CostReports, CostSummary } from '@picc/contracts';
import type { Principal } from '../auth/principal.js';
import { badRequest } from '../http/errors.js';
import { type EfficiencyRow, type FactRow, periodLabel, type WarehouseSnapshot } from '../warehouse/snapshot.js';
import type { OwnershipService } from './ownership.js';
import { presentEmail } from './presenters.js';

const sum = (values: (number | null)[]): number => values.reduce<number>((a, b) => a + (b ?? 0), 0);
const ratio = (numerator: number, denominator: number): number | null => (denominator > 0 ? numerator / denominator : null);

/** Cost views. Every figure comes from the marts built by the SQL suite; this layer only
 *  filters to what the caller may see and reshapes for the API. */
export class CostService {
  private readonly efficiency = new Map<string, EfficiencyRow>();
  private readonly names = new Map<string, string>();

  constructor(
    private readonly snapshot: WarehouseSnapshot,
    private readonly ownership: OwnershipService,
  ) {
    for (const row of snapshot.efficiency) this.efficiency.set(row.report_id, row);
    for (const row of snapshot.dim) this.names.set(row.report_id, row.report_name);
  }

  private visibleFacts(principal: Principal): FactRow[] {
    const visible = this.ownership.visibleReportIds(principal);
    if (!visible) return this.snapshot.facts;
    const allowed = new Set(visible);
    return this.snapshot.facts.filter((f) => allowed.has(f.report_id));
  }

  private get latestSeq(): number {
    return this.snapshot.dim[0]?.latest_period_seq ?? 0;
  }

  summary(principal: Principal): CostSummary {
    const facts = this.visibleFacts(principal);
    const platformWide = principal.scope === 'all';
    const bySeq = new Map<number, FactRow[]>();
    for (const fact of facts) {
      const list = bySeq.get(fact.period_seq) ?? [];
      list.push(fact);
      bySeq.set(fact.period_seq, list);
    }

    const periods: CostPeriod[] = this.snapshot.periodSummary.map((p) => {
      const rows = bySeq.get(p.period_seq) ?? [];
      const total = sum(rows.map((f) => f.total_cost_usd));
      const views = sum(rows.map((f) => f.monthly_active_views));
      return {
        periodSeq: p.period_seq,
        periodLabel: periodLabel(p.period_seq),
        periodStart: p.period_start,
        periodEnd: p.period_end,
        reports: rows.length,
        views,
        creditsAttributed: sum(rows.map((f) => f.credits_attributed)),
        creditsFullyLoaded: sum(rows.map((f) => f.credits_fully_loaded)),
        snowflakeCostLoadedUsd: sum(rows.map((f) => f.snowflake_cost_loaded_usd)),
        awsHostingCostUsd: sum(rows.map((f) => f.aws_hosting_cost_usd)),
        totalCostUsd: total,
        orphanedCostUsd: sum(rows.filter((f) => f.is_orphaned).map((f) => f.total_cost_usd)),
        totalCostPerViewUsd: ratio(total, views),
        creditsMeteredCompute: platformWide ? p.credits_metered_compute : null,
        creditsIdle: platformWide ? p.credits_idle : null,
        creditsUnattributed: platformWide ? p.credits_unattributed : null,
      };
    });

    const lifetimeTotal = sum(facts.map((f) => f.total_cost_usd));
    const quarantined = this.snapshot.facts.filter((f) => f.is_cost_quarantined);
    const metered = sum(this.snapshot.periodSummary.map((p) => p.credits_metered_compute));
    const idle = sum(this.snapshot.periodSummary.map((p) => p.credits_idle));

    return {
      scope: principal.scope,
      creditPriceUsd: this.snapshot.params.credit_price_usd,
      latestPeriodSeq: this.latestSeq,
      latest: periods.find((p) => p.periodSeq === this.latestSeq) ?? periods.at(-1)!,
      lifetime: {
        totalCostUsd: lifetimeTotal,
        snowflakeCostLoadedUsd: sum(facts.map((f) => f.snowflake_cost_loaded_usd)),
        awsHostingCostUsd: sum(facts.map((f) => f.aws_hosting_cost_usd)),
        orphanedCostUsd: sum(facts.filter((f) => f.is_orphaned).map((f) => f.total_cost_usd)),
        creditsAttributed: sum(facts.map((f) => f.credits_attributed)),
        creditsFullyLoaded: sum(facts.map((f) => f.credits_fully_loaded)),
        totalCostPerViewUsd: ratio(lifetimeTotal, sum(facts.map((f) => f.monthly_active_views))),
      },
      periods,
      platform: platformWide
        ? {
            creditsMeteredCompute: metered,
            creditsAttributedToReports: this.snapshot.methods.credits_direct,
            creditsIdle: idle,
            creditsUnattributed: sum(this.snapshot.unattributed.map((u) => u.credits)),
            creditsQuarantinedImputed: sum(quarantined.map((f) => f.credits_fully_loaded)),
            idleShare: metered > 0 ? idle / metered : 0,
            unattributed: this.snapshot.unattributed.map((u) => ({
              attributionClass: u.attribution_class,
              tagApp: u.tag_app,
              tagReportId: u.tag_report_id,
              queryRows: u.query_rows,
              credits: u.credits,
            })),
            methods: {
              creditsDirect: this.snapshot.methods.credits_direct,
              creditsIdleLoaded: this.snapshot.methods.credits_idle_loaded,
              creditsTimeWeighted: this.snapshot.methods.credits_time_weighted,
              medianAbsDifferencePct: this.snapshot.methods.median_abs_difference_pct,
              correlation: this.snapshot.methods.correlation,
            },
            quarantine: {
              reportPeriods: quarantined.length,
              creditsReported: sum(quarantined.map((f) => f.credits_reported)),
              creditsImputed: sum(quarantined.map((f) => f.credits_fully_loaded)),
              costImputedUsd: sum(quarantined.map((f) => f.snowflake_cost_loaded_usd)),
            },
            correlations: this.snapshot.correlations.map((c) => ({
              usageMeasure: c.usage_measure,
              costMeasure: c.cost_measure,
              pearsonR: c.pearson_r,
              observations: c.observations,
            })),
          }
        : null,
    };
  }

  reports(principal: Principal, period: string): CostReports {
    const facts = this.visibleFacts(principal);
    const row = (reportId: string, rows: FactRow[], imputed: boolean) => {
      const views = sum(rows.map((f) => f.monthly_active_views));
      const queries = sum(rows.map((f) => f.query_count_last_30d));
      const attributed = rows.some((f) => f.credits_attributed !== null) ? sum(rows.map((f) => f.credits_attributed)) : null;
      const snowflakeAttributedUsd = attributed === null ? null : attributed * this.snapshot.params.credit_price_usd;
      const total = sum(rows.map((f) => f.total_cost_usd));
      const owner = this.ownership.ownerOf(reportId);
      const efficiency = this.efficiency.get(reportId);
      return {
        reportId,
        reportName: this.names.get(reportId) ?? reportId,
        ownerEmail: presentEmail(principal, owner.email),
        isOrphaned: owner.email === null,
        efficiencyQuadrant: efficiency?.efficiency_quadrant ?? null,
        monthlyActiveViews: views,
        queryCount30d: queries,
        creditsAttributed: attributed,
        creditsFullyLoaded: sum(rows.map((f) => f.credits_fully_loaded)),
        snowflakeCostLoadedUsd: sum(rows.map((f) => f.snowflake_cost_loaded_usd)),
        awsHostingCostUsd: sum(rows.map((f) => f.aws_hosting_cost_usd)),
        totalCostUsd: total,
        snowflakeCostPerViewUsd: snowflakeAttributedUsd === null ? null : ratio(snowflakeAttributedUsd, views),
        totalCostPerViewUsd: ratio(total, views),
        snowflakeCostPerQueryUsd: snowflakeAttributedUsd === null ? null : ratio(snowflakeAttributedUsd, queries),
        isCostImputed: imputed,
        runRateViews: efficiency?.run_rate_views ?? null,
        runRateTotalCostUsd: efficiency?.run_rate_total_cost_usd ?? null,
      };
    };

    const byReport = new Map<string, FactRow[]>();
    let label: string;
    if (period === 'lifetime') {
      label = 'All periods';
      for (const fact of facts) byReport.set(fact.report_id, [...(byReport.get(fact.report_id) ?? []), fact]);
    } else {
      const seq = period === 'latest' ? this.latestSeq : Number(period);
      if (!this.snapshot.periodSummary.some((p) => p.period_seq === seq)) throw badRequest(`Unknown period ${period}.`);
      label = periodLabel(seq);
      for (const fact of facts) if (fact.period_seq === seq) byReport.set(fact.report_id, [fact]);
    }
    return {
      period,
      periodLabel: label,
      items: [...byReport.entries()]
        .map(([reportId, rows]) => row(reportId, rows, rows.some((f) => f.is_cost_imputed)))
        .sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0)),
    };
  }

  chargeback(principal: Principal): Chargeback {
    const latest = new Map(this.snapshot.chargebackLatest.map((r) => [r.owner_key, r.total_cost_usd]));
    return {
      items: this.snapshot.chargebackOwners.map((r) => ({
        ownerKey: r.is_unowned ? r.owner_key : (presentEmail(principal, r.owner_key) ?? r.owner_key),
        isUnowned: r.is_unowned,
        reportPeriods: r.report_periods,
        reportsNow: r.is_unowned
          ? this.snapshot.dim.filter((d) => this.ownership.isOrphaned(d.report_id)).length
          : this.ownership.reportsOwnedBy(r.owner_key).length,
        views: r.views,
        creditsFullyLoaded: r.credits_fully_loaded,
        snowflakeCostLoadedUsd: r.snowflake_cost_loaded_usd,
        awsHostingCostUsd: r.aws_hosting_cost_usd,
        totalCostUsd: r.total_cost_usd,
        totalCostPerViewUsd: r.total_cost_per_view_usd,
        shareOfTotalCost: r.share_of_total_cost,
        latestPeriodCostUsd: latest.get(r.owner_key) ?? 0,
      })),
    };
  }

  anomalies(principal: Principal): CostAnomalies {
    const items = this.snapshot.anomalies
      .filter((a) => this.ownership.canSee(principal, a.report_id))
      // An orphan that has since been given an owner is no longer unaccountable spend.
      .filter((a) => a.anomaly_type !== 'ORPHANED_SPEND' || this.ownership.isOrphaned(a.report_id))
      .map((a) => ({
        anomalyType: a.anomaly_type as CostAnomalies['items'][number]['anomalyType'],
        reportId: a.report_id,
        reportName: this.names.get(a.report_id) ?? a.report_id,
        periodSeq: a.period_seq,
        periodLabel: a.period_seq === null ? null : periodLabel(a.period_seq),
        metricValue: a.metric_value,
        metricUnit: a.metric_unit,
        estMonthlyImpactUsd: a.est_monthly_impact_usd,
        detail: a.detail,
      }));
    const byType = new Map<string, { count: number; estMonthlyImpactUsd: number }>();
    for (const item of items) {
      const entry = byType.get(item.anomalyType) ?? { count: 0, estMonthlyImpactUsd: 0 };
      entry.count += 1;
      entry.estMonthlyImpactUsd += item.estMonthlyImpactUsd ?? 0;
      byType.set(item.anomalyType, entry);
    }
    return {
      items,
      byType: [...byType.entries()]
        .map(([anomalyType, v]) => ({ anomalyType, ...v }))
        .sort((a, b) => b.estMonthlyImpactUsd - a.estMonthlyImpactUsd),
    };
  }
}
