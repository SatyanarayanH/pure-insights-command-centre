import type { DqFinding, DqRule, DqSummary, QuarantineRow } from '@picc/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  Card,
  cx,
  Note,
  PageHeader,
  Pager,
  QueryBoundary,
  Stat,
  TableShell,
  td,
  tdNum,
  th,
  thNum,
} from '../components/ui';
import { api, query } from '../lib/api';
import { fmtDateTime, fmtNum, fmtUsd } from '../lib/format';

const ACTION_TONE = {
  NORMALIZE: 'accent',
  QUARANTINE: 'critical',
  FLAG: 'warning',
  RESTRUCTURE: 'neutral',
} as const;
const period = (seq: number): string => `P${String(seq + 1).padStart(2, '0')}`;

function RuleTable({
  rules,
  selected,
  onSelect,
  total,
}: {
  rules: DqRule[];
  selected: string;
  onSelect: (id: string) => void;
  total: number;
}) {
  return (
    <TableShell>
      <thead>
        <tr>
          <th className={th}>Rule</th>
          <th className={th}>Action</th>
          <th className={thNum}>Rows</th>
          <th className={`${th} w-40`}>Share of {fmtNum(total)} rows</th>
          <th className={thNum}>Reports</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <tr
            key={rule.ruleId}
            onClick={() => rule.rowsAffected > 0 && onSelect(rule.ruleId)}
            className={cx(
              rule.rowsAffected > 0 && 'cursor-pointer hover:bg-surface-2',
              selected === rule.ruleId && 'bg-surface-2',
              rule.rowsAffected === 0 && 'opacity-55',
            )}
          >
            <td className={`${td} max-w-xl`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-ink-3">{rule.ruleId}</span>
                <span className="font-medium text-ink">
                  {rule.ruleName.replaceAll('_', ' ').toLowerCase()}
                </span>
              </div>
              <div className="text-[12.5px] text-ink-2">{rule.description}</div>
            </td>
            <td className={td}>
              <Badge tone={ACTION_TONE[rule.action]}>{rule.action.toLowerCase()}</Badge>
            </td>
            <td className={`${tdNum} font-medium`}>{fmtNum(rule.rowsAffected)}</td>
            <td className={td}>
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 rounded-full bg-surface-2">
                  <div
                    className="h-2 rounded-full"
                    style={{
                      width: `${Math.max(rule.rowsAffected ? 1.5 : 0, rule.pctOfRows)}%`,
                      background: 'var(--series-1)',
                    }}
                  />
                </div>
                <span className="tnum w-12 text-right text-[12.5px] text-ink-2">
                  {rule.pctOfRows}%
                </span>
              </div>
            </td>
            <td className={tdNum}>{rule.reportsAffected}</td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function Findings({ ruleId, rule }: { ruleId: string; rule?: DqRule }) {
  const [page, setPage] = useState(1);
  const findings = useQuery({
    queryKey: ['dq', 'findings', ruleId, page],
    queryFn: () =>
      api.get<{ items: DqFinding[]; total: number; page: number; pageSize: number }>(
        `/dq/findings${query({ ruleId, page, pageSize: 10 })}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      title={`Findings for ${ruleId}`}
      subtitle={
        rule
          ? `${rule.ruleName.replaceAll('_', ' ').toLowerCase()} · each one traceable to a line of the source file`
          : undefined
      }
      flush
    >
      <QueryBoundary query={findings}>
        {(data) => (
          <>
            <TableShell>
              <thead>
                <tr>
                  <th className={thNum}>CSV line</th>
                  <th className={th}>Report</th>
                  <th className={th}>Period</th>
                  <th className={th}>Observed value</th>
                  <th className={th}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((f) => (
                  <tr key={`${f.ruleId}-${f.rowSeq}`}>
                    <td className={`${tdNum} text-ink-2`}>{f.rowSeq + 1}</td>
                    <td className={td}>
                      <Link
                        to={`/reports/${f.reportId}`}
                        className="font-mono text-[12.5px] text-ink hover:underline"
                      >
                        {f.reportId}
                      </Link>
                    </td>
                    <td className={`${td} tnum`}>{period(f.periodSeq)}</td>
                    <td className={`${td} font-mono text-[12.5px]`}>{f.observedValue ?? '—'}</td>
                    <td className={`${td} text-ink-2`}>{f.detail}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

function Body({ summary }: { summary: DqSummary }) {
  const inBrief = summary.rules.filter((r) => r.inBrief);
  const found = summary.rules.filter((r) => !r.inBrief);
  const [selected, setSelected] = useState('DQ-02');
  const quarantine = useQuery({
    queryKey: ['dq', 'quarantine'],
    queryFn: () => api.get<{ items: QuarantineRow[] }>('/dq/quarantine'),
  });
  const passed = summary.reconciliation.filter((c) => c.status === 'PASS').length;
  const select = (id: string) => setSelected(id);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Rows landed"
          value={fmtNum(summary.rowsLanded)}
          hint={`${summary.reports} reports × ${summary.periods} periods · none deleted`}
        />
        <Stat
          label="Rules triggered"
          value={`${summary.rulesTriggered} of ${summary.rules.length}`}
          hint={`${found.filter((r) => r.rowsAffected > 0).length} of them not listed in the brief`}
        />
        <Stat
          label="Quarantined from cost"
          value={fmtNum(summary.rowsQuarantined)}
          tone="warning"
          hint="kept for audit, excluded from attribution"
        />
        <Stat
          label="Reconciliation checks"
          value={`${passed} / ${summary.reconciliation.length}`}
          tone={passed === summary.reconciliation.length ? 'good' : 'critical'}
          icon={<CircleCheck size={16} />}
          hint={`${summary.warehouse.dialect} · suite ran in ${(summary.warehouse.suiteDurationMs / 1000).toFixed(1)} s`}
        />
      </div>

      <Note tone="accent">
        The file has {fmtNum(summary.rowsLanded)} rows but only {summary.reports} report ids, each
        repeated {summary.periods} times with no date column. It is read as {summary.periods}{' '}
        reporting periods of the same {summary.reports} reports. Treating every row as a separate
        report would have counted each one {summary.periods} times.
      </Note>

      <Card
        title="Defects listed in the brief"
        subtitle="Select a rule to see the rows behind it"
        flush
      >
        <RuleTable
          rules={inBrief}
          selected={selected}
          onSelect={select}
          total={summary.rowsLanded}
        />
      </Card>
      <Card
        title="Defects found by profiling"
        subtitle="Not in the brief. Each would have produced a wrong number or a runtime error."
        flush
      >
        <RuleTable rules={found} selected={selected} onSelect={select} total={summary.rowsLanded} />
      </Card>

      <Findings
        key={selected}
        ruleId={selected}
        rule={summary.rules.find((r) => r.ruleId === selected)}
      />

      <div className="grid gap-5 xl:grid-cols-2">
        <Card
          title="Quarantine"
          subtitle="Credit figures withheld from attribution, and what the queries really cost"
          flush
        >
          <QueryBoundary query={quarantine}>
            {({ items }) => (
              <div className="max-h-96 overflow-y-auto">
                <TableShell>
                  <thead className="sticky top-0 bg-surface">
                    <tr>
                      <th className={thNum}>CSV line</th>
                      <th className={th}>Report</th>
                      <th className={th}>Period</th>
                      <th className={thNum}>Reported credits</th>
                      <th className={thNum}>Estimated credits</th>
                      <th className={thNum}>Estimated cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((q) => (
                      <tr key={q.rowSeq}>
                        <td className={`${tdNum} text-ink-2`}>{q.rowSeq + 1}</td>
                        <td className={`${td} font-mono text-[12.5px]`}>{q.reportId}</td>
                        <td className={`${td} tnum`}>{period(q.periodSeq)}</td>
                        <td className={`${tdNum} text-critical-ink`}>
                          {fmtNum(q.creditsReported, 2)}
                        </td>
                        <td className={tdNum}>{fmtNum(q.creditsImputed, 1)}</td>
                        <td className={tdNum}>{fmtUsd(q.costImputedUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>
            )}
          </QueryBoundary>
        </Card>

        <Card
          title="Reconciliation"
          subtitle="The SQL suite checks its own arithmetic; the app does not start if one fails"
          flush
        >
          <div className="max-h-96 overflow-y-auto">
            <TableShell>
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className={th}>Check</th>
                  <th className={thNum}>Expected</th>
                  <th className={thNum}>Actual</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {summary.reconciliation.map((c) => (
                  <tr key={c.checkId}>
                    <td className={td}>
                      <span className="mr-2 font-mono text-[12px] text-ink-3">{c.checkId}</span>
                      {c.description}
                    </td>
                    <td className={tdNum}>
                      {fmtNum(c.expectedValue, Number.isInteger(c.expectedValue) ? 0 : 2)}
                    </td>
                    <td className={tdNum}>
                      {fmtNum(c.actualValue, Number.isInteger(c.expectedValue) ? 0 : 2)}
                    </td>
                    <td className={td}>
                      {c.status === 'PASS' ? (
                        <Badge tone="good" icon={<CircleCheck size={12} />}>
                          Pass
                        </Badge>
                      ) : (
                        <Badge tone="critical" icon={<CircleX size={12} />}>
                          Fail
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        </Card>
      </div>

      <p className="text-[12.5px] text-ink-3">
        Warehouse built {fmtDateTime(summary.warehouse.builtAt)} on {summary.warehouse.dialect}.
        ACCOUNT_USAGE is simulated: {fmtNum(summary.warehouse.queryRowsSimulated)} query rows, each
        standing for about {summary.warehouse.queriesPerRow} real queries.
      </p>
    </div>
  );
}

export function DataQualityPage() {
  const summary = useQuery({
    queryKey: ['dq', 'summary'],
    queryFn: () => api.get<DqSummary>('/dq/summary'),
  });
  return (
    <>
      <PageHeader
        title="Data quality"
        description="Every defect in the source data, what was done about it, and proof that the cost figures still add up afterwards."
      />
      <QueryBoundary query={summary}>{(data) => <Body summary={data} />}</QueryBoundary>
    </>
  );
}
