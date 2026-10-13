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

export function presentAlert(record: AlertRecord, principal: Principal, ctx: PresenterContext): Alert {
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
    isFlapping: record.reopenCount >= FLAPPING_REOPEN_COUNT,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    resolvedAt: record.resolvedAt,
    acknowledgedBy: presentEmail(principal, record.acknowledgedBy),
    acknowledgedAt: record.acknowledgedAt,
    ackNote: record.ackNote,
    snoozedUntil: record.snoozedUntil,
    routing: {
      kind: owner.email ? 'owner' : 'admins',
      ownerEmail: presentEmail(principal, owner.email),
      // An alert on a report nobody owns would otherwise notify nobody.
      escalated: owner.email === null,
    },
    source: record.source,
  };
}

export function latencySeverityOf(loadTimeSec: number | null, rule: AlertRule | undefined): LatencySeverity {
  if (loadTimeSec === null || !rule || rule.warningThreshold === null) return 'OK';
  if (rule.criticalThreshold !== null && loadTimeSec > rule.criticalThreshold) return 'CRITICAL';
  if (rule.highThreshold !== null && loadTimeSec > rule.highThreshold) return 'HIGH';
  return loadTimeSec > rule.warningThreshold ? 'WARNING' : 'OK';
}

export interface AlertPayload {
  alert: AlertRecord;
  change?: AlertChange;
}

export interface OwnerChangedPayload {
  reportId: string;
  ownerEmail: string | null;
  previousOwnerEmail: string | null;
  assignedBy: string;
}

/**
 * Renders a bus record for one recipient, or returns null if they must not receive it.
 * Checks, in order: topic subscription, row-level visibility, then field-level redaction.
 */
export function renderForRecipient(
  record: BusRecord,
  principal: Principal,
  topics: ReadonlySet<Topic>,
  ctx: PresenterContext,
): AnyServerEvent | null {
  if (!topics.has(record.topic)) return null;
  if (record.reportId && !ctx.ownership.canSee(principal, record.reportId)) return null;

  const envelope = { v: PROTOCOL_VERSION, id: record.id, ts: record.ts } as const;
  switch (record.type) {
    case 'alert.fired':
    case 'alert.resolved': {
      const { alert } = record.payload as AlertPayload;
      return { ...envelope, type: record.type, data: { alert: presentAlert(alert, principal, ctx) } };
    }
    case 'alert.updated': {
      const { alert, change } = record.payload as AlertPayload;
      return {
        ...envelope,
        type: 'alert.updated',
        data: { alert: presentAlert(alert, principal, ctx), change: change ?? 'occurrence' },
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
