import type { Alert, AlertDetail, AlertRule, AlertStats } from '@picc/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { AlertActions } from '../components/actions';
import { AlertStatusBadge, SeverityBadge } from '../components/status';
import {
  Badge,
  Card,
  cx,
  Empty,
  ErrorState,
  Loading,
  Modal,
  Note,
  PageHeader,
  Pager,
  QueryBoundary,
  ScrollArea,
  Segmented,
  Select,
  Stat,
  TableShell,
  td,
  th,
} from '../components/ui';
import { api, query } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtNum } from '../lib/format';
import { useRealtime } from '../realtime/RealtimeProvider';

type StatusFilter = 'active' | 'firing' | 'acknowledged' | 'resolved' | 'all';
interface Page {
  items: Alert[];
  total: number;
  page: number;
  pageSize: number;
}

const fmtValue = (alert: Pick<Alert, 'value' | 'unit'>): string =>
  alert.value === null
    ? '—'
    : alert.unit === 'seconds'
      ? `${alert.value.toFixed(1)} s`
      : alert.unit === 'consecutive failures'
        ? `${alert.value} in a row`
        : String(alert.value);

function AlertDrawer({ alertId, onClose }: { alertId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['alerts', 'detail', alertId],
    queryFn: () => api.get<AlertDetail>(`/alerts/${alertId}`),
  });
  return (
    <Modal title="Alert timeline" onClose={onClose} wide>
      <QueryBoundary query={detail}>
        {(alert) => (
          <div className="space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={alert.severity} />
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
                <Link
                  to={`/reports/${alert.reportId}`}
                  onClick={onClose}
                  className="font-medium text-ink hover:underline"
                >
                  {alert.reportName}
                </Link>
                <span className="font-mono text-[12px] text-ink-3">{alert.reportId}</span>
              </div>
              <p className="mt-2 text-[14px] text-ink">{alert.message}</p>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
              {[
                ['Rule', alert.ruleName],
                ['Breaching observations', String(alert.occurrences)],
                ['Reopened', `${alert.reopenCount}×`],
                [
                  'Routed to',
                  alert.routing.escalated ? 'Admins (no owner)' : (alert.routing.ownerEmail ?? '—'),
                ],
                ['First seen', fmtDateTime(alert.firstSeenAt)],
                ['Last seen', fmtDateTime(alert.lastSeenAt)],
                ['Acknowledged by', alert.acknowledgedBy ?? '—'],
                ['Source', alert.source],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[12px] text-ink-3">{label}</dt>
                  <dd className="text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <div>
              <div className="mb-2 text-[13px] font-medium">Timeline</div>
              <ScrollArea label="Alert timeline" className="max-h-64 overflow-y-auto">
                <ol className="space-y-2 border-l border-line pl-4">
                  {[...alert.timeline].reverse().map((entry) => (
                    <li key={entry.id} className="relative text-[13px]">
                      <span className="absolute top-1.5 -left-[20.5px] h-2 w-2 rounded-full bg-line-2" />
                      <span className="font-medium text-ink capitalize">{entry.type}</span>
                      <span className="text-ink-2"> · {entry.actor}</span>
                      <span className="text-ink-3"> · {fmtDateTime(entry.at)}</span>
                      {entry.detail && <div className="text-ink-2">{entry.detail}</div>}
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            </div>
            <div className="flex justify-end">
              <AlertActions alert={alert} />
            </div>
          </div>
        )}
      </QueryBoundary>
    </Modal>
  );
}

function Rules() {
  const { can } = useAuth();
  const allowed = can('alert-rules:read');
  const rules = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api.get<{ items: AlertRule[] }>('/alert-rules'),
    // Do not ask for something the role cannot have: it would only log a 403.
    enabled: allowed,
  });
  if (!allowed) return null;
  return (
    <Card
      title="Alert rules"
      subtitle="What opens an alert, how severe it is, and when it clears"
      flush
    >
      <QueryBoundary query={rules}>
        {({ items }) => (
          <TableShell>
            <thead>
              <tr>
                <th className={th}>Rule</th>
                <th className={th}>Source</th>
                <th className={th}>Fires when</th>
                <th className={th}>Severity</th>
                <th className={th}>Clears after</th>
              </tr>
            </thead>
            <tbody>
              {items.map((rule) => (
                <tr key={rule.id}>
                  <td className={`${td} max-w-md`}>
                    <div className="font-medium text-ink">
                      {rule.name}
                      {!rule.enabled && (
                        <span className="ml-2">
                          <Badge>Disabled</Badge>
                        </span>
                      )}
                    </div>
                    <div className="text-[12.5px] text-ink-2">{rule.description}</div>
                  </td>
                  <td className={td}>
                    {rule.inBrief ? <Badge tone="accent">Brief</Badge> : <Badge>Added</Badge>}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    {rule.id === 'latency'
                      ? `load time > ${rule.warningThreshold} s`
                      : rule.id === 'refresh_failure'
                        ? 'FAILED or TIMED_OUT'
                        : rule.id === 'refresh_unknown'
                          ? 'status UNKNOWN'
                          : 'credits < 0'}
                  </td>
                  <td className={`${td} whitespace-nowrap text-ink-2`}>
                    {rule.id === 'latency'
                      ? `warning > ${rule.warningThreshold} · high > ${rule.highThreshold} · critical > ${rule.criticalThreshold} s`
                      : rule.id === 'refresh_failure'
                        ? `high · critical from ${rule.escalateAfter} in a row`
                        : rule.id === 'refresh_unknown'
                          ? 'info'
                          : 'warning'}
                  </td>
                  <td className={`${td} whitespace-nowrap text-ink-2`}>
                    {rule.resolveAfter} healthy observation{rule.resolveAfter > 1 ? 's' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </QueryBoundary>
    </Card>
  );
}

export function AlertsPage() {
  const { recentAlertIds } = useRealtime();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as StatusFilter | null) ?? 'active';
  const severity = params.get('severity') ?? '';
  const ruleId = params.get('ruleId') ?? '';
  const escalated = params.get('escalated') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [open, setOpen] = useState<string | null>(null);
  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };

  const stats = useQuery({
    queryKey: ['alerts', 'stats'],
    queryFn: () => api.get<AlertStats>('/alerts/stats'),
  });
  const filters = { status, severity, ruleId, escalated, page, pageSize: 25 };
  const alerts = useQuery({
    queryKey: ['alerts', 'list', filters],
    queryFn: () => api.get<Page>(`/alerts${query(filters)}`),
    placeholderData: keepPreviousData,
  });
  const s = stats.data;

  return (
    <>
      <PageHeader
        title="Alerts"
        description="One alert per rule per report. Repeat breaches raise the count on the existing alert instead of opening another, so the list is as long as the number of problems, not the number of observations."
      />
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Open alerts"
            value={fmtNum(s ? s.firing + s.acknowledged : undefined)}
            tone={s && s.bySeverity.critical > 0 ? 'critical' : 'neutral'}
            hint={
              s
                ? `${s.bySeverity.critical} critical · ${s.bySeverity.high} high · ${s.bySeverity.warning} warning · ${s.bySeverity.info} info`
                : undefined
            }
          />
          <Stat
            label="Not yet acknowledged"
            value={fmtNum(s?.firing)}
            tone={s && s.firing > 0 ? 'serious' : 'good'}
            hint={s ? `firing · ${s.acknowledged} more acknowledged by someone` : undefined}
          />
          <Stat
            label="Escalated to admins"
            value={fmtNum(s?.escalated)}
            tone={s && s.escalated > 0 ? 'serious' : 'good'}
            hint="the report has no owner to notify"
          />
          <Stat
            label="Flapping"
            value={fmtNum(s?.flapping)}
            hint="resolved and reopened repeatedly; notifications muted"
          />
        </div>

        <Card flush>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <Segmented<StatusFilter>
              label="Alert status"
              value={status}
              onChange={(value) => set({ status: value === 'active' ? '' : value })}
              options={[
                { value: 'active', label: 'Open' },
                { value: 'firing', label: 'Firing' },
                { value: 'acknowledged', label: 'Acknowledged' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'all', label: 'All' },
              ]}
            />
            <Select
              aria-label="Severity"
              value={severity}
              onChange={(e) => set({ severity: e.target.value })}
            >
              <option value="">Any severity</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </Select>
            <Select
              aria-label="Rule"
              value={ruleId}
              onChange={(e) => set({ ruleId: e.target.value })}
            >
              <option value="">Any rule</option>
              <option value="latency">Load latency</option>
              <option value="refresh_failure">Refresh failed</option>
              <option value="refresh_unknown">Refresh unknown</option>
              <option value="invalid_telemetry">Invalid telemetry</option>
            </Select>
            <Select
              aria-label="Routing"
              value={escalated}
              onChange={(e) => set({ escalated: e.target.value })}
            >
              <option value="">Any routing</option>
              <option value="true">Escalated (no owner)</option>
              <option value="false">Routed to an owner</option>
            </Select>
            <span className="tnum ml-auto text-[13px] text-ink-2">
              {alerts.data ? `${alerts.data.total} alerts` : ''}
            </span>
          </div>

          {alerts.isError ? (
            <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
          ) : !alerts.data ? (
            <Loading />
          ) : alerts.data.items.length === 0 ? (
            <Empty title="No alerts match" hint="Try a different status or clear the filters." />
          ) : (
            <>
              <TableShell>
                <thead>
                  <tr>
                    <th className={th}>Severity</th>
                    <th className={th}>Report</th>
                    <th className={th}>What is happening</th>
                    <th className={th}>Seen</th>
                    <th className={th}>Routed to</th>
                    <th className={th}>Status</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody className={alerts.isPlaceholderData ? 'opacity-60' : ''}>
                  {alerts.data.items.map((alert) => (
                    <tr
                      key={alert.id}
                      className={cx(
                        'cursor-pointer hover:bg-surface-2',
                        recentAlertIds.has(alert.id) && 'flash',
                      )}
                      tabIndex={0}
                      onClick={() => setOpen(alert.id)}
                      onKeyDown={(e) => e.key === 'Enter' && setOpen(alert.id)}
                    >
                      <td className={td}>
                        <SeverityBadge severity={alert.severity} />
                      </td>
                      <td className={td}>
                        <div className="font-medium whitespace-nowrap text-ink">
                          {alert.reportName}
                        </div>
                        <div className="font-mono text-[12px] text-ink-3">{alert.reportId}</div>
                      </td>
                      <td className={`${td} max-w-[17rem] xl:max-w-[26rem]`}>
                        <div className="truncate" title={alert.message}>
                          {alert.message}
                        </div>
                        <div className="truncate text-[12px] text-ink-3">
                          {alert.ruleName} · latest {fmtValue(alert)}
                        </div>
                      </td>
                      <td className={`${td} tnum whitespace-nowrap`}>
                        <div>{alert.occurrences}×</div>
                        <div className="text-[12px] text-ink-3">{fmtAgo(alert.lastSeenAt)}</div>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
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
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the row click; the buttons inside are keyboard-operable */}
                      <td
                        className={`${td} text-right whitespace-nowrap`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <AlertActions alert={alert} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
              <Pager
                page={alerts.data.page}
                pageSize={alerts.data.pageSize}
                total={alerts.data.total}
                onPage={(p) => set({ page: String(p) })}
              />
            </>
          )}
        </Card>

        <Note>
          An alert describes an incident, not the latest reading. A latency alert stays open until
          two healthy readings arrive in a row, so a report can show a good load time on the Reports
          page while its alert here is marked Recovering 1/2. When most observations break a rule,
          as they do in the case-study dataset, alerting on each one would be noise. Every breach
          still produces an event on the stream; the engine groups them, tiers severity at 15, 30
          and 45 seconds, waits for consecutive healthy readings before clearing, and mutes alerts
          that flap.
        </Note>
        <Rules />
      </div>
      {open && <AlertDrawer alertId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
