import type { Overview } from '@picc/contracts';
import { useQuery } from '@tanstack/react-query';
import { Activity, Bell, CircleCheck, Coins, RefreshCw, Timer, UserX } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { BarsChart, SERIES_COLORS, TrendChart } from '../components/charts';
import { SeverityBadge } from '../components/status';
import { Card, Empty, PageHeader, QueryBoundary, ScrollArea, Stat } from '../components/ui';
import { api } from '../lib/api';
import { fmtAgo, fmtDate, fmtNum, fmtSec, fmtUsd, fmtUsd2, fmtUsdCompact } from '../lib/format';
import { type ActivityItem, useRealtime } from '../realtime/RealtimeProvider';

const BUCKET_COLORS = ['var(--good)', 'var(--warning)', 'var(--serious)', 'var(--critical)'];

const ACTIVITY_DOT: Record<ActivityItem['kind'], string> = {
  fired: 'bg-critical',
  escalated: 'bg-critical',
  reopened: 'bg-serious',
  resolved: 'bg-good',
  acknowledged: 'bg-accent',
  owner: 'bg-accent',
  notice: 'bg-ink-3',
};

function LiveActivity() {
  const { activity, state } = useRealtime();
  return (
    <Card
      title="Live activity"
      subtitle={
        state.status === 'open'
          ? 'Pushed over the real-time stream as it happens'
          : 'Waiting for the real-time stream'
      }
      className="flex flex-col"
    >
      {activity.length === 0 ? (
        <Empty
          title="Nothing yet"
          hint="Alerts, recoveries and ownership changes appear here the moment they happen."
        />
      ) : (
        <ScrollArea label="Live activity" className="-mx-2 max-h-[340px] overflow-y-auto">
          <ul className="space-y-0.5">
            {activity.slice(0, 30).map((item) => (
              <li key={item.key} className="flash rounded-lg px-2 py-1.5">
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ACTIVITY_DOT[item.kind]}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      {item.reportId ? (
                        <Link
                          to={`/reports/${item.reportId}`}
                          className="truncate text-[13.5px] font-medium text-ink hover:underline"
                        >
                          {item.title}
                        </Link>
                      ) : (
                        <span className="truncate text-[13.5px] font-medium text-ink">
                          {item.title}
                        </span>
                      )}
                      <span className="tnum shrink-0 text-[12px] text-ink-3">
                        {fmtAgo(item.at)}
                      </span>
                    </div>
                    <div className="truncate text-[12.5px] text-ink-2">{item.detail}</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </Card>
  );
}

function OverviewBody({ data }: { data: Overview }) {
  const { can } = useAuth();
  const trend = data.trend.map((t) => ({ ...t }));
  const share = (n: number) =>
    data.reports.total ? `${Math.round((n / data.reports.total) * 100)}% of reports` : '';

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Open alerts"
          value={fmtNum(data.alerts.firing + data.alerts.acknowledged)}
          icon={<Bell size={16} />}
          tone={data.alerts.critical > 0 ? 'critical' : 'neutral'}
          hint={`${data.alerts.critical} critical · ${data.alerts.high} high · ${data.alerts.acknowledged} acknowledged`}
        />
        <Stat
          label="Slow dashboards"
          value={fmtNum(data.reports.slow)}
          icon={<Timer size={16} />}
          tone={data.reports.critical > 0 ? 'serious' : 'neutral'}
          hint={`over ${data.latency.thresholdSec} s · median ${fmtSec(data.latency.medianSec)} · ${data.reports.critical} critical`}
        />
        <Stat
          label="Refresh failing"
          value={fmtNum(data.reports.refreshFailing)}
          icon={<RefreshCw size={16} />}
          tone={data.reports.refreshFailing > 0 ? 'serious' : 'good'}
          hint={`${share(data.reports.refreshFailing)} · ${data.reports.refreshUnknown} with unknown status`}
        />
        <Stat
          label="Orphaned reports"
          value={fmtNum(data.reports.orphaned)}
          icon={<UserX size={16} />}
          tone={data.reports.orphaned > 0 ? 'serious' : 'good'}
          hint={
            data.cost
              ? `${fmtUsd(data.cost.orphanedCostUsd)} this period with no owner`
              : `${data.alerts.escalated} of their alerts escalated to admins`
          }
        />
      </div>

      {data.cost && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label={`Total cost, ${data.asOf.periodLabel}`}
            value={fmtUsd(data.cost.totalCostUsd)}
            icon={<Coins size={16} />}
            hint={`Snowflake ${fmtUsdCompact(data.cost.snowflakeCostUsd)} · AWS ${fmtUsdCompact(data.cost.awsHostingCostUsd)}`}
          />
          <Stat
            label="Cost per active view"
            value={fmtUsd2(data.cost.costPerViewUsd)}
            hint="Fully loaded: Snowflake incl. idle + AWS hosting"
          />
          <Stat
            label="Zombie reports"
            value={fmtNum(data.cost.zombieReports)}
            tone={data.cost.zombieReports > 0 ? 'warning' : 'good'}
            hint={`${fmtUsd(data.cost.zombieRunRateUsd)} a month for bottom-quartile usage`}
          />
          <Stat
            label="Healthy reports"
            value={fmtNum(data.reports.healthy)}
            icon={<CircleCheck size={16} />}
            tone="good"
            hint={`of ${data.reports.total} · no open alert and an owner`}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <TrendChart
          className="xl:col-span-2"
          title={`Health over ${trend.length} period${trend.length === 1 ? '' : 's'}`}
          subtitle="Reports affected in each period"
          data={trend}
          xKey="periodLabel"
          series={[
            {
              key: 'latencyBreaches',
              label: `Slow (> ${data.latency.thresholdSec} s)`,
              color: SERIES_COLORS[0],
            },
            { key: 'refreshFailures', label: 'Refresh failed', color: SERIES_COLORS[1] },
            { key: 'orphaned', label: 'Orphaned', color: SERIES_COLORS[2] },
          ]}
          yDomain={[0, data.reports.total]}
        />
        <BarsChart
          title="Load time right now"
          subtitle={`Reports by latency tier · p95 ${fmtSec(data.latency.p95Sec)}`}
          data={data.latency.distribution}
          xKey="bucket"
          xLabel="Load time"
          series={[{ key: 'reports', label: 'Reports', color: 'var(--series-1)' }]}
          colorOf={(row) =>
            BUCKET_COLORS[data.latency.distribution.findIndex((b) => b.bucket === row.bucket)] ??
            'var(--series-1)'
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card
          title="Needs attention first"
          subtitle="Worst open alert per report; unowned reports rank higher"
          className="xl:col-span-2"
        >
          {data.attention.length === 0 ? (
            <Empty title="Nothing needs attention" />
          ) : (
            <ul className="-mx-2 divide-y divide-line">
              {data.attention.map((item) => (
                <li key={item.reportId}>
                  <Link
                    to={`/reports/${item.reportId}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2"
                  >
                    <SeverityBadge severity={item.severity} />
                    <span className="w-44 shrink-0 truncate font-medium text-ink">
                      {item.reportName}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                      {item.reason}
                    </span>
                    <span className="font-mono text-[12px] text-ink-3">{item.reportId}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <LiveActivity />
      </div>

      {can('costs:read') && data.cost && (
        <BarsChart
          title="Total cost by period"
          subtitle="Snowflake (fully loaded) plus AWS hosting, for the reports in view"
          data={trend}
          xKey="periodLabel"
          series={[{ key: 'totalCostUsd', label: 'Total cost', color: 'var(--series-1)' }]}
          format={fmtUsdCompact}
          height={200}
        />
      )}
    </div>
  );
}

export function OverviewPage() {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<Overview>('/overview'),
  });
  const asOf = overview.data?.asOf;
  return (
    <>
      <PageHeader
        title="Overview"
        description={
          asOf ? (
            <>
              Latest reporting period{' '}
              <span className="font-medium text-ink">{asOf.periodLabel}</span> (
              {fmtDate(asOf.periodStart)} to {fmtDate(asOf.periodEnd)}), plus live telemetry since.
            </>
          ) : undefined
        }
        actions={
          <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
            <Activity size={14} /> {overview.data?.scope === 'own' ? 'Your reports' : 'All reports'}
          </span>
        }
      />
      <QueryBoundary query={overview}>{(data) => <OverviewBody data={data} />}</QueryBoundary>
    </>
  );
}
