import type { OrphanQueue, OrphanQueueItem } from '@picc/contracts';
import { useQuery } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { AssignOwnerDialog } from '../components/actions';
import { RefreshBadge } from '../components/status';
import {
  Badge,
  Button,
  Card,
  Empty,
  Note,
  PageHeader,
  QueryBoundary,
  Stat,
  TableShell,
  td,
  tdNum,
  th,
  thNum,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtNum, fmtUsd } from '../lib/format';

const ENCODING: Record<string, string> = {
  NAN_LITERAL: 'nan',
  SENTINEL: 'ORPHANED_REPORT',
  EMPTY: 'empty',
};
const LATENCY = {
  OK: 'OK',
  WARNING: 'Slow',
  HIGH: 'Very slow',
  CRITICAL: 'Critical latency',
} as const;

function Queue({ queue }: { queue: OrphanQueue }) {
  const { can } = useAuth();
  const [target, setTarget] = useState<OrphanQueueItem | null>(null);
  const showCost = queue.totalCostAtRiskUsd !== null;
  const alerting = queue.items.filter((i) => i.activeAlerts > 0).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="Reports with no owner"
          value={fmtNum(queue.total)}
          tone={queue.total > 0 ? 'serious' : 'good'}
          hint="in the latest period, after assignments made here"
        />
        {showCost && (
          <Stat
            label="Monthly cost at risk"
            value={fmtUsd(queue.totalCostAtRiskUsd)}
            hint="run-rate spend nobody is accountable for"
          />
        )}
        <Stat
          label="Orphaned and alerting"
          value={fmtNum(alerting)}
          tone={alerting > 0 ? 'critical' : 'good'}
          hint="their alerts go to admins because there is no owner to tell"
        />
      </div>

      <Note>
        The source marks a missing owner two ways: a stringified{' '}
        <code className="font-mono">nan</code> and the sentinel{' '}
        <code className="font-mono">ORPHANED_REPORT</code>. Both are treated as "no owner". The
        suggested owner is the last person named as owner in the report's history.
      </Note>

      <Card title="Remediation queue" subtitle="Most expensive first" flush>
        {queue.items.length === 0 ? (
          <Empty title="Every report has an owner" hint="Nothing to remediate." />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Report</th>
                <th className={th}>State</th>
                <th className={thNum}>Views</th>
                <th className={thNum}>Alerts</th>
                {showCost && <th className={thNum}>At risk / month</th>}
                {showCost && <th className={thNum}>Spent unowned</th>}
                <th className={th}>Suggested owner</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {queue.items.map((item) => (
                <tr key={item.reportId}>
                  <td className={`${td} tnum text-ink-3`}>{item.priorityRank}</td>
                  <td className={td}>
                    <Link
                      to={`/reports/${item.reportId}`}
                      className="font-medium whitespace-nowrap text-ink hover:underline"
                    >
                      {item.reportName}
                    </Link>
                    <div className="text-[12px] whitespace-nowrap text-ink-3">
                      <span className="font-mono">{item.reportId}</span> · owner was{' '}
                      <code className="font-mono">
                        {ENCODING[item.orphanEncoding ?? ''] ?? 'missing'}
                      </code>
                    </div>
                  </td>
                  <td className={td}>
                    <span className="inline-flex flex-wrap gap-1">
                      <RefreshBadge status={item.refreshStatus} />
                      {item.latencySeverity !== 'OK' && (
                        <Badge
                          tone={
                            item.latencySeverity === 'CRITICAL'
                              ? 'critical'
                              : item.latencySeverity === 'HIGH'
                                ? 'serious'
                                : 'warning'
                          }
                        >
                          {LATENCY[item.latencySeverity]}
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className={tdNum}>{fmtNum(item.monthlyActiveViews)}</td>
                  <td className={tdNum}>
                    {item.activeAlerts > 0 ? (
                      <Badge tone="critical">{item.activeAlerts}</Badge>
                    ) : (
                      <span className="text-ink-3">0</span>
                    )}
                  </td>
                  {showCost && (
                    <td className={`${tdNum} font-medium`}>{fmtUsd(item.costAtRiskUsd)}</td>
                  )}
                  {showCost && (
                    <td className={`${tdNum} text-ink-2`}>
                      {fmtUsd(item.lifetimeCostWhileOrphanedUsd)}
                    </td>
                  )}
                  <td className={td}>
                    <div className="whitespace-nowrap">
                      {item.suggestedOwner ?? <span className="text-ink-3">none on record</span>}
                    </div>
                    {item.periodsSinceOwned !== null && (
                      <div className="text-[12px] whitespace-nowrap text-ink-3">
                        owner {item.periodsSinceOwned} period
                        {item.periodsSinceOwned === 1 ? '' : 's'} ago
                      </div>
                    )}
                  </td>
                  <td className={`${td} text-right`}>
                    {can('orphans:assign') && (
                      <Button size="sm" onClick={() => setTarget(item)}>
                        <UserPlus size={13} /> Assign
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
      {target && (
        <AssignOwnerDialog
          reportId={target.reportId}
          reportName={target.reportName}
          suggestedOwner={target.suggestedOwner}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}

export function OrphansPage() {
  const queue = useQuery({
    queryKey: ['orphans'],
    queryFn: () => api.get<OrphanQueue>('/orphans'),
  });
  return (
    <>
      <PageHeader
        title="Orphaned reports"
        description="Reports nobody is accountable for: still refreshed, still hosted, still billed. Ranked by what they cost so the expensive ones get an owner first."
      />
      <QueryBoundary query={queue}>{(data) => <Queue queue={data} />}</QueryBoundary>
    </>
  );
}
