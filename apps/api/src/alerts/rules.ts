import { type AlertRule, SEVERITY_RANK, type Severity } from '@picc/contracts';
import type { Evaluation, Observation } from './types.js';

type RuleDefaults = Omit<AlertRule, 'updatedAt' | 'updatedBy'>;

/** Shipped defaults. Admins can change thresholds at runtime; these are only the seed. */
export const DEFAULT_ALERT_RULES: readonly RuleDefaults[] = [
  {
    id: 'latency',
    name: 'Dashboard load latency',
    description:
      'Fires when a report takes longer than the warning threshold to load. The brief sets that threshold at 15 seconds; the higher tiers exist because three quarters of observations in the dataset exceed it.',
    enabled: true,
    inBrief: true,
    warningThreshold: 15,
    highThreshold: 30,
    criticalThreshold: 45,
    escalateAfter: null,
    resolveAfter: 2,
  },
  {
    id: 'refresh_failure',
    name: 'Automated refresh failed',
    description:
      'Fires when a scheduled refresh ends FAILED or TIMED_OUT. Becomes critical after several consecutive failures, because data that has not refreshed for that long is being read as if it were current.',
    enabled: true,
    inBrief: true,
    warningThreshold: null,
    highThreshold: null,
    criticalThreshold: null,
    escalateAfter: 3,
    resolveAfter: 1,
  },
  {
    id: 'refresh_unknown',
    name: 'Refresh outcome not reported',
    description:
      'The portal reported UNKNOWN for a refresh. Not a failure, but a monitoring gap: nobody can say whether the data is fresh.',
    enabled: true,
    inBrief: false,
    warningThreshold: null,
    highThreshold: null,
    criticalThreshold: null,
    escalateAfter: null,
    resolveAfter: 1,
  },
  {
    id: 'invalid_telemetry',
    name: 'Invalid telemetry value',
    description:
      'A metric arrived with an impossible value, such as negative Snowflake credits. The value is kept out of cost figures and the emitter needs fixing.',
    enabled: true,
    inBrief: false,
    warningThreshold: null,
    highThreshold: null,
    criticalThreshold: null,
    escalateAfter: null,
    resolveAfter: 1,
  },
  {
    id: 'telemetry_stale',
    name: 'No telemetry received',
    description:
      'A report has sent no reading for longer than the warning threshold, in minutes, while the rest of the feed is arriving. Silence is not health: without this rule a report whose emitter has stopped would look fine for ever. Clears on the next reading.',
    enabled: true,
    inBrief: false,
    warningThreshold: 30,
    highThreshold: 120,
    criticalThreshold: null,
    escalateAfter: null,
    resolveAfter: 1,
  },
];

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * Decides what one observation means for one rule. Pure: no clock, no storage.
 * Returns null when the observation carries nothing the rule can judge, which is different
 * from "healthy" — an UNKNOWN refresh must neither open nor resolve a refresh-failure alert.
 */
export function evaluate(rule: AlertRule, obs: Observation): Evaluation | null {
  switch (rule.id) {
    case 'latency': {
      if (obs.loadTimeSec === undefined || rule.warningThreshold === null) return null;
      const value = obs.loadTimeSec;
      const warning = rule.warningThreshold;
      // "Exceeds" is strict: exactly 15.0 s is not a breach.
      const breach = value > warning;
      let severity: Severity = 'warning';
      let threshold = warning;
      if (rule.criticalThreshold !== null && value > rule.criticalThreshold) {
        severity = 'critical';
        threshold = rule.criticalThreshold;
      } else if (rule.highThreshold !== null && value > rule.highThreshold) {
        severity = 'high';
        threshold = rule.highThreshold;
      }
      return {
        breach,
        severity,
        value,
        threshold: breach ? threshold : warning,
        unit: 'seconds',
        message: breach
          ? `Load time ${fmt(value)} s exceeds the ${fmt(threshold)} s ${severity} threshold`
          : `Load time ${fmt(value)} s is within the ${fmt(warning)} s threshold`,
      };
    }
    case 'refresh_failure': {
      if (obs.refreshStatus === undefined || obs.refreshStatus === 'UNKNOWN') return null;
      const breach = obs.refreshStatus === 'FAILED' || obs.refreshStatus === 'TIMED_OUT';
      const streak = breach ? Math.max(1, obs.refreshFailureStreak ?? 1) : 0;
      const escalated = rule.escalateAfter !== null && streak >= rule.escalateAfter;
      const what = obs.refreshStatus === 'TIMED_OUT' ? 'timed out' : 'failed';
      return {
        breach,
        severity: escalated ? 'critical' : 'high',
        value: streak,
        threshold: rule.escalateAfter,
        unit: 'consecutive failures',
        message: breach
          ? `Automated refresh ${what}${streak > 1 ? ` (${streak} in a row)` : ''}`
          : 'Automated refresh succeeded',
      };
    }
    case 'refresh_unknown': {
      if (obs.refreshStatus === undefined) return null;
      const breach = obs.refreshStatus === 'UNKNOWN';
      return {
        breach,
        severity: 'info',
        value: null,
        threshold: null,
        unit: null,
        message: breach
          ? 'Refresh outcome was not reported (telemetry gap)'
          : 'Refresh outcome reported',
      };
    }
    case 'invalid_telemetry': {
      if (obs.creditsConsumed === undefined) return null;
      const breach = obs.creditsConsumed < 0;
      return {
        breach,
        severity: 'warning',
        value: obs.creditsConsumed,
        threshold: 0,
        unit: 'credits',
        message: breach
          ? `Negative Snowflake credits reported (${obs.creditsConsumed}); excluded from cost`
          : 'Reported credits are valid',
      };
    }
    case 'telemetry_stale': {
      if (obs.silentForMin === undefined || rule.warningThreshold === null) return null;
      const minutes = Math.floor(obs.silentForMin);
      const breach = obs.silentForMin > rule.warningThreshold;
      const high = rule.highThreshold !== null && obs.silentForMin > rule.highThreshold;
      return {
        breach,
        severity: high ? 'high' : 'warning',
        value: minutes,
        threshold: high ? rule.highThreshold : rule.warningThreshold,
        unit: 'minutes',
        message: breach
          ? `No telemetry received for ${minutes} minute${minutes === 1 ? '' : 's'}`
          : 'Telemetry is arriving again',
      };
    }
    default:
      return null;
  }
}

export const isMoreSevere = (a: Severity, b: Severity): boolean =>
  SEVERITY_RANK[a] > SEVERITY_RANK[b];
