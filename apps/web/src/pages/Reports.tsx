import type { ReportListQuery, ReportSummary } from '@picc/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import {
  LatencyBadge,
  OwnerCell,
  QuadrantBadge,
  RefreshBadge,
  SeverityBadge,
} from '../components/status';
import {
  Card,
  cx,
  Empty,
  ErrorState,
  inputClass,
  Loading,
  PageHeader,
  Pager,
  Select,
  TableShell,
  td,
  tdNum,
  th,
  thNum,
} from '../components/ui';
import { api, query } from '../lib/api';
import { fmtNum, fmtUsd, fmtUsd2 } from '../lib/format';

type SortField = ReportListQuery['sort'];
interface Page {
  items: ReportSummary[];
  total: number;
  page: number;
  pageSize: number;
}

function SortHeader({
  field,
  label,
  sort,
  order,
  onSort,
  numeric,
}: {
  field: SortField;
  label: string;
  sort: SortField;
  order: 'asc' | 'desc';
  onSort: (f: SortField) => void;
  numeric?: boolean;
}) {
  const active = sort === field;
  return (
    <th
      className={numeric ? thNum : th}
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cx(
          'inline-flex items-center gap-1 uppercase hover:text-ink',
          active && 'text-ink',
        )}
      >
        {label}
        {active ? (
          order === 'asc' ? (
            <ArrowUp size={12} />
          ) : (
            <ArrowDown size={12} />
          )
        ) : (
          <ArrowUpDown size={12} className="opacity-50" />
        )}
      </button>
    </th>
  );
}

export function ReportsPage() {
  const { can } = useAuth();
  const showCost = can('costs:read');
  const navigate = useNavigate();
  // Filters live in the URL, so a filtered view can be bookmarked or shared.
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? '';
  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };

  const [search, setSearch] = useState(get('q'));
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce on the typed text only
  useEffect(() => {
    const timer = setTimeout(() => search !== get('q') && set({ q: search }), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const sort = (get('sort') || 'reportId') as SortField;
  const order = (get('order') || 'asc') as 'asc' | 'desc';
  const page = Number(get('page') || 1);
  const onSort = (field: SortField) =>
    set({ sort: field, order: sort === field && order === 'desc' ? 'asc' : 'desc' });

  const filters = {
    q: get('q'),
    refreshStatus: get('refreshStatus'),
    latencySeverity: get('latencySeverity'),
    orphaned: get('orphaned'),
    hasAlerts: get('hasAlerts'),
    quadrant: get('quadrant'),
    sort,
    order,
    page,
    pageSize: 25,
  };
  const reports = useQuery({
    queryKey: ['reports', filters],
    queryFn: () => api.get<Page>(`/reports${query(filters)}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Reports"
        description="Every report on the portal with its current owner, refresh state, load time and open alerts."
      />
      <Card flush>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
            />
            <input
              aria-label="Search reports"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search id, name or owner"
              className={`${inputClass} w-64 pl-8`}
            />
          </div>
          <Select
            aria-label="Refresh status"
            value={get('refreshStatus')}
            onChange={(e) => set({ refreshStatus: e.target.value })}
          >
            <option value="">Any refresh status</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILED">Failed</option>
            <option value="TIMED_OUT">Timed out</option>
            <option value="UNKNOWN">Unknown</option>
          </Select>
          <Select
            aria-label="Load time"
            value={get('latencySeverity')}
            onChange={(e) => set({ latencySeverity: e.target.value })}
          >
            <option value="">Any load time</option>
            <option value="OK">OK (≤ 15 s)</option>
            <option value="WARNING">Slow</option>
            <option value="HIGH">Very slow</option>
            <option value="CRITICAL">Critical</option>
          </Select>
          <Select
            aria-label="Ownership"
            value={get('orphaned')}
            onChange={(e) => set({ orphaned: e.target.value })}
          >
            <option value="">Owned and orphaned</option>
            <option value="true">Orphaned only</option>
            <option value="false">Owned only</option>
          </Select>
          <Select
            aria-label="Alerts"
            value={get('hasAlerts')}
            onChange={(e) => set({ hasAlerts: e.target.value })}
          >
            <option value="">With or without alerts</option>
            <option value="true">With open alerts</option>
            <option value="false">No open alerts</option>
          </Select>
          {showCost && (
            <Select
              aria-label="Efficiency class"
              value={get('quadrant')}
              onChange={(e) => set({ quadrant: e.target.value })}
            >
              <option value="">Any efficiency class</option>
              <option value="ZOMBIE">Zombie</option>
              <option value="COSTLY">Costly</option>
              <option value="WORKHORSE">Workhorse</option>
              <option value="EFFICIENT">Efficient</option>
              <option value="NICHE">Niche</option>
            </Select>
          )}
          <span className="tnum ml-auto text-[13px] text-ink-2">
            {reports.data ? `${reports.data.total} reports` : ''}
          </span>
        </div>

        {reports.isError ? (
          <ErrorState error={reports.error} onRetry={() => void reports.refetch()} />
        ) : !reports.data ? (
          <Loading />
        ) : reports.data.items.length === 0 ? (
          <Empty title="No reports match these filters" />
        ) : (
          <>
            <TableShell>
              <thead>
                <tr>
                  <SortHeader
                    field="reportId"
                    label="Report"
                    sort={sort}
                    order={order}
                    onSort={onSort}
                  />
                  <SortHeader
                    field="ownerEmail"
                    label="Owner"
                    sort={sort}
                    order={order}
                    onSort={onSort}
                  />
                  <SortHeader
                    field="refreshFailureStreak"
                    label="Refresh"
                    sort={sort}
                    order={order}
                    onSort={onSort}
                  />
                  <SortHeader
                    field="loadTimeSec"
                    label="Load time"
                    sort={sort}
                    order={order}
                    onSort={onSort}
                  />
                  <SortHeader
                    field="monthlyActiveViews"
                    label="Views"
                    sort={sort}
                    order={order}
                    onSort={onSort}
                    numeric
                  />
                  <SortHeader
                    field="activeAlerts"
                    label="Alerts"
                    sort={sort}
                    order={order}
                    onSort={onSort}
                  />
                  {showCost && (
                    <SortHeader
                      field="totalCostUsd"
                      label="Cost / period"
                      sort={sort}
                      order={order}
                      onSort={onSort}
                      numeric
                    />
                  )}
                  {showCost && (
                    <SortHeader
                      field="totalCostPerViewUsd"
                      label="Cost / view"
                      sort={sort}
                      order={order}
                      onSort={onSort}
                      numeric
                    />
                  )}
                  {showCost && <th className={th}>Class</th>}
                </tr>
              </thead>
              <tbody className={reports.isPlaceholderData ? 'opacity-60' : ''}>
                {reports.data.items.map((report) => (
                  <tr
                    key={report.reportId}
                    tabIndex={0}
                    onClick={() => navigate(`/reports/${report.reportId}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/reports/${report.reportId}`)}
                    className="cursor-pointer hover:bg-surface-2"
                  >
                    <td className={td}>
                      <div className="font-medium whitespace-nowrap text-ink">
                        {report.reportName}
                      </div>
                      <div className="font-mono text-[12px] text-ink-3">{report.reportId}</div>
                    </td>
                    <td className={`${td} max-w-56`}>
                      <OwnerCell email={report.ownerEmail} source={report.ownerSource} />
                    </td>
                    <td className={td}>
                      <RefreshBadge
                        status={report.refreshStatus}
                        streak={report.refreshFailureStreak}
                      />
                    </td>
                    <td className={td}>
                      <LatencyBadge
                        seconds={report.loadTimeSec}
                        severity={report.latencySeverity}
                      />
                    </td>
                    <td className={tdNum}>{fmtNum(report.monthlyActiveViews)}</td>
                    <td className={td}>
                      {report.activeAlerts > 0 && report.highestAlertSeverity ? (
                        <span className="inline-flex items-center gap-1.5">
                          <SeverityBadge severity={report.highestAlertSeverity} />
                          {report.activeAlerts > 1 && (
                            <span className="tnum text-[12.5px] text-ink-2">
                              +{report.activeAlerts - 1}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    {showCost && (
                      <td className={tdNum}>
                        {fmtUsd(report.cost?.totalCostUsd)}
                        {report.cost?.isCostImputed && (
                          <span
                            className="ml-1 text-[11px] text-warning-ink"
                            title="Reported credits were invalid; cost estimated from execution time"
                          >
                            est.
                          </span>
                        )}
                      </td>
                    )}
                    {showCost && (
                      <td className={tdNum}>{fmtUsd2(report.cost?.totalCostPerViewUsd)}</td>
                    )}
                    {showCost && (
                      <td className={td}>
                        <QuadrantBadge quadrant={report.efficiencyQuadrant} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableShell>
            <Pager
              page={reports.data.page}
              pageSize={reports.data.pageSize}
              total={reports.data.total}
              onPage={(p) => set({ page: String(p) })}
            />
          </>
        )}
      </Card>
    </>
  );
}
