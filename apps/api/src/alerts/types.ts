import type {
  AlertRuleId,
  AlertSource,
  AlertStatus,
  RefreshStatus,
  Severity,
} from '@picc/contracts';

/** An alert as stored. The API shape (`Alert` in the contracts) adds names and routing. */
export interface AlertRecord {
  id: string;
  fingerprint: string;
  ruleId: AlertRuleId;
  reportId: string;
  severity: Severity;
  status: AlertStatus;
  message: string;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  occurrences: number;
  reopenCount: number;
  /** Reopens since the alert last fired steadily. Drives the flapping label; decays. */
  flapCount: number;
  /** Consecutive breaching observations. */
  breachStreak: number;
  /** Consecutive healthy observations while the alert is open. */
  okStreak: number;
  /** Healthy observations since the alert resolved; a breach soon after reopens it. */
  obsSinceResolved: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  ackNote: string | null;
  snoozedUntil: string | null;
  source: AlertSource;
  seq: number;
}

/** One telemetry observation of one report, already validated. */
export interface Observation {
  reportId: string;
  observedAt: string;
  loadTimeSec?: number;
  refreshStatus?: RefreshStatus;
  /** Consecutive failed refreshes including this one. Maintained by the telemetry service. */
  refreshFailureStreak?: number;
  creditsConsumed?: number;
  source: AlertSource;
}

export interface Evaluation {
  breach: boolean;
  severity: Severity;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  message: string;
}

export type AlertChange =
  | 'occurrence'
  | 'escalated'
  | 'deescalated'
  | 'acknowledged'
  | 'snoozed'
  | 'rerouted'
  | 'reopened'
  | 'recovering';

export type EngineEvent =
  | { type: 'fired'; alert: AlertRecord }
  | { type: 'updated'; change: AlertChange; alert: AlertRecord }
  | { type: 'resolved'; alert: AlertRecord };
