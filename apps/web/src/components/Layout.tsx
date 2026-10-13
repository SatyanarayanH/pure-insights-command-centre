import type { AlertStats, OrphanQueue, Permission } from '@picc/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  BookOpen,
  Coins,
  FileText,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Moon,
  Settings,
  Sun,
  UserX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { type Toast, useRealtime } from '../realtime/RealtimeProvider';
import { cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission: Permission;
  badge?: 'alerts' | 'orphans';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: <LayoutDashboard size={16} />, permission: 'reports:read' },
  { to: '/reports', label: 'Reports', icon: <FileText size={16} />, permission: 'reports:read' },
  {
    to: '/orphans',
    label: 'Orphaned reports',
    icon: <UserX size={16} />,
    permission: 'orphans:read',
    badge: 'orphans',
  },
  {
    to: '/alerts',
    label: 'Alerts',
    icon: <Bell size={16} />,
    permission: 'alerts:read',
    badge: 'alerts',
  },
  { to: '/costs', label: 'Cost', icon: <Coins size={16} />, permission: 'costs:read' },
  {
    to: '/data-quality',
    label: 'Data quality',
    icon: <ListChecks size={16} />,
    permission: 'dq:read',
  },
  { to: '/admin', label: 'Admin', icon: <Settings size={16} />, permission: 'users:read' },
];

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('picc-theme') as Theme | null) ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('picc-theme', theme);
    } catch {
      /* private mode: the choice just does not persist */
    }
  }, [theme]);
  const systemDark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && systemDark);
  return [isDark ? 'dark' : 'light', () => setTheme(isDark ? 'light' : 'dark')];
}

function ConnectionIndicator() {
  const { state } = useRealtime();
  const open = state.status === 'open';
  const label =
    state.status === 'open'
      ? `Live${state.transport === 'sse' ? ' (SSE)' : ''}`
      : state.status === 'reconnecting'
        ? 'Reconnecting'
        : state.status === 'connecting'
          ? 'Connecting'
          : 'Offline';
  return (
    <div
      className="flex items-center gap-2 text-[12.5px] text-ink-2"
      title={`Transport: ${state.transport} · last event #${state.lastEventId}${state.latencyMs !== null ? ` · round trip ${state.latencyMs} ms` : ''} · reconnects: ${state.reconnects}`}
      role="status"
    >
      {open ? (
        <Wifi size={14} className="text-good-ink" />
      ) : (
        <WifiOff size={14} className="text-warning-ink" />
      )}
      <span className={cx('h-1.5 w-1.5 rounded-full', open ? 'pulse-dot bg-good' : 'bg-warning')} />
      {label}
      {open && state.latencyMs !== null && (
        <span className="tnum text-ink-3">{state.latencyMs} ms</span>
      )}
    </div>
  );
}

const TOAST_BAR: Record<Toast['tone'], string> = {
  critical: 'bg-critical',
  serious: 'bg-serious',
  warning: 'bg-warning',
  good: 'bg-good',
  info: 'bg-ink-3',
};

function Toasts() {
  const { toasts, dismissToast } = useRealtime();
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast-in pointer-events-auto flex overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className={cx('w-1 shrink-0', TOAST_BAR[toast.tone])} />
          <div className="min-w-0 flex-1 px-3 py-2.5">
            <div className="text-[13.5px] font-semibold text-ink">{toast.title}</div>
            <div className="mt-0.5 text-[13px] text-ink-2">{toast.body}</div>
            {toast.href && (
              <Link
                to={toast.href}
                onClick={() => dismissToast(toast.id)}
                className="mt-1 inline-block text-[12.5px] font-medium text-accent-ink hover:underline"
              >
                Open report
              </Link>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
            className="self-start p-2 text-ink-3 hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Layout() {
  const { user, can, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const stats = useQuery({
    queryKey: ['alerts', 'stats'],
    queryFn: () => api.get<AlertStats>('/alerts/stats'),
    enabled: can('alerts:read'),
  });
  const orphans = useQuery({
    queryKey: ['orphans'],
    queryFn: () => api.get<OrphanQueue>('/orphans'),
    enabled: can('orphans:read'),
  });
  if (!user) return null;

  const badgeFor = (item: NavItem): number | null =>
    item.badge === 'alerts'
      ? (stats.data?.firing ?? null)
      : item.badge === 'orphans'
        ? (orphans.data?.total ?? null)
        : null;

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-surface max-md:hidden">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div className="leading-tight">
            <div className="text-[14px] font-semibold text-ink">Pure Insights</div>
            <div className="text-[12px] text-ink-2">Command Centre</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label="Main">
          {NAV.filter((item) => can(item.permission)).map((item) => {
            const badge = badgeFor(item);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors',
                    isActive
                      ? 'bg-surface-2 text-ink'
                      : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                  )
                }
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {badge !== null && badge > 0 && (
                  <span
                    className={cx(
                      'tnum rounded-md px-1.5 text-[11.5px] font-semibold',
                      item.badge === 'alerts'
                        ? 'bg-critical-wash text-critical-ink'
                        : 'bg-serious-wash text-serious-ink',
                    )}
                  >
                    {badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="space-y-3 border-t border-line px-5 py-4">
          <ConnectionIndicator />
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-[12.5px] text-ink-2 hover:text-ink"
          >
            <BookOpen size={14} /> API reference
          </a>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:gap-4 sm:px-6">
          <nav className="flex min-w-0 gap-0.5 overflow-x-auto md:hidden" aria-label="Main">
            {NAV.filter((item) => can(item.permission)).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                title={item.label}
                className={({ isActive }) =>
                  cx('rounded-md p-2', isActive ? 'bg-surface-2 text-ink' : 'text-ink-2')
                }
              >
                {item.icon}
              </NavLink>
            ))}
          </nav>
          <div className="text-[13px] text-ink-2 max-md:hidden">
            {user.scope === 'own'
              ? 'Showing only the reports you own'
              : 'Showing all reports on the platform'}
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-3">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle colour theme"
              className="rounded-md p-2 text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <div className="text-right leading-tight max-sm:hidden">
              <div className="text-[13px] font-medium text-ink">{user.name}</div>
              <div className="text-[12px] text-ink-2">{user.roleLabel}</div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              title="Sign out"
              aria-label="Sign out"
              className="rounded-md p-2 text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] min-w-0 flex-1 px-3 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </main>
      </div>
      <Toasts />
    </div>
  );
}
