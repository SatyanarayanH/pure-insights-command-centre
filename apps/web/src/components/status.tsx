import type {
  AlertStatus,
  EfficiencyQuadrant,
  LatencySeverity,
  RefreshStatus,
  Severity,
} from '@picc/contracts';
import {
  BellOff,
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Flame,
  Ghost,
  Info,
  Repeat,
  Timer,
  TriangleAlert,
  UserX,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { fmtSec } from '../lib/format';
import { Badge, type Tone } from './ui';

// Status is never colour alone: every badge pairs its colour with an icon and a word.

const SEVERITY: Record<Severity, { tone: Tone | 'info'; label: string; icon: ReactNode }> = {
  critical: { tone: 'critical', label: 'Critical', icon: <Flame size={12} /> },
  high: { tone: 'serious', label: 'High', icon: <TriangleAlert size={12} /> },
  warning: { tone: 'warning', label: 'Warning', icon: <CircleAlert size={12} /> },
  info: { tone: 'info', label: 'Info', icon: <Info size={12} /> },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

const REFRESH: Record<RefreshStatus, { tone: Tone | 'info'; label: string; icon: ReactNode }> = {
  SUCCESS: { tone: 'good', label: 'Success', icon: <CircleCheck size={12} /> },
  FAILED: { tone: 'critical', label: 'Failed', icon: <CircleX size={12} /> },
  TIMED_OUT: { tone: 'serious', label: 'Timed out', icon: <Timer size={12} /> },
  UNKNOWN: { tone: 'info', label: 'Unknown', icon: <CircleHelp size={12} /> },
};

export function RefreshBadge({ status, streak }: { status: RefreshStatus; streak?: number }) {
  const s = REFRESH[status];
  return (
    <Badge
      tone={s.tone}
      icon={s.icon}
      title={
        status === 'UNKNOWN' ? 'The portal reported no outcome for the last refresh' : undefined
      }
    >
      {s.label}
      {streak !== undefined && streak > 1 && <span className="tnum">×{streak}</span>}
    </Badge>
  );
}

const LATENCY_TONE: Record<LatencySeverity, Tone | 'info'> = {
  OK: 'good',
  WARNING: 'warning',
  HIGH: 'serious',
  CRITICAL: 'critical',
};
const LATENCY_LABEL: Record<LatencySeverity, string> = {
  OK: 'OK',
  WARNING: 'Slow',
  HIGH: 'Very slow',
  CRITICAL: 'Critical',
};

export function LatencyBadge({
  seconds,
  severity,
}: {
  seconds: number | null;
  severity: LatencySeverity;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tnum w-12 text-right">{fmtSec(seconds)}</span>
      <Badge tone={LATENCY_TONE[severity]}>{LATENCY_LABEL[severity]}</Badge>
    </span>
  );
}

export function AlertStatusBadge({
  status,
  flapping,
  snoozed,
}: {
  status: AlertStatus;
  flapping?: boolean;
  snoozed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {status === 'firing' && (
        <Badge
          tone="critical"
          icon={<span className="pulse-dot h-1.5 w-1.5 rounded-full bg-critical" />}
        >
          Firing
        </Badge>
      )}
      {status === 'acknowledged' && (
        <Badge tone="accent" icon={<Check size={12} />}>
          Acknowledged
        </Badge>
      )}
      {status === 'resolved' && (
        <Badge tone="good" icon={<CircleCheck size={12} />}>
          Resolved
        </Badge>
      )}
      {flapping && (
        <Badge
          tone="info"
          icon={<Repeat size={12} />}
          title="This alert keeps resolving and reopening"
        >
          Flapping
        </Badge>
      )}
      {snoozed && (
        <Badge tone="info" icon={<BellOff size={12} />}>
          Snoozed
        </Badge>
      )}
    </span>
  );
}

export function OwnerCell({
  email,
  source,
}: {
  email: string | null;
  source?: 'telemetry' | 'assigned' | null;
}) {
  if (!email) {
    return (
      <Badge tone="serious" icon={<UserX size={12} />}>
        No owner
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="truncate">{email}</span>
      {source === 'assigned' && (
        <Badge tone="accent" title="Assigned in the Command Centre">
          assigned
        </Badge>
      )}
    </span>
  );
}

const QUADRANT: Record<EfficiencyQuadrant, { tone: Tone | 'info'; label: string; hint: string }> = {
  ZOMBIE: { tone: 'critical', label: 'Zombie', hint: 'Bottom-quartile usage, top-quartile cost' },
  COSTLY: { tone: 'warning', label: 'Costly', hint: 'Below-median usage, above-median cost' },
  WORKHORSE: { tone: 'neutral', label: 'Workhorse', hint: 'Above-median usage and cost' },
  EFFICIENT: { tone: 'good', label: 'Efficient', hint: 'Above-median usage, below-median cost' },
  NICHE: { tone: 'neutral', label: 'Niche', hint: 'Below-median usage and cost' },
};

export function QuadrantBadge({ quadrant }: { quadrant: EfficiencyQuadrant | null }) {
  if (!quadrant) return <span className="text-ink-3">—</span>;
  const q = QUADRANT[quadrant];
  return (
    <Badge
      tone={q.tone}
      title={q.hint}
      icon={quadrant === 'ZOMBIE' ? <Ghost size={12} /> : undefined}
    >
      {q.label}
    </Badge>
  );
}
