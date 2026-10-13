import type { Alert, AnyServerEvent, RealtimeTicket, Topic } from '@picc/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { RealtimeClient, type RealtimeState } from '../lib/realtime';

export interface Toast {
  id: number;
  tone: 'critical' | 'serious' | 'warning' | 'good' | 'info';
  title: string;
  body: string;
  href?: string;
}

export interface ActivityItem {
  key: string;
  at: string;
  kind: 'fired' | 'resolved' | 'escalated' | 'acknowledged' | 'reopened' | 'owner' | 'notice';
  title: string;
  detail: string;
  reportId: string | null;
  severity: Alert['severity'] | null;
}

export interface TelemetryTick {
  id: number;
  reportId: string;
  observedAt: string;
  loadTimeSec: number | null;
  refreshStatus: string | null;
  breach: boolean;
  source: string;
}

interface RealtimeValue {
  state: RealtimeState;
  activity: ActivityItem[];
  telemetry: TelemetryTick[];
  toasts: Toast[];
  /** Alert ids touched by a live event in the last few seconds, for row highlighting. */
  recentAlertIds: ReadonlySet<string>;
  dismissToast: (id: number) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  subscribe: (topic: Topic) => void;
  unsubscribe: (topic: Topic) => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);
const IDLE: RealtimeState = {
  status: 'idle',
  transport: 'websocket',
  latencyMs: null,
  lastEventId: 0,
  reconnects: 0,
};
const toneOf = (severity: Alert['severity']): Toast['tone'] =>
  severity === 'critical'
    ? 'critical'
    : severity === 'high'
      ? 'serious'
      : severity === 'warning'
        ? 'warning'
        : 'info';

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user, can } = useAuth();
  const queryClient = useQueryClient();
  const [state, setState] = useState<RealtimeState>(IDLE);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryTick[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [recentAlertIds, setRecentAlertIds] = useState<ReadonlySet<string>>(new Set());
  const clientRef = useRef<RealtimeClient | null>(null);
  const toastSeq = useRef(0);
  const pending = useRef(new Set<string>());
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback(
    (id: number) => setToasts((list) => list.filter((t) => t.id !== id)),
    [],
  );
  const pushToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = ++toastSeq.current;
      setToasts((list) => [...list.slice(-3), { ...toast, id }]);
      setTimeout(() => dismissToast(id), 7000);
    },
    [dismissToast],
  );

  /** Live events arrive in bursts; refetch each affected query once per burst, not per event. */
  const invalidate = useCallback(
    (...keys: string[]) => {
      for (const key of keys) pending.current.add(key);
      flush.current ??= setTimeout(() => {
        flush.current = null;
        const batch = [...pending.current];
        pending.current.clear();
        for (const key of batch) void queryClient.invalidateQueries({ queryKey: [key] });
      }, 400);
    },
    [queryClient],
  );

  const markRecent = useCallback((alertId: string) => {
    setRecentAlertIds((ids) => new Set(ids).add(alertId));
    setTimeout(
      () =>
        setRecentAlertIds((ids) => {
          const next = new Set(ids);
          next.delete(alertId);
          return next;
        }),
      2600,
    );
  }, []);

  const onEvent = useCallback(
    (event: AnyServerEvent) => {
      const log = (item: Omit<ActivityItem, 'key' | 'at'>) =>
        setActivity((list) =>
          [{ ...item, key: `${event.id}-${event.type}`, at: event.ts }, ...list].slice(0, 60),
        );

      switch (event.type) {
        case 'alert.fired': {
          const { alert } = event.data;
          markRecent(alert.id);
          invalidate('alerts', 'overview', 'reports', 'report', 'orphans');
          log({
            kind: 'fired',
            title: `${alert.reportName} · ${alert.ruleName}`,
            detail: alert.message,
            reportId: alert.reportId,
            severity: alert.severity,
          });
          if (!alert.snoozedUntil) {
            pushToast({
              tone: toneOf(alert.severity),
              title: `${alert.severity === 'critical' ? 'Critical' : 'New alert'} · ${alert.reportName}`,
              body: `${alert.message}${alert.routing.escalated ? ' · no owner, escalated to admins' : ''}`,
              href: `/reports/${alert.reportId}`,
            });
          }
          break;
        }
        case 'alert.updated': {
          const { alert, change } = event.data;
          markRecent(alert.id);
          invalidate('alerts', 'overview', 'reports', 'report');
          // A repeat breach updates the row quietly. Only a real change earns a line or a toast.
          if (change === 'escalated') {
            log({
              kind: 'escalated',
              title: `${alert.reportName} escalated to ${alert.severity}`,
              detail: alert.message,
              reportId: alert.reportId,
              severity: alert.severity,
            });
            if (!alert.snoozedUntil && alert.severity === 'critical') {
              pushToast({
                tone: 'critical',
                title: `Escalated · ${alert.reportName}`,
                body: alert.message,
                href: `/reports/${alert.reportId}`,
              });
            }
          } else if (change === 'acknowledged') {
            log({
              kind: 'acknowledged',
              title: `${alert.reportName} acknowledged`,
              detail: `by ${alert.acknowledgedBy ?? 'someone'}`,
              reportId: alert.reportId,
              severity: alert.severity,
            });
          } else if (change === 'reopened') {
            log({
              kind: 'reopened',
              title: `${alert.reportName} reopened${alert.isFlapping ? ' (flapping)' : ''}`,
              detail: alert.message,
              reportId: alert.reportId,
              severity: alert.severity,
            });
            if (!alert.isFlapping && !alert.snoozedUntil) {
              pushToast({
                tone: toneOf(alert.severity),
                title: `Reopened · ${alert.reportName}`,
                body: alert.message,
                href: `/reports/${alert.reportId}`,
              });
            }
          }
          break;
        }
        case 'alert.resolved': {
          const { alert } = event.data;
          markRecent(alert.id);
          invalidate('alerts', 'overview', 'reports', 'report', 'orphans');
          log({
            kind: 'resolved',
            title: `${alert.reportName} recovered`,
            detail: alert.ruleName,
            reportId: alert.reportId,
            severity: null,
          });
          break;
        }
        case 'report.owner_changed':
          invalidate('reports', 'report', 'orphans', 'overview', 'alerts', 'costs');
          log({
            kind: 'owner',
            title: `${event.data.reportId} assigned an owner`,
            detail: `${event.data.ownerEmail ?? 'unowned'} · by ${event.data.assignedBy}`,
            reportId: event.data.reportId,
            severity: null,
          });
          break;
        case 'telemetry.observed':
          setTelemetry((list) => [{ id: event.id, ...event.data }, ...list].slice(0, 40));
          break;
        case 'system.notice':
          invalidate('alert-rules', 'simulator', 'overview');
          log({
            kind: 'notice',
            title: 'System notice',
            detail: event.data.message,
            reportId: null,
            severity: null,
          });
          pushToast({ tone: 'info', title: 'System notice', body: event.data.message });
          break;
        case 'replay.gap':
          // Too much was missed to replay: every cached list is suspect.
          void queryClient.invalidateQueries();
          break;
        case 'connection.ready':
          if (event.data.replayed > 0)
            invalidate('alerts', 'overview', 'reports', 'report', 'orphans');
          break;
      }
    },
    [invalidate, markRecent, pushToast, queryClient],
  );

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const allowed = Boolean(user) && can('alerts:read');

  // biome-ignore lint/correctness/useExhaustiveDependencies: user id is listed on purpose, to reconnect as the new principal
  useEffect(() => {
    if (!allowed) {
      setState(IDLE);
      return;
    }
    const client = new RealtimeClient({
      getTicket: () => api.post<RealtimeTicket>('/realtime/ticket'),
      onEvent: (event) => onEventRef.current(event),
      onState: setState,
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
      setActivity([]);
      setTelemetry([]);
      setToasts([]);
    };
    // Reconnect as a different principal when the signed-in user changes.
  }, [allowed, user?.id]);

  const value = useMemo<RealtimeValue>(
    () => ({
      state,
      activity,
      telemetry,
      toasts,
      recentAlertIds,
      dismissToast,
      pushToast,
      subscribe: (topic) => clientRef.current?.subscribe(topic),
      unsubscribe: (topic) => clientRef.current?.unsubscribe(topic),
    }),
    [state, activity, telemetry, toasts, recentAlertIds, dismissToast, pushToast],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside RealtimeProvider');
  return value;
}
