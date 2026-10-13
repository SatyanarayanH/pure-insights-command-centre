import type { Chargeback, CostAnomalies, CostReports, CostSummary } from '@picc/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { BarList, BarsChart, PartsBar, QuadrantScatter } from '../components/charts';
import { QuadrantBadge } from '../components/status';
import {
  Badge,
  Card,
  Note,
  PageHeader,
  QueryBoundary,
  Segmented,
  Stat,
  TableShell,
  td,
  tdNum,
  th,
  thNum,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtCompact, fmtNum, fmtPct, fmtUsd, fmtUsd2, fmtUsdCompact } from '../lib/format';

const ANOMALY_LABEL: Record<string, string> = {
  QUARANTINED_CREDITS: 'Quarantined credit figures',
  ORPHANED_SPEND: 'Spend with no owner',
  ZOMBIE_REPORT: 'Zombie reports',
  ZERO_VIEW_SPEND: 'Spend with zero views',
  COST_PER_VIEW_OUTLIER: 'Hosting cost out of line with usage',
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

function Platform({ summary }: { summary: CostSummary }) {
  const p = summary.platform;
  if (!p) return null;
  const residual =
    p.creditsMeteredCompute - p.creditsAttributedToReports - p.creditsIdle - p.creditsUnattributed;
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card
        title="Where the metered credits went"
        subtitle={`All 20 periods · ${fmtNum(p.creditsMeteredCompute)} compute credits billed`}
      >
        <PartsBar
          format={(v) => fmtNum(v)}
          parts={[
            {
              key: 'reports',
              label: 'Attributed to reports',
              value: p.creditsAttributedToReports,
              color: 'var(--series-1)',
              hint: 'Queries tagged with a catalogued report (Method A)',
            },
            {
              key: 'idle',
              label: 'Warehouse idle time',
              value: p.creditsIdle,
              color: 'var(--series-2)',
              hint: 'Billed while no query was running; spread over reports in the fully loaded figure',
            },
            {
              key: 'unattributed',
              label: 'Other and untagged workloads',
              value: p.creditsUnattributed,
              color: 'var(--series-3)',
              hint: 'dbt, ad hoc, unparseable tags, a report id not in the catalogue',
            },
            {
              key: 'quarantined',
              label: 'Behind quarantined figures',
              value: Math.max(0, residual),
              color: 'var(--series-muted)',
              hint: `${p.quarantine.reportPeriods} report-periods reported negative credits; their real cost is estimated from execution time`,
            },
          ]}
        />
        <div className="mt-4">
          <Note>
            Every billed credit lands in exactly one of these four lines. The SQL suite checks that
            arithmetic on every build and refuses to serve data if it does not hold.
          </Note>
        </div>
      </Card>

      <Card
        title="Attribution methods, side by side"
        subtitle="Three ways to turn a warehouse bill into a cost per report"
        flush
      >
        <TableShell>
          <thead>
            <tr>
              <th className={th}>Method</th>
              <th className={thNum}>Credits to reports</th>
              <th className={th}>Use it for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={td}>
                <div className="font-medium">A · Direct</div>
                <div className="text-[12.5px] text-ink-2">
                  QUERY_ATTRIBUTION_HISTORY by query tag
                </div>
              </td>
              <td className={tdNum}>{fmtNum(p.methods.creditsDirect)}</td>
              <td className={`${td} text-ink-2`}>Unit cost per view. Excludes idle time.</td>
            </tr>
            <tr>
              <td className={td}>
                <div className="font-medium">B · Idle-loaded</div>
                <div className="text-[12.5px] text-ink-2">
                  A × metered ÷ attributed, per warehouse and period
                </div>
              </td>
              <td className={tdNum}>{fmtNum(p.methods.creditsIdleLoaded)}</td>
              <td className={`${td} text-ink-2`}>Chargeback. Adds up to the bill.</td>
            </tr>
            <tr>
              <td className={td}>
                <div className="font-medium">C · Time-weighted</div>
                <div className="text-[12.5px] text-ink-2">
                  Each metered hour split by query overlap
                </div>
              </td>
              <td className={tdNum}>{fmtNum(p.methods.creditsTimeWeighted)}</td>
              <td className={`${td} text-ink-2`}>
                Cross-check, and the estimate for quarantined rows.
              </td>
            </tr>
          </tbody>
        </TableShell>
        <div className="space-y-2 px-5 pt-3 pb-5 text-[13px] text-ink-2">
          <p>
            B and C are computed independently and agree: correlation{' '}
            <span className="tnum font-medium text-ink">{p.methods.correlation?.toFixed(4)}</span>,
            median difference per report-period{' '}
            <span className="tnum font-medium text-ink">
              {fmtPct(p.methods.medianAbsDifferencePct)}
            </span>
            .
          </p>
          <p>
            Negative credit figures summed to{' '}
            <span className="tnum font-medium text-ink">
              {fmtNum(p.quarantine.creditsReported, 2)}
            </span>
            . The queries behind them cost about{' '}
            <span className="tnum font-medium text-ink">{fmtNum(p.quarantine.creditsImputed)}</span>{' '}
            credits ({fmtUsd(p.quarantine.costImputedUsd)}). Dropping those rows would have hidden
            that.
          </p>
        </div>
      </Card>
    </div>
  );
}

function UnitEconomics() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<'latest' | 'lifetime'>('latest');
  const reports = useQuery({
    queryKey: ['costs', 'reports', period],
    queryFn: () => api.get<CostReports>(`/costs/reports?period=${period}`),
  });
  return (
    <QueryBoundary query={reports}>
      {(data) => {
        const points = data.items
          .filter((r) => r.runRateViews !== null && r.runRateTotalCostUsd !== null)
          .map((r) => ({
            id: r.reportId,
            label: `${r.reportName} (${r.reportId})`,
            x: r.runRateViews!,
            y: r.runRateTotalCostUsd!,
            group: r.efficiencyQuadrant === 'ZOMBIE' ? 'zombie' : 'other',
          }));
        return (
          <div className="grid gap-5 xl:grid-cols-5">
            <div className="xl:col-span-2">
              <QuadrantScatter
                title="Usage against cost"
                subtitle="Each dot is a report, on its 3-period run-rate. Dashed lines are the medians."
                points={points}
                groups={[
                  { key: 'other', label: 'Reports', color: 'var(--series-1)' },
                  {
                    key: 'zombie',
                    label: 'Zombie: low usage, high cost',
                    color: 'var(--series-2)',
                  },
                ]}
                xLabel="Monthly views"
                yLabel="Monthly cost"
                formatX={(v) => fmtCompact(v)}
                formatY={fmtUsdCompact}
                xMid={median(points.map((p) => p.x))}
                yMid={median(points.map((p) => p.y))}
                onSelect={(id) => navigate(`/reports/${id}`)}
              />
            </div>
            <Card
              className="xl:col-span-3"
              title="Unit economics by report"
              subtitle={`${data.periodLabel} · sorted by total cost`}
              flush
              actions={
                <Segmented
                  label="Period"
                  value={period}
                  onChange={setPeriod}
                  options={[
                    { value: 'latest', label: 'Latest period' },
                    { value: 'lifetime', label: 'All periods' },
                  ]}
                />
              }
            >
              <div className="max-h-[388px] overflow-y-auto">
                <TableShell>
                  <thead className="sticky top-0 bg-surface">
                    <tr>
                      <th className={th}>Report</th>
                      <th className={thNum}>Views</th>
                      <th className={thNum}>Credits</th>
                      <th className={thNum}>Total cost</th>
                      <th className={thNum}>SF $ / view</th>
                      <th className={thNum}>Total $ / view</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((r) => (
                      <tr
                        key={r.reportId}
                        className="cursor-pointer hover:bg-surface-2"
                        onClick={() => navigate(`/reports/${r.reportId}`)}
                      >
                        <td className={td}>
                          <span className="font-medium whitespace-nowrap text-ink">
                            {r.reportName}
                          </span>
                          {r.efficiencyQuadrant === 'ZOMBIE' && (
                            <span className="ml-2">
                              <QuadrantBadge quadrant="ZOMBIE" />
                            </span>
                          )}
                          {r.isOrphaned && (
                            <span className="ml-2">
                              <Badge tone="serious">no owner</Badge>
                            </span>
                          )}
                        </td>
                        <td className={tdNum}>{fmtNum(r.monthlyActiveViews)}</td>
                        <td className={tdNum}>
                          {r.creditsAttributed === null ? (
                            <span className="text-warning-ink" title="Reported figure quarantined">
                              quarantined
                            </span>
                          ) : (
                            fmtNum(r.creditsAttributed)
                          )}
                        </td>
                        <td className={`${tdNum} font-medium`}>
                          {fmtUsd(r.totalCostUsd)}
                          {r.isCostImputed && (
                            <span className="ml-1 text-[11px] font-normal text-warning-ink">
                              est.
                            </span>
                          )}
                        </td>
                        <td className={tdNum}>{fmtUsd2(r.snowflakeCostPerViewUsd)}</td>
                        <td className={tdNum}>{fmtUsd2(r.totalCostPerViewUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>
            </Card>
          </div>
        );
      }}
    </QueryBoundary>
  );
}

function ChargebackCard() {
  const chargeback = useQuery({
    queryKey: ['costs', 'chargeback'],
    queryFn: () => api.get<Chargeback>('/costs/chargeback'),
  });
  return (
    <Card
      title="Chargeback by owner"
      subtitle="Fully loaded cost over all 20 periods, by who owned the report at the time"
    >
      <QueryBoundary query={chargeback}>
        {({ items }) => (
          <BarList
            format={fmtUsd}
            items={items.map((row) => ({
              key: row.ownerKey,
              label: row.isUnowned ? <span className="font-medium">No owner</span> : row.ownerKey,
              value: row.totalCostUsd,
              color: row.isUnowned ? 'var(--series-2)' : 'var(--series-1)',
              note: `${fmtPct(row.shareOfTotalCost)} · ${fmtUsd2(row.totalCostPerViewUsd)}/view`,
            }))}
          />
        )}
      </QueryBoundary>
    </Card>
  );
}

function Anomalies() {
  const anomalies = useQuery({
    queryKey: ['costs', 'anomalies'],
    queryFn: () => api.get<CostAnomalies>('/costs/anomalies'),
  });
  const [type, setType] = useState<string>('');
  return (
    <Card
      title="Where cost and usage disagree"
      subtitle="Each line is something to act on, with what it costs per month"
      flush
    >
      <QueryBoundary query={anomalies}>
        {(data) => {
          const selected = type || data.byType[0]?.anomalyType || '';
          const rows = data.items.filter((a) => a.anomalyType === selected);
          return (
            <>
              <div className="flex flex-wrap gap-2 px-5 pb-3">
                {data.byType.map((t) => (
                  <button
                    key={t.anomalyType}
                    type="button"
                    onClick={() => setType(t.anomalyType)}
                    aria-pressed={selected === t.anomalyType}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${selected === t.anomalyType ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2'}`}
                  >
                    <div className="text-[12.5px] text-ink-2">
                      {ANOMALY_LABEL[t.anomalyType] ?? t.anomalyType}
                    </div>
                    <div className="tnum text-[15px] font-semibold text-ink">
                      {t.count}{' '}
                      <span className="text-[12.5px] font-normal text-ink-2">
                        · {fmtUsd(t.estMonthlyImpactUsd)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="max-h-80 overflow-y-auto">
                <TableShell>
                  <thead className="sticky top-0 bg-surface">
                    <tr>
                      <th className={th}>Report</th>
                      <th className={th}>Period</th>
                      <th className={thNum}>Measure</th>
                      <th className={thNum}>Monthly impact</th>
                      <th className={th}>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={`${a.anomalyType}-${a.reportId}-${a.periodSeq}`}>
                        <td className={td}>
                          <Link
                            to={`/reports/${a.reportId}`}
                            className="font-medium whitespace-nowrap text-ink hover:underline"
                          >
                            {a.reportName}
                          </Link>
                        </td>
                        <td className={`${td} tnum text-ink-2`}>{a.periodLabel ?? 'run-rate'}</td>
                        <td className={tdNum}>
                          {fmtNum(a.metricValue, 2)}{' '}
                          <span className="text-[12px] text-ink-3">{a.metricUnit}</span>
                        </td>
                        <td className={`${tdNum} font-medium`}>{fmtUsd(a.estMonthlyImpactUsd)}</td>
                        <td className={`${td} text-ink-2`}>{a.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </Card>
  );
}

function Body({ summary }: { summary: CostSummary }) {
  const { can } = useAuth();
  const latest = summary.latest;
  const periods = summary.periods.map((p) => ({
    periodLabel: p.periodLabel,
    snowflake: p.snowflakeCostLoadedUsd,
    aws: p.awsHostingCostUsd,
  }));
  const perView =
    latest.views > 0 ? (latest.creditsAttributed * summary.creditPriceUsd) / latest.views : null;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={`Total cost, ${latest.periodLabel}`}
          value={fmtUsd(latest.totalCostUsd)}
          hint={`Snowflake ${fmtUsdCompact(latest.snowflakeCostLoadedUsd)} · AWS ${fmtUsdCompact(latest.awsHostingCostUsd)}`}
        />
        <Stat
          label="Snowflake cost per active view"
          value={fmtUsd2(perView)}
          hint={`${fmtNum(latest.creditsAttributed)} credits ÷ ${fmtNum(latest.views)} views × $${summary.creditPriceUsd.toFixed(2)}`}
        />
        <Stat
          label="Fully loaded cost per view"
          value={fmtUsd2(latest.totalCostPerViewUsd)}
          hint="adds warehouse idle time and AWS hosting"
        />
        <Stat
          label="Spend with no owner"
          value={fmtUsd(latest.orphanedCostUsd)}
          tone={latest.orphanedCostUsd > 0 ? 'serious' : 'good'}
          hint={`${fmtPct(latest.totalCostUsd ? latest.orphanedCostUsd / latest.totalCostUsd : 0)} of this period · ${fmtUsdCompact(summary.lifetime.orphanedCostUsd)} over all periods`}
        />
      </div>

      <Note>
        Figures on this page are illustrative. Credits are priced at an assumed $
        {summary.creditPriceUsd.toFixed(2)} each, not a contract rate, and the query-level Snowflake
        logs are simulated from the case-study dataset's per-report totals. They are not production
        logs.
      </Note>

      {summary.scope === 'own' && (
        <Note tone="accent">
          You are seeing cost for the reports you own. Platform-wide reconciliation and chargeback
          are available to FinOps and admins.
        </Note>
      )}

      <BarsChart
        title="Cost by period"
        subtitle={`Credits priced at $${summary.creditPriceUsd.toFixed(2)} (a parameter in CONFIG.COST_PARAMS)`}
        data={periods}
        xKey="periodLabel"
        stacked
        series={[
          { key: 'snowflake', label: 'Snowflake, fully loaded', color: 'var(--series-1)' },
          { key: 'aws', label: 'AWS hosting', color: 'var(--series-2)' },
        ]}
        format={fmtUsdCompact}
      />

      <Platform summary={summary} />
      <UnitEconomics />

      <div className="grid gap-5 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <Anomalies />
        </div>
        <div className="space-y-5 xl:col-span-2">
          {can('chargeback:read') && <ChargebackCard />}
          {summary.platform && (
            <Card
              title="Does cost follow usage?"
              subtitle="Pearson correlation across all 2,000 report-periods"
              flush
            >
              <TableShell>
                <thead>
                  <tr>
                    <th className={th}>Usage measure</th>
                    <th className={th}>Cost measure</th>
                    <th className={thNum}>r</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.platform.correlations.map((c) => (
                    <tr key={`${c.usageMeasure}-${c.costMeasure}`}>
                      <td className={`${td} font-mono text-[12.5px]`}>{c.usageMeasure}</td>
                      <td className={`${td} font-mono text-[12.5px]`}>{c.costMeasure}</td>
                      <td className={tdNum}>{c.pearsonR?.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
              <p className="px-5 pt-2 pb-4 text-[13px] text-ink-2">
                All near zero: in this dataset cost is incurred independently of usage. That is the
                "discrepancy between active users and hosting cost" the brief describes, and it is
                why cost per view varies so widely between reports.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export function CostsPage() {
  const summary = useQuery({
    queryKey: ['costs', 'summary'],
    queryFn: () => api.get<CostSummary>('/costs/summary'),
  });
  return (
    <>
      <PageHeader
        title="Cost"
        description="Snowflake credits attributed to individual reports, plus AWS hosting, turned into a unit cost per active view. Computed by the SQL suite in sql/."
      />
      <QueryBoundary query={summary}>{(data) => <Body summary={data} />}</QueryBoundary>
    </>
  );
}
