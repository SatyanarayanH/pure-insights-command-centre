import type { DqFinding, DqSummary, QuarantineRow } from '@picc/contracts';
import type { WarehouseHandle } from '../warehouse/handle.js';
import type { WarehouseSnapshot } from '../warehouse/snapshot.js';

export class DqService {
  constructor(private readonly warehouse: WarehouseHandle) {}

  private get snapshot(): WarehouseSnapshot {
    return this.warehouse.current;
  }

  summary(): DqSummary {
    const s = this.snapshot;
    return {
      rowsLanded: s.facts.length,
      reports: s.dim.length,
      periods: s.periodSummary.length,
      rowsQuarantined: s.quarantine.length,
      rulesTriggered: s.dqRules.filter((r) => r.rows_affected > 0).length,
      rules: s.dqRules.map((r) => ({
        ruleId: r.rule_id,
        ruleName: r.rule_name,
        category: r.category,
        severity: r.severity,
        action: r.action,
        inBrief: r.in_brief,
        description: r.description,
        rowsAffected: r.rows_affected,
        reportsAffected: r.reports_affected,
        pctOfRows: r.pct_of_rows,
      })),
      reconciliation: s.reconciliation.map((c) => ({
        checkId: c.check_id,
        description: c.description,
        expectedValue: c.expected_value,
        actualValue: c.actual_value,
        difference: c.difference,
        tolerance: c.tolerance,
        status: c.status,
      })),
      warehouse: {
        dialect: s.dialect,
        builtAt: s.builtAt,
        suiteDurationMs: s.suiteDurationMs,
        queryRowsSimulated: s.queryRowsSimulated,
        queriesPerRow: s.queriesPerRow,
      },
    };
  }

  findings(query: { ruleId?: string; reportId?: string; page: number; pageSize: number }): {
    items: DqFinding[];
    total: number;
    page: number;
    pageSize: number;
  } {
    const rows = this.snapshot.dqFindings.filter(
      (f) =>
        (!query.ruleId || f.rule_id === query.ruleId) &&
        (!query.reportId || f.report_id === query.reportId),
    );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: rows.slice(start, start + query.pageSize).map((f) => ({
        ruleId: f.rule_id,
        rowSeq: f.row_seq,
        reportId: f.report_id,
        periodSeq: f.period_seq,
        observedValue: f.observed_value,
        detail: f.detail,
      })),
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  quarantine(): QuarantineRow[] {
    const facts = new Map(this.snapshot.facts.map((f) => [f.row_seq, f]));
    return this.snapshot.quarantine.map((q) => {
      const fact = facts.get(q.row_seq);
      return {
        rowSeq: q.row_seq,
        reportId: q.report_id,
        periodSeq: q.period_seq,
        ruleId: q.rule_id,
        reasonCode: q.reason_code,
        rawValue: q.raw_value,
        creditsReported: q.credits_raw,
        creditsImputed: fact?.credits_fully_loaded ?? null,
        costImputedUsd: fact?.snowflake_cost_loaded_usd ?? null,
      };
    });
  }
}
