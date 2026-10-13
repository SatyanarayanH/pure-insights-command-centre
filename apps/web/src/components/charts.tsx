import { Table2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { Card, cx, TableShell, td, tdNum, th, thNum } from './ui';

/*
 * Chart conventions used throughout:
 *  - one y-axis per chart, never two scales;
 *  - series colours in a fixed order and never reused for status;
 *  - a legend whenever there are two or more series, plus a label at the end of each line;
 *  - recessive grid and axes, 2px lines, rounded bar tops, a hover tooltip on every mark;
 *  - every chart can be flipped to a table, so nothing is readable by colour alone.
 */

export interface Series {
  key: string;
  label: string;
  color: string;
}

export const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const;
const AXIS = { fontSize: 11, fill: 'var(--ink-3)' } as const;
type Row = Record<string, string | number | null>;
type Formatter = (value: number) => string;

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
      {series.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

interface TooltipPayload {
  dataKey?: string | number;
  name?: string;
  value?: number | string | null;
  color?: string;
  payload?: Row;
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  format,
  title,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
  series: Series[];
  format: Formatter;
  title?: (row: Row) => string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] shadow-lg">
      <div className="mb-1 font-medium text-ink">{row && title ? title(row) : label}</div>
      {series.map((s) => {
        const value = row?.[s.key];
        return (
          <div key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="tnum font-medium text-ink">
              {typeof value === 'number' ? format(value) : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ChartCard({
  title,
  subtitle,
  series = [],
  table,
  children,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  series?: Series[];
  /** The same data as a table: the accessible alternative to the picture. */
  table?: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card
      title={title}
      subtitle={subtitle}
      className={className}
      actions={
        table && (
          <button
            type="button"
            onClick={() => setAsTable((v) => !v)}
            aria-pressed={asTable}
            title={asTable ? 'Show chart' : 'Show as table'}
            className={cx(
              'rounded-md p-1.5 hover:bg-surface-2',
              asTable ? 'bg-surface-2 text-ink' : 'text-ink-3',
            )}
          >
            <Table2 size={15} />
          </button>
        )
      }
    >
      {asTable && table ? (
        <div className="-mx-5 max-h-72 overflow-y-auto">
          <TableShell>
            <thead>
              <tr>
                {table.columns.map((c, i) => (
                  <th key={c} className={i === 0 ? th : thNum}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={String(row[0])}>
                  {row.map((cell, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                    <td key={i} className={i === 0 ? td : tdNum}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>
      ) : (
        <>
          {series.length >= 2 && (
            <div className="mb-2">
              <Legend series={series} />
            </div>
          )}
          {children}
        </>
      )}
    </Card>
  );
}

const tableOf = (
  data: Row[],
  xKey: string,
  xLabel: string,
  series: Series[],
  format: Formatter,
) => ({
  columns: [xLabel, ...series.map((s) => s.label)],
  rows: data.map((row) => [
    String(row[xKey]),
    ...series.map((s) => (typeof row[s.key] === 'number' ? format(row[s.key] as number) : '—')),
  ]),
});

/** Label at the right-hand end of a line: identity without relying on the legend's colour. */
function endLabel(series: Series, lastIndex: number) {
  return (props: { x?: number | string; y?: number | string; index?: number }) => {
    if (props.index !== lastIndex || typeof props.x !== 'number' || typeof props.y !== 'number')
      return <g />;
    return (
      <text x={props.x + 6} y={props.y} dy={4} fontSize={11} fill="var(--ink-2)">
        {series.label}
      </text>
    );
  };
}

export function TrendChart({
  title,
  subtitle,
  data,
  xKey,
  xLabel = 'Period',
  series,
  format = (v) => v.toLocaleString(),
  height = 240,
  threshold,
  yDomain,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  data: Row[];
  xKey: string;
  xLabel?: string;
  series: Series[];
  format?: Formatter;
  height?: number;
  threshold?: { value: number; label: string };
  yDomain?: [number, number | 'auto'];
  className?: string;
}) {
  const labelWidth = Math.max(...series.map((s) => s.label.length)) * 6.2 + 12;
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      series={series}
      table={tableOf(data, xKey, xLabel, series, format)}
      className={className}
    >
      <ResponsiveContainer width="100%" height={height}>
        <LineChart
          data={data}
          margin={{ top: 8, right: series.length > 1 ? labelWidth : 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: 'var(--line-2)' }}
            interval="preserveStartEnd"
            minTickGap={18}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={format}
            domain={yDomain ?? [0, 'auto']}
          />
          <Tooltip
            cursor={{ stroke: 'var(--line-2)', strokeWidth: 1 }}
            content={<ChartTooltip series={series} format={format} />}
            isAnimationActive={false}
          />
          {threshold && (
            <ReferenceLine
              y={threshold.value}
              stroke="var(--ink-3)"
              strokeDasharray="4 4"
              label={{
                value: threshold.label,
                position: 'insideTopLeft',
                fontSize: 11,
                fill: 'var(--ink-2)',
              }}
            />
          )}
          {series.map((s) => (
            <Line
              key={s.key}
              type="linear"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
              connectNulls
              label={series.length > 1 ? endLabel(s, data.length - 1) : undefined}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function BarsChart({
  title,
  subtitle,
  data,
  xKey,
  xLabel = 'Period',
  series,
  stacked,
  format = (v) => v.toLocaleString(),
  height = 240,
  colorOf,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  data: Row[];
  xKey: string;
  xLabel?: string;
  series: Series[];
  stacked?: boolean;
  format?: Formatter;
  height?: number;
  /** Per-bar colour, for single-series charts whose bars carry a status. */
  colorOf?: (row: Row) => string;
  className?: string;
}) {
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      series={series}
      table={tableOf(data, xKey, xLabel, series, format)}
      className={className}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: 'var(--line-2)' }}
            interval="preserveStartEnd"
            minTickGap={12}
          />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={format} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={<ChartTooltip series={series} format={format} />}
            isAnimationActive={false}
          />
          {series.map((s, index) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              stackId={stacked ? 'stack' : undefined}
              // Rounded only at the data end; a 2px surface gap separates stacked segments.
              radius={!stacked || index === series.length - 1 ? [4, 4, 0, 0] : 0}
              stroke={stacked ? 'var(--surface)' : undefined}
              strokeWidth={stacked ? 2 : 0}
              maxBarSize={44}
              isAnimationActive={false}
            >
              {colorOf && data.map((row) => <Cell key={String(row[xKey])} fill={colorOf(row)} />)}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export interface ScatterPoint {
  id: string;
  label: string;
  x: number;
  y: number;
  group: string;
}

export function QuadrantScatter({
  title,
  subtitle,
  points,
  groups,
  xLabel,
  yLabel,
  formatX,
  formatY,
  xMid,
  yMid,
  onSelect,
  height = 320,
}: {
  title: string;
  subtitle?: ReactNode;
  points: ScatterPoint[];
  groups: Series[];
  xLabel: string;
  yLabel: string;
  formatX: Formatter;
  formatY: Formatter;
  xMid: number;
  yMid: number;
  onSelect?: (id: string) => void;
  height?: number;
}) {
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      series={groups}
      table={{
        columns: ['Report', xLabel, yLabel, 'Class'],
        rows: [...points]
          .sort((a, b) => b.y - a.y)
          .map((p) => [
            p.label,
            formatX(p.x),
            formatY(p.y),
            groups.find((g) => g.key === p.group)?.label ?? p.group,
          ]),
      }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 8, right: 16, left: 4, bottom: 18 }}>
          <CartesianGrid stroke="var(--line)" />
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: 'var(--line-2)' }}
            tickFormatter={formatX}
            label={{
              value: xLabel,
              position: 'insideBottom',
              offset: -10,
              fontSize: 11,
              fill: 'var(--ink-2)',
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={yLabel}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={formatY}
            label={{
              value: yLabel,
              angle: -90,
              position: 'insideLeft',
              fontSize: 11,
              fill: 'var(--ink-2)',
              dy: 40,
            }}
          />
          <ZAxis range={[64, 64]} />
          <ReferenceLine x={xMid} stroke="var(--line-2)" strokeDasharray="4 4" />
          <ReferenceLine y={yMid} stroke="var(--line-2)" strokeDasharray="4 4" />
          <Tooltip
            cursor={false}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as ScatterPoint | undefined;
              if (!active || !point) return null;
              return (
                <div className="rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] shadow-lg">
                  <div className="mb-1 font-medium text-ink">{point.label}</div>
                  <div className="flex justify-between gap-4 text-ink-2">
                    {xLabel} <span className="tnum font-medium text-ink">{formatX(point.x)}</span>
                  </div>
                  <div className="flex justify-between gap-4 text-ink-2">
                    {yLabel} <span className="tnum font-medium text-ink">{formatY(point.y)}</span>
                  </div>
                </div>
              );
            }}
          />
          {groups.map((group) => (
            <Scatter
              key={group.key}
              name={group.label}
              data={points.filter((p) => p.group === group.key)}
              fill={group.color}
              // A surface-coloured ring keeps overlapping points distinguishable.
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
              onClick={(point: unknown) => onSelect?.((point as ScatterPoint).id)}
              cursor={onSelect ? 'pointer' : undefined}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Horizontal bars as plain HTML: labels and values are real text beside each bar. */
export function BarList({
  items,
  format,
  max,
}: {
  items: { key: string; label: ReactNode; value: number; color?: string; note?: ReactNode }[];
  format: Formatter;
  max?: number;
}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate text-ink">{item.label}</span>
            <span className="tnum shrink-0 font-medium text-ink">
              {format(item.value)}
              {item.note && <span className="ml-2 font-normal text-ink-3">{item.note}</span>}
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-2">
            <div
              className="h-2 rounded-full"
              style={{
                width: `${Math.max(0.5, (item.value / top) * 100)}%`,
                background: item.color ?? 'var(--series-1)',
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One bar split into parts of a whole, with the legend carrying label, value and share. */
export function PartsBar({
  parts,
  format,
}: {
  parts: { key: string; label: string; value: number; color: string; hint?: string }[];
  format: Formatter;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div>
      <div className="flex h-7 gap-0.5 overflow-hidden rounded-md">
        {parts.map((part) => (
          <div
            key={part.key}
            title={`${part.label}: ${format(part.value)}`}
            style={{ width: `${(part.value / total) * 100}%`, background: part.color }}
          />
        ))}
      </div>
      <ul className="mt-3 space-y-2.5">
        {parts.map((part) => (
          <li key={part.key} className="flex items-start gap-2 text-[13px]">
            <span
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: part.color }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex justify-between gap-3">
                <span className="text-ink">{part.label}</span>
                <span className="tnum font-medium text-ink">
                  {format(part.value)}{' '}
                  <span className="font-normal text-ink-3">
                    {((part.value / total) * 100).toFixed(1)}%
                  </span>
                </span>
              </span>
              {part.hint && <span className="block text-[12px] text-ink-3">{part.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
