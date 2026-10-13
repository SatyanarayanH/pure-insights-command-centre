import {
  type AlertRule,
  type AuditEntry,
  type Notification,
  PERMISSIONS,
  ROLE_DEFINITIONS,
  ROLES,
  type SimulatorState,
  type SystemStatus,
  type User,
  type WarehouseRefreshResult,
} from '@picc/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pause, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IncidentButtons } from '../components/actions';
import { RefreshBadge } from '../components/status';
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  inputClass,
  Note,
  PageHeader,
  Pager,
  QueryBoundary,
  ScrollArea,
  Segmented,
  Select,
  TableShell,
  td,
  tdNum,
  th,
  thNum,
} from '../components/ui';
import { api, query } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtSec } from '../lib/format';
import { useRealtime } from '../realtime/RealtimeProvider';

type Tab = 'live' | 'rules' | 'notifications' | 'access' | 'audit';

function LiveTab() {
  const queryClient = useQueryClient();
  const { telemetry, subscribe, unsubscribe, state } = useRealtime();
  const [reportId, setReportId] = useState('RPT_203');
  const simulator = useQuery({
    queryKey: ['simulator'],
    queryFn: () => api.get<SimulatorState>('/admin/simulator'),
    refetchInterval: 5000,
  });
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/system/status'),
    refetchInterval: 5000,
  });
  const update = useMutation({
    mutationFn: (body: { running?: boolean; intervalMs?: number }) =>
      api.put<SimulatorState>('/admin/simulator', body),
    onSuccess: (data) => queryClient.setQueryData(['simulator'], data),
  });
  const refresh = useMutation({
    mutationFn: () => api.post<WarehouseRefreshResult>('/admin/warehouse/refresh', {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['system-status'] }),
  });

  // The raw telemetry feed is high volume, so it is subscribed to only while this tab is open.
  useEffect(() => {
    if (state.status !== 'open') return;
    subscribe('telemetry');
    return () => unsubscribe('telemetry');
  }, [state.status, subscribe, unsubscribe]);

  const valid = /^RPT_\d{1,6}$/.test(reportId);
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <div className="space-y-5">
        <Card
          title="Inject an incident"
          subtitle="Pushes one observation through the real telemetry pipeline. The alert it causes is a real alert."
        >
          <label htmlFor="incident-report" className="block text-[13px] font-medium">
            Report id
          </label>
          <input
            id="incident-report"
            value={reportId}
            onChange={(e) => setReportId(e.target.value.trim().toUpperCase())}
            className={`${inputClass} mt-1 mb-3 w-40 font-mono`}
            placeholder="RPT_203"
          />
          {valid ? (
            <IncidentButtons reportId={reportId} />
          ) : (
            <p className="text-[13px] text-critical-ink">Report ids look like RPT_203.</p>
          )}
          <div className="mt-4">
            <Note>
              To see it work: open a second browser window, sign in as a different role, and inject
              a latency spike here. Admins and viewers see the alert at once; a Report Owner sees it
              only if the report is theirs.
            </Note>
          </div>
        </Card>

        <Card
          title="Telemetry simulator"
          subtitle="Stands in for the portal's emitter by replaying each report's own historical observations"
        >
          <QueryBoundary query={simulator}>
            {(sim) => (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={sim.running ? 'good' : 'neutral'}>
                  {sim.running ? 'Running' : 'Paused'}
                </Badge>
                <Button
                  busy={update.isPending}
                  onClick={() => update.mutate({ running: !sim.running })}
                >
                  {sim.running ? <Pause size={14} /> : <Play size={14} />}{' '}
                  {sim.running ? 'Pause' : 'Start'}
                </Button>
                <Select
                  aria-label="Pace"
                  value={sim.intervalMs}
                  onChange={(e) => update.mutate({ intervalMs: Number(e.target.value) })}
                >
                  {[500, 1000, 2500, 5000, 10000].map((ms) => (
                    <option key={ms} value={ms}>
                      one event every {ms / 1000} s
                    </option>
                  ))}
                  {![500, 1000, 2500, 5000, 10000].includes(sim.intervalMs) && (
                    <option value={sim.intervalMs}>
                      one event every {sim.intervalMs / 1000} s
                    </option>
                  )}
                </Select>
                <span className="tnum text-[13px] text-ink-2">
                  {sim.eventsEmitted.toLocaleString()} events · last {fmtAgo(sim.lastEventAt)}
                </span>
              </div>
            )}
          </QueryBoundary>
        </Card>

        <Card
          title="System status"
          actions={
            <Button busy={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw size={14} /> Refresh warehouse
            </Button>
          }
        >
          <QueryBoundary query={status}>
            {(s) => (
              <>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
                  {[
                    ['Service', `${s.service} ${s.version}`],
                    ['Uptime', `${Math.floor(s.uptimeSec / 60)} min`],
                    [
                      'Warehouse',
                      `${s.warehouse.source} · ${s.warehouse.reconciliationPassed}/${s.warehouse.reconciliationTotal} checks pass`,
                    ],
                    ['Warehouse built', fmtDateTime(s.warehouse.builtAt)],
                    [
                      'Scheduled refresh',
                      s.warehouse.refreshEveryMin > 0
                        ? `every ${s.warehouse.refreshEveryMin} min`
                        : 'off (on demand)',
                    ],
                    [
                      'Last refresh',
                      s.warehouse.lastRefreshAt
                        ? `${s.warehouse.lastRefreshOutcome} · ${fmtAgo(s.warehouse.lastRefreshAt)}`
                        : 'not since start',
                    ],
                    [
                      'Telemetry feed',
                      s.telemetry.feedSilent
                        ? 'silent'
                        : `receiving · last ${fmtAgo(s.telemetry.lastReceivedAt)}`,
                    ],
                    [
                      'Readings stored',
                      `${s.telemetry.observationsStored.toLocaleString()} · kept ${s.telemetry.retentionDays} days`,
                    ],
                    [
                      'Notifications',
                      s.notifications.channel === 'webhook'
                        ? `webhook · from ${s.notifications.minSeverity}`
                        : 'recorded only (no webhook set)',
                    ],
                    ['Escalate if unacknowledged', `after ${s.notifications.escalateAfterMin} min`],
                    ['WebSocket clients', String(s.realtime.webSocketClients)],
                    ['SSE clients', String(s.realtime.sseClients)],
                    ['Latest event id', `#${s.realtime.latestEventId}`],
                    ['Replay buffer', `${s.realtime.bufferedEvents} events`],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[12px] text-ink-3">{label}</dt>
                      <dd className="tnum text-ink">{value}</dd>
                    </div>
                  ))}
                </dl>
                {refresh.data && (
                  <div className="mt-4">
                    <Note tone={refresh.data.outcome === 'failed' ? 'warning' : 'neutral'}>
                      {refresh.data.outcome === 'refreshed'
                        ? `New data is live (read in ${refresh.data.durationMs} ms).`
                        : refresh.data.outcome === 'unchanged'
                          ? 'The warehouse has not changed since it was last read.'
                          : `Refresh failed; the previous data stays in service. ${refresh.data.error ?? ''}`}
                    </Note>
                  </div>
                )}
                {s.warehouse.lastRefreshError && !refresh.data && (
                  <div className="mt-4">
                    <Note tone="warning">
                      The last refresh failed, so figures are as of{' '}
                      {fmtDateTime(s.warehouse.builtAt)}. {s.warehouse.lastRefreshError}
                    </Note>
                  </div>
                )}
              </>
            )}
          </QueryBoundary>
        </Card>
      </div>

      <Card
        title="Live telemetry"
        subtitle={`Topic "telemetry" on the ${state.transport === 'sse' ? 'SSE' : 'WebSocket'} stream · every observation as it is ingested`}
        flush
      >
        {telemetry.length === 0 ? (
          <Empty title="Waiting for telemetry" hint="Start the simulator or inject an incident." />
        ) : (
          <ScrollArea label="Live telemetry" className="max-h-[640px] overflow-y-auto">
            <TableShell>
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className={thNum}>Event</th>
                  <th className={th}>Report</th>
                  <th className={thNum}>Load time</th>
                  <th className={th}>Refresh</th>
                  <th className={th}>Source</th>
                  <th className={th}>Breach</th>
                </tr>
              </thead>
              <tbody>
                {telemetry.map((t) => (
                  <tr key={t.id} className="flash">
                    <td className={`${tdNum} text-ink-3`}>#{t.id}</td>
                    <td className={`${td} font-mono text-[12.5px]`}>{t.reportId}</td>
                    <td className={tdNum}>{fmtSec(t.loadTimeSec)}</td>
                    <td className={td}>
                      {t.refreshStatus ? (
                        <RefreshBadge status={t.refreshStatus as 'SUCCESS'} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={`${td} text-ink-2`}>{t.source}</td>
                    <td className={td}>
                      {t.breach ? (
                        <Badge tone="critical">breach</Badge>
                      ) : (
                        <span className="text-ink-3">ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </ScrollArea>
        )}
      </Card>
    </div>
  );
}

function RuleEditor({ rule }: { rule: AlertRule }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(rule);
  useEffect(() => setDraft(rule), [rule]);
  const save = useMutation({
    mutationFn: () =>
      api.put<AlertRule>(`/alert-rules/${rule.id}`, {
        enabled: draft.enabled,
        resolveAfter: draft.resolveAfter,
        ...(rule.id === 'latency'
          ? {
              warningThreshold: draft.warningThreshold,
              highThreshold: draft.highThreshold,
              criticalThreshold: draft.criticalThreshold,
            }
          : {}),
        ...(rule.id === 'refresh_failure' ? { escalateAfter: draft.escalateAfter } : {}),
        ...(rule.id === 'telemetry_stale'
          ? { warningThreshold: draft.warningThreshold, highThreshold: draft.highThreshold }
          : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(rule);
  const field = (
    label: string,
    key:
      | 'warningThreshold'
      | 'highThreshold'
      | 'criticalThreshold'
      | 'escalateAfter'
      | 'resolveAfter',
    unit: string,
  ) => (
    <label className="block text-[12.5px] text-ink-2">
      {label}
      <span className="mt-1 flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          value={draft[key] ?? ''}
          onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
          className={`${inputClass} tnum w-20`}
        />
        <span className="text-[12px] text-ink-3">{unit}</span>
      </span>
    </label>
  );
  return (
    <div className="border-t border-line px-5 py-4 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{rule.name}</span>
            {rule.inBrief ? <Badge tone="accent">Brief</Badge> : <Badge>Added</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-2">{rule.description}</p>
        </div>
        <label className="inline-flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Enabled
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        {rule.id === 'latency' && field('Warning above', 'warningThreshold', 's')}
        {rule.id === 'latency' && field('High above', 'highThreshold', 's')}
        {rule.id === 'latency' && field('Critical above', 'criticalThreshold', 's')}
        {rule.id === 'refresh_failure' && field('Critical after', 'escalateAfter', 'in a row')}
        {rule.id === 'telemetry_stale' && field('Warning after', 'warningThreshold', 'min silent')}
        {rule.id === 'telemetry_stale' && field('High after', 'highThreshold', 'min silent')}
        {field('Clear after', 'resolveAfter', 'healthy')}
        <Button
          variant="primary"
          size="md"
          busy={save.isPending}
          disabled={!dirty}
          onClick={() => save.mutate()}
        >
          <Check size={14} /> Save
        </Button>
        <span className="text-[12px] text-ink-3">
          changed {fmtAgo(rule.updatedAt)} by {rule.updatedBy}
        </span>
      </div>
      {save.isError && <p className="mt-2 text-[13px] text-critical-ink">{save.error.message}</p>}
    </div>
  );
}

function RulesTab() {
  const rules = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api.get<{ items: AlertRule[] }>('/alert-rules'),
  });
  return (
    <Card
      title="Alert rules"
      subtitle="Changes are audited and apply from the next observation"
      flush
    >
      <QueryBoundary query={rules}>
        {({ items }) => (
          <div>
            {items.map((rule) => (
              <RuleEditor key={rule.id} rule={rule} />
            ))}
          </div>
        )}
      </QueryBoundary>
    </Card>
  );
}

function AccessTab() {
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () =>
      api.get<{ items: (User & { reportsOwned: number; lastLoginAt: string | null })[] }>('/users'),
  });
  return (
    <div className="space-y-5">
      <Card
        title="Permission matrix"
        subtitle="Defined once in packages/contracts; enforced by the API, the real-time gateway and this navigation"
        flush
      >
        <TableShell>
          <thead>
            <tr>
              <th className={th}>Permission</th>
              {ROLES.map((role) => (
                <th key={role} className={`${th} text-center`}>
                  {ROLE_DEFINITIONS[role].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${td} text-ink-2`}>Data scope</td>
              {ROLES.map((role) => (
                <td key={role} className={`${td} text-center`}>
                  <Badge tone={ROLE_DEFINITIONS[role].scope === 'own' ? 'warning' : 'neutral'}>
                    {ROLE_DEFINITIONS[role].scope === 'own' ? 'own reports' : 'all reports'}
                  </Badge>
                </td>
              ))}
            </tr>
            {PERMISSIONS.map((permission) => (
              <tr key={permission}>
                <td className={`${td} font-mono text-[12.5px]`}>{permission}</td>
                {ROLES.map((role) => (
                  <td key={role} className={`${td} text-center`}>
                    {ROLE_DEFINITIONS[role].permissions.includes(permission) ? (
                      <Check size={15} className="inline text-good-ink" aria-label="allowed" />
                    ) : (
                      <span className="text-ink-3">
                        <span aria-hidden="true">·</span>
                        <span className="sr-only">not allowed</span>
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </TableShell>
      </Card>
      <Card title="Accounts" flush>
        <QueryBoundary query={users}>
          {({ items }) => (
            <TableShell>
              <thead>
                <tr>
                  <th className={th}>User</th>
                  <th className={th}>Role</th>
                  <th className={thNum}>Reports owned</th>
                  <th className={th}>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => (
                  <tr key={user.id}>
                    <td className={td}>
                      <div className="font-medium text-ink">{user.name}</div>
                      <div className="text-[12.5px] text-ink-2">{user.email}</div>
                    </td>
                    <td className={td}>{user.roleLabel}</td>
                    <td className={tdNum}>{user.role === 'owner' ? user.reportsOwned : '—'}</td>
                    <td className={`${td} text-ink-2`}>
                      {user.lastLoginAt ? fmtAgo(user.lastLoginAt) : 'never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </QueryBoundary>
      </Card>
    </div>
  );
}

function AuditTab() {
  const [page, setPage] = useState(1);
  const audit = useQuery({
    queryKey: ['audit', page],
    queryFn: () =>
      api.get<{ items: AuditEntry[]; total: number; page: number; pageSize: number }>(
        `/audit-log${query({ page, pageSize: 20 })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  return (
    <Card
      title="Audit log"
      subtitle="Every state-changing action: who, what, on which object, when"
      flush
    >
      <QueryBoundary query={audit}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty title="Nothing recorded yet" />
          ) : (
            <>
              <TableShell>
                <thead>
                  <tr>
                    <th className={th}>When</th>
                    <th className={th}>Actor</th>
                    <th className={th}>Action</th>
                    <th className={th}>Target</th>
                    <th className={th}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((entry) => (
                    <tr key={entry.id}>
                      <td className={`${td} tnum whitespace-nowrap text-ink-2`}>
                        {fmtDateTime(entry.at)}
                      </td>
                      <td className={td}>
                        {entry.actor}{' '}
                        <span className="text-[12px] text-ink-3">({entry.actorRole})</span>
                      </td>
                      <td className={`${td} font-mono text-[12.5px]`}>{entry.action}</td>
                      <td className={`${td} font-mono text-[12.5px]`}>
                        {entry.targetType}:
                        {entry.targetId.length > 14
                          ? `${entry.targetId.slice(0, 8)}…`
                          : entry.targetId}
                      </td>
                      <td
                        className={`${td} max-w-md truncate font-mono text-[12px] text-ink-2`}
                        title={JSON.stringify(entry.detail)}
                      >
                        {JSON.stringify(entry.detail)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
              <Pager
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPage={setPage}
              />
            </>
          )
        }
      </QueryBoundary>
    </Card>
  );
}

const NOTIFICATION_TONE = {
  sent: 'good',
  pending: 'warning',
  failed: 'critical',
  skipped: 'neutral',
} as const;

function NotificationsTab() {
  const [page, setPage] = useState(1);
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/system/status'),
  });
  const notifications = useQuery({
    queryKey: ['notifications', page],
    queryFn: () =>
      api.get<{ items: Notification[]; total: number; page: number; pageSize: number }>(
        `/notifications${query({ page, pageSize: 20 })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  const policy = status.data?.notifications;
  return (
    <div className="space-y-5">
      {policy && (
        <Note tone={policy.channel === 'none' ? 'warning' : 'neutral'}>
          {policy.channel === 'none' ? (
            <>
              <span className="font-medium">No delivery channel is configured.</span> Notifications
              are decided and recorded below but not sent. Set{' '}
              <span className="font-mono text-[12.5px]">NOTIFY_WEBHOOK_URL</span> to a Slack, Teams
              or other incoming-webhook address to deliver them.
            </>
          ) : (
            <>
              Delivering by webhook. {policy.sent.toLocaleString()} sent, {policy.pending} waiting,{' '}
              {policy.failed} failed.
            </>
          )}{' '}
          Alerts notify from <span className="font-medium">{policy.minSeverity}</span> severity up,
          go to the report's owner or to the platform admins when it has none, and escalate to the
          admins if nobody acknowledges within {policy.escalateAfterMin} minutes.
        </Note>
      )}
      <Card
        title="Notifications"
        subtitle="One per alert opening, escalation and resolution; never repeated"
        flush
      >
        <QueryBoundary query={notifications}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty
                title="No notifications yet"
                hint="Inject a refresh failure from Live & incidents to see one."
              />
            ) : (
              <>
                <ScrollArea label="Notifications" className="overflow-x-auto">
                  <TableShell>
                    <thead>
                      <tr>
                        <th className={th}>When</th>
                        <th className={th}>What</th>
                        <th className={th}>To</th>
                        <th className={th}>Delivery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((n) => (
                        <tr key={n.id}>
                          <td className={`${td} tnum whitespace-nowrap text-ink-2`}>
                            {fmtDateTime(n.createdAt)}
                          </td>
                          <td className={td}>
                            <div className="font-medium text-ink">{n.title}</div>
                            <div className="max-w-xl truncate text-[12.5px] text-ink-2">
                              {n.body.split('\n')[0]}
                            </div>
                          </td>
                          <td className={`${td} whitespace-nowrap text-ink-2`}>{n.recipient}</td>
                          <td className={`${td} whitespace-nowrap`}>
                            <Badge tone={NOTIFICATION_TONE[n.status]}>{n.status}</Badge>
                            {n.lastError && (
                              <div className="mt-0.5 text-[12px] text-ink-3" title={n.lastError}>
                                attempt {n.attempts}: {n.lastError.slice(0, 40)}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                </ScrollArea>
                <Pager
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPage={setPage}
                />
              </>
            )
          }
        </QueryBoundary>
      </Card>
    </div>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('live');
  return (
    <>
      <PageHeader
        title="Admin"
        description="Simulate incidents, tune alert rules, see who was notified, review who can do what, and read the audit trail."
        actions={
          <Segmented<Tab>
            label="Admin section"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'live', label: 'Live & incidents' },
              { value: 'rules', label: 'Alert rules' },
              { value: 'notifications', label: 'Notifications' },
              { value: 'access', label: 'Access' },
              { value: 'audit', label: 'Audit log' },
            ]}
          />
        }
      />
      <div className={cx(tab !== 'live' && 'max-w-5xl')}>
        {tab === 'live' && <LiveTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'notifications' && <NotificationsTab />}
        {tab === 'access' && <AccessTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </>
  );
}
