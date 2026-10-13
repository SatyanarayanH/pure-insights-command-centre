import type { RefreshStatus, ReportDetail } from '@picc/contracts';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { AlertActions, AssignOwnerDialog, IncidentButtons } from '../components/actions';
import { BarsChart, TrendChart } from '../components/charts';
import { LiveLatency } from '../components/LiveLatency';
import { AlertStatusBadge, OwnerCell, QuadrantBadge, SeverityBadge } from '../components/status';
import {
  Badge,
  Button,
  Card,
  Empty,
  Note,
  PageHeader,
  QueryBoundary,
  ScrollArea,
  Stat,
  TableShell,
  td,
  th,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtNum, fmtSec, fmtUsd, fmtUsd2, fmtUsdCompact } from '../lib/format';

const REFRESH_CELL: Record<
  RefreshStatus,
  { background: string; color: string; glyph: string; label: string }
> = {
  SUCCESS: { background: 'var(--good)', color: '#0b0b0b', glyph: '', label: 'Success' },
  FAILED: { background: 'var(--critical)', color: '#ffffff', glyph: '×', label: 'Failed' },
  TIMED_OUT: { background: 'var(--serious)', color: '#0b0b0b', glyph: '!', label: 'Timed out' },
  UNKNOWN: { background: 'var(--line-2)', color: 'var(--ink)', glyph: '?', label: 'Unknown' },
};

const LATENCY_HINT = {
  OK: 'within the 15 s threshold',
  WARNING: 'slow: over 15 s',
  HIGH: 'very slow: over 30 s',
  CRITICAL: 'critical: over 45 s',
} as const;

/** Twenty periods as a strip. Each cell carries a glyph as well as a colour. */
function RefreshStrip({ report }: { report: ReportDetail }) {
  return (
    <div>
      <div className="flex gap-1">
        {report.history.map((h) => {
          const cell = REFRESH_CELL[h.refreshStatus];
          return (
            <div
              key={h.periodSeq}
              title={`${h.periodLabel}: ${cell.label}`}
              className="flex h-7 flex-1 items-center justify-center rounded-[5px] text-[12px] font-bold"
              style={{ background: cell.background, color: cell.color }}
            >
              {cell.glyph}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-3">
        <span>{report.history[0]?.periodLabel}</span>
        <span>{report.history.at(-1)?.periodLabel}</span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        {(Object.keys(REFRESH_CELL) as RefreshStatus[]).map((status) => (
          <li key={status} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] text-[9px] font-bold"
              style={{
                background: REFRESH_CELL[status].background,
                color: REFRESH_CELL[status].color,
              }}
            >
              {REFRESH_CELL[status].glyph}
            </span>
            {REFRESH_CELL[status].label} ·{' '}
            {report.history.filter((h) => h.refreshStatus === status).length}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OwnershipTrail({ report }: { report: ReportDetail }) {
  const changes = report.ownership.history.filter(
    (h) => h.changeType !== 'UNCHANGED' && h.changeType !== 'STILL_ORPHANED',
  );
  const label: Record<string, string> = {
    INITIAL: 'First seen with owner',
    INITIAL_ORPHANED: 'First seen with no owner',
    REASSIGNED: 'Reassigned to',
    ORPHANED: 'Lost its owner',
    CLAIMED: 'Claimed by',
  };
  return (
    <div>
      <div className="flex gap-1">
        {report.ownership.history.map((h) => (
          <div
            key={h.periodSeq}
            title={`${h.periodLabel}: ${h.ownerEmail ?? 'no owner'}`}
            className="h-2.5 flex-1 rounded-full"
            style={{ background: h.ownerEmail ? 'var(--series-1)' : 'var(--serious)' }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex gap-4 text-[12.5px] text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: 'var(--series-1)' }} /> Owned
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: 'var(--serious)' }} /> No
          owner · {report.ownership.periodsOrphaned} of {report.ownership.history.length} periods
        </span>
      </div>
      <ScrollArea label="Ownership changes" className="mt-3 max-h-56 overflow-y-auto">
        <ol className="space-y-1.5 text-[13px]">
          {report.ownership.assignments.map((a) => (
            <li key={`a-${a.id}`} className="flex gap-3">
              <span className="w-10 shrink-0 text-[12px] font-medium text-accent-ink">now</span>
              <span className="text-ink">
                Assigned to <span className="font-medium">{a.ownerEmail}</span> by {a.assignedBy}
                <span className="text-ink-3"> · {fmtDateTime(a.assignedAt)}</span>
                {a.note && <span className="block text-ink-2">“{a.note}”</span>}
              </span>
            </li>
          ))}
          {[...changes].reverse().map((h) => (
            <li key={h.periodSeq} className="flex gap-3">
              <span className="tnum w-10 shrink-0 text-[12px] text-ink-3">{h.periodLabel}</span>
              <span className="text-ink-2">
                {label[h.changeType] ?? h.changeType}{' '}
                {h.ownerEmail && <span className="font-medium text-ink">{h.ownerEmail}</span>}
              </span>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </div>
  );
}

function Detail({ report }: { report: ReportDetail }) {
  const { can } = useAuth();
  const [assigning, setAssigning] = useState(false);
  const history = report.history.map((h) => ({
    periodLabel: h.periodLabel,
    loadTimeSec: h.loadTimeSec,
    views: h.monthlyActiveViews,
    snowflake: h.cost?.snowflakeCostLoadedUsd ?? null,
    aws: h.cost?.awsHostingCostUsd ?? null,
    costPerView: h.cost?.totalCostPerViewUsd ?? null,
  }));
  const quarantined = report.history.filter((h) => h.flags.costQuarantined);
  const zeroViews = report.history.filter((h) => h.flags.zeroViews);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Load time"
          value={fmtSec(report.loadTimeSec)}
          tone={
            report.latencySeverity === 'OK'
              ? 'good'
              : report.latencySeverity === 'CRITICAL'
                ? 'critical'
                : 'serious'
          }
          hint={`${LATENCY_HINT[report.latencySeverity]}${report.lastObservedAt ? ` · observed ${fmtAgo(report.lastObservedAt)}` : ''}`}
        />
        <Stat
          label="Last refresh"
          value={REFRESH_CELL[report.refreshStatus].label}
          tone={
            report.refreshStatus === 'SUCCESS'
              ? 'good'
              : report.refreshStatus === 'UNKNOWN'
                ? 'neutral'
                : 'critical'
          }
          hint={
            report.refreshFailureStreak > 0
              ? `${report.refreshFailureStreak} consecutive failure${report.refreshFailureStreak > 1 ? 's' : ''}`
              : 'no failure streak'
          }
        />
        <Stat
          label="Monthly active views"
          value={fmtNum(report.monthlyActiveViews)}
          hint={`${fmtNum(report.queryCount30d)} queries · peak ${fmtNum(report.concurrentUserPeak)} concurrent`}
        />
        {report.cost ? (
          <Stat
            label="Cost this period"
            value={fmtUsd(report.cost.totalCostUsd)}
            hint={
              <>
                {fmtUsd2(report.cost.totalCostPerViewUsd)} per view
                {report.cost.isCostImputed ? ' · estimated' : ''}
              </>
            }
          />
        ) : (
          <Stat label="Open alerts" value={fmtNum(report.activeAlerts)} />
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <TrendChart
          title="Load time by period"
          subtitle="Average dashboard load, seconds"
          data={history}
          xKey="periodLabel"
          series={[{ key: 'loadTimeSec', label: 'Load time', color: 'var(--series-1)' }]}
          format={(v) => `${v.toFixed(0)} s`}
          threshold={{ value: 15, label: '15 s alert threshold' }}
          yDomain={[0, 60]}
        />
        {report.cost ? (
          <BarsChart
            title="Cost by period"
            subtitle="Snowflake (fully loaded) and AWS hosting"
            data={history}
            xKey="periodLabel"
            stacked
            series={[
              { key: 'snowflake', label: 'Snowflake', color: 'var(--series-1)' },
              { key: 'aws', label: 'AWS hosting', color: 'var(--series-2)' },
            ]}
            format={fmtUsdCompact}
          />
        ) : (
          <BarsChart
            title="Views by period"
            subtitle="Monthly active views"
            data={history}
            xKey="periodLabel"
            series={[{ key: 'views', label: 'Views', color: 'var(--series-1)' }]}
          />
        )}
      </div>

      <LiveLatency reportId={report.reportId} />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card
          title="Refresh history"
          subtitle={`Outcome of the automated refresh in each of the ${report.history.length} periods`}
        >
          <RefreshStrip report={report} />
        </Card>
        <Card
          title="Ownership"
          subtitle={`${report.ownership.distinctOwners} different owners · ${report.ownership.ownershipChanges} changes`}
          actions={
            can('orphans:assign') && (
              <Button size="sm" onClick={() => setAssigning(true)}>
                <UserPlus size={13} /> {report.isOrphaned ? 'Assign owner' : 'Reassign'}
              </Button>
            )
          }
        >
          <OwnershipTrail report={report} />
        </Card>
      </div>

      <Card
        title="Open alerts"
        subtitle={report.alerts.length ? undefined : 'None right now'}
        flush
      >
        {report.alerts.length > 0 && (
          <TableShell>
            <thead>
              <tr>
                <th className={th}>Severity</th>
                <th className={th}>Rule</th>
                <th className={th}>What is happening</th>
                <th className={th}>Seen</th>
                <th className={th}>Routed to</th>
                <th className={th}>Status</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {report.alerts.map((alert) => (
                <tr key={alert.id}>
                  <td className={td}>
                    <SeverityBadge severity={alert.severity} />
                  </td>
                  <td className={td}>{alert.ruleName}</td>
                  <td className={td}>{alert.message}</td>
                  <td className={`${td} tnum whitespace-nowrap text-ink-2`}>
                    {alert.occurrences}× · first {fmtAgo(alert.firstSeenAt)}
                  </td>
                  <td className={td}>
                    {alert.routing.escalated ? (
                      <Badge tone="serious">Admins (no owner)</Badge>
                    ) : (
                      alert.routing.ownerEmail
                    )}
                  </td>
                  <td className={td}>
                    <AlertStatusBadge
                      status={alert.status}
                      flapping={alert.isFlapping}
                      snoozed={Boolean(alert.snoozedUntil)}
                      recovering={
                        alert.healthyStreak > 0
                          ? { healthy: alert.healthyStreak, needed: alert.resolveAfter }
                          : null
                      }
                    />
                  </td>
                  <td className={`${td} text-right`}>
                    <AlertActions alert={alert} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      {(quarantined.length > 0 || zeroViews.length > 0 || report.findings.length > 0) && (
        <Card
          title="Data-quality findings for this report"
          subtitle="From the SQL suite's rule run"
          flush
        >
          <div className="space-y-2 px-5 pb-3">
            {quarantined.length > 0 && report.cost && (
              <Note tone="warning">
                Reported credits were negative in {quarantined.map((h) => h.periodLabel).join(', ')}
                . That figure is quarantined; the cost shown for those periods is estimated from
                query execution time.
              </Note>
            )}
            {zeroViews.length > 0 && (
              <Note>
                No views at all in {zeroViews.map((h) => h.periodLabel).join(', ')}: cost per view
                is undefined for those periods.
              </Note>
            )}
          </div>
          {report.findings.length > 0 && (
            <TableShell>
              <thead>
                <tr>
                  <th className={th}>Rule</th>
                  <th className={th}>Period</th>
                  <th className={th}>Observed</th>
                  <th className={th}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.findings.map((f) => (
                  <tr key={`${f.ruleId}-${f.periodSeq}`}>
                    <td className={td}>
                      <span className="font-mono text-[12px] text-ink-3">{f.ruleId}</span>{' '}
                      {f.ruleName.replaceAll('_', ' ').toLowerCase()}
                    </td>
                    <td className={`${td} tnum`}>P{String(f.periodSeq + 1).padStart(2, '0')}</td>
                    <td className={`${td} font-mono text-[12.5px]`}>{f.observedValue}</td>
                    <td className={`${td} text-ink-2`}>{f.detail}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      )}

      {can('incidents:inject') && (
        <Card
          title="Simulate an incident"
          subtitle="Sends one observation for this report through the real telemetry pipeline. Open a second browser as another role and watch it arrive."
        >
          <IncidentButtons reportId={report.reportId} />
        </Card>
      )}

      {assigning && (
        <AssignOwnerDialog
          reportId={report.reportId}
          reportName={report.reportName}
          suggestedOwner={report.isOrphaned ? report.ownership.lastKnownOwner : null}
          onClose={() => setAssigning(false)}
        />
      )}
    </div>
  );
}

export function ReportDetailPage() {
  const { reportId = '' } = useParams();
  const report = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => api.get<ReportDetail>(`/reports/${reportId}`),
  });
  return (
    <>
      <Link
        to="/reports"
        className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
      >
        <ChevronLeft size={14} /> Reports
      </Link>
      <PageHeader
        title={report.data?.reportName ?? reportId}
        description={
          report.data && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-[12.5px] text-ink-3">{report.data.reportId}</span>
              <OwnerCell email={report.data.ownerEmail} source={report.data.ownerSource} />
              {report.data.efficiencyQuadrant && (
                <QuadrantBadge quadrant={report.data.efficiencyQuadrant} />
              )}
            </span>
          )
        }
      />
      <QueryBoundary query={report}>
        {(data) => (data ? <Detail report={data} /> : <Empty title="Not found" />)}
      </QueryBoundary>
    </>
  );
}
