import {
  type Alert,
  type AlertRule,
  type AnyServerEvent,
  type LatencySeverity,
  maskEmail,
  PROTOCOL_VERSION,
  type ReportCost,
  type Topic,
} from '@picc/contracts';
import { FLAPPING_REOPEN_COUNT } from '../alerts/engine.js';
import type { AlertChange, AlertRecord } from '../alerts/types.js';
import { can, type Principal } from '../auth/principal.js';
import type { BusRecord } from '../realtime/bus.js';
import type { CostColumns } from '../warehouse/snapshot.js';
import type { OwnershipService } from './ownership.js';

/**
 * Turns stored records into what a given caller is allowed to receive.
 *
 * Field-level security lives here and only here: REST responses and real-time events pass
 * through the same functions, so a viewer cannot get an unmasked email or a cost figure from
 * the WebSocket that the REST API would have withheld.
 */
export interface PresenterContext {
  ownership: OwnershipService;
  reportName(reportId: string): string;
  rules(): readonly AlertRule[];
  now(): Date;
}

export function presentEmail(principal: Principal, email: string | null): string | null {
  if (email === null) return null;
  return can(principal, 'pii:read') ? email : maskEmail(email);
}

export function presentCost(principal: Principal, fact: CostColumns): ReportCost | null {
  if (!can(principal, 'costs:read')) return null;
  return {
    creditsAttributed: fact.credits_attributed,
    creditsFullyLoaded: fact.credits_fully_loaded,
    snowflakeCostUsd: fact.snowflake_cost_usd,
    snowflakeCostLoadedUsd: fact.snowflake_cost_loaded_usd,
    awsHostingCostUsd: fact.aws_hosting_cost_usd,
    totalCostUsd: fact.total_cost_usd,
    snowflakeCostPerViewUsd: fact.snowflake_cost_per_view_usd,
    totalCostPerViewUsd: fact.total_cost_per_view_usd,
    isCostImputed: fact.is_cost_imputed,
    isCostQuarantined: fact.is_cost_quarantined,
  };
}

/** An alert in its API shape with nothing withheld. Never sent as is: see `redactAlert`. */
export function presentAlertFull(record: AlertRecord, ctx: PresenterContext): Alert {
  const owner = ctx.ownership.ownerOf(record.reportId);
  return {
    id: record.id,
    fingerprint: record.fingerprint,
    ruleId: record.ruleId,
    ruleName: ctx.rules().find((rule) => rule.id === record.ruleId)?.name ?? record.ruleId,
    reportId: record.reportId,
    reportName: ctx.reportName(record.reportId),
    severity: record.severity,
    status: record.status,
    message: record.message,
    value: record.value,
    threshold: record.threshold,
    unit: record.unit,
    occurrences: record.occurrences,
    reopenCount: record.reopenCount,
    isFlapping: record.status !== 'resolved' && record.flapCount >= FLAPPING_REOPEN_COUNT,
    healthyStreak: record.status === 'resolved' ? 0 : record.okStreak,
    resolveAfter: ctx.rules().find((rule) => rule.id === record.ruleId)?.resolveAfter ?? 1,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    resolvedAt: record.resolvedAt,
    acknowledgedBy: record.acknowledgedBy,
    acknowledgedAt: record.acknowledgedAt,
    ackNote: record.ackNote,
    // A snooze that has run out is no longer a snooze.
    snoozedUntil:
      record.snoozedUntil && record.snoozedUntil > ctx.now().toISOString()
        ? record.snoozedUntil
        : null,
    routing: {
      kind: owner.email ? 'owner' : 'admins',
      ownerEmail: owner.email,
      // An alert on a report nobody owns would otherwise notify nobody.
      escalated: owner.email === null,
    },
    source: record.source,
  };
}

/** Field-level security for an alert: the one place its email addresses are masked. */
export function redactAlert(alert: Alert, principal: Principal): Alert {
  return {
    ...alert,
    acknowledgedBy: presentEmail(principal, alert.acknowledgedBy),
    routing: { ...alert.routing, ownerEmail: presentEmail(principal, alert.routing.ownerEmail) },
  };
}

export function presentAlert(
  record: AlertRecord,
  principal: Principal,
  ctx: PresenterContext,
): Alert {
  return redactAlert(presentAlertFull(record, ctx), principal);
}

export function latencySeverityOf(
  loadTimeSec: number | null,
  rule: AlertRule | undefined,
): LatencySeverity {
  if (loadTimeSec === null || !rule || rule.warningThreshold === null) return 'OK';
  if (rule.criticalThreshold !== null && loadTimeSec > rule.criticalThreshold) return 'CRITICAL';
  if (rule.highThreshold !== null && loadTimeSec > rule.highThreshold) return 'HIGH';
  return loadTimeSec > rule.warningThreshold ? 'WARNING' : 'OK';
}

/** What an alert event carries on the bus: the unredacted API shape, fixed at publish time. */
export interface AlertPayload {
  alert: Alert;
  change?: AlertChange;
}

export interface OwnerChangedPayload {
  reportId: string;
  ownerEmail: string | null;
  previousOwnerEmail: string | null;
  assignedBy: string;
}

/**
 * Whether a recipient may receive a bus record at all: topic subscription, then row-level
 * visibility. Everything it needs is on the record and the principal. It consults no database,
 * which is what allows a connection-only node fed from Redis to apply exactly the same rules.
 */
export function canReceive(
  record: BusRecord,
  principal: Principal,
  topics: ReadonlySet<Topic>,
): boolean {
  if (!topics.has(record.topic)) return false;
  return !(record.reportId && principal.scope !== 'all' && record.ownerEmail !== principal.email);
}

/**
 * Recipients in the same class receive byte-identical events, so the gateway serialises an
 * event once per class rather than once per connection. The class is exactly the set of things
 * `renderEvent` reads from the principal; if redaction ever depends on something new, it must
 * be added here (a test compares the two for every role).
 */
export function viewClassOf(principal: Principal): string {
  return can(principal, 'pii:read') ? 'unmasked' : 'masked';
}

/** The wire form of a bus record for a recipient who may receive it: field-level redaction. */
export function renderEvent(record: BusRecord, principal: Principal): AnyServerEvent | null {
  const envelope = { v: PROTOCOL_VERSION, id: record.id, ts: record.ts } as const;
  switch (record.type) {
    case 'alert.fired':
    case 'alert.resolved': {
      const { alert } = record.payload as AlertPayload;
      return {
        ...envelope,
        type: record.type,
        data: { alert: redactAlert(alert, principal) },
      };
    }
    case 'alert.updated': {
      const { alert, change } = record.payload as AlertPayload;
      return {
        ...envelope,
        type: 'alert.updated',
        data: { alert: redactAlert(alert, principal), change: change ?? 'occurrence' },
      };
    }
    case 'report.owner_changed': {
      const p = record.payload as OwnerChangedPayload;
      return {
        ...envelope,
        type: 'report.owner_changed',
        data: {
          reportId: p.reportId,
          ownerEmail: presentEmail(principal, p.ownerEmail),
          previousOwnerEmail: presentEmail(principal, p.previousOwnerEmail),
          assignedBy: presentEmail(principal, p.assignedBy) ?? 'system',
        },
      };
    }
    case 'telemetry.observed':
    case 'system.notice':
      return { ...envelope, type: record.type, data: record.payload } as AnyServerEvent;
    default:
      return null;
  }
}

/** Renders a bus record for one recipient, or returns null if they must not receive it. */
export function renderForRecipient(
  record: BusRecord,
  principal: Principal,
  topics: ReadonlySet<Topic>,
): AnyServerEvent | null {
  return canReceive(record, principal, topics) ? renderEvent(record, principal) : null;
}
