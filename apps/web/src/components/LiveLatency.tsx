import type { TelemetrySeries, TelemetryWindow } from '@picc/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, query } from '../lib/api';
import { SERIES_COLORS, TrendChart } from './charts';
import { Card, Empty, QueryBoundary, Segmented } from './ui';

const clock = (iso: string, withSeconds = false): string =>
  new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  });

const WINDOWS: { value: TelemetryWindow; label: string }[] = [
  { value: '1h', label: '1 h' },
  { value: '6h', label: '6 h' },
  { value: '24h', label: '24 h' },
];

/**
 * Load time from live telemetry over the last hours. The period charts show how a report
 * behaved month to month; this shows how it is behaving now.
 *
 * Across reports it plots the median and 95th percentile per time bucket. For one report it
 * plots the individual readings, since one report sends too few to summarise.
 */
export function LiveLatency({ reportId, className }: { reportId?: string; className?: string }) {
  const [window, setWindow] = useState<TelemetryWindow>('1h');
  const series = useQuery({
    queryKey: ['telemetry-series', window, reportId ?? null],
    queryFn: () => api.get<TelemetrySeries>(`/telemetry/series${query({ window, reportId })}`),
    refetchInterval: 15_000,
  });
  const title = reportId ? 'Live load time' : 'Live load time, all reports in view';
  const controls = (
    <Segmented<TelemetryWindow>
      label="Time range"
      value={window}
      onChange={setWindow}
      options={WINDOWS}
    />
  );

  return (
    <QueryBoundary query={series}>
      {(data) => {
        const { totals } = data;
        const subtitle = `${totals.observations.toLocaleString()} reading${totals.observations === 1 ? '' : 's'}${
          reportId ? '' : ` from ${totals.reports} report${totals.reports === 1 ? '' : 's'}`
        } · ${totals.latencyBreaches.toLocaleString()} over ${data.thresholdSec} s · ${totals.refreshFailures.toLocaleString()} failed refresh${totals.refreshFailures === 1 ? '' : 'es'}`;
        if (totals.observations === 0) {
          return (
            <Card
              title={title}
              subtitle="From live telemetry"
              actions={controls}
              className={className}
            >
              <Empty
                title="No live readings in this range"
                hint="Readings appear here as the portal, or the built-in simulator, sends them."
              />
            </Card>
          );
        }
        const common = {
          title,
          subtitle,
          controls,
          className,
          showGaps: true,
          xLabel: 'Time',
          format: (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)} s`,
          threshold: { value: data.thresholdSec, label: `${data.thresholdSec} s alert threshold` },
        };
        return reportId ? (
          <TrendChart
            {...common}
            data={data.points.map((p) => ({
              at: clock(p.observedAt, true),
              loadTimeSec: p.loadTimeSec,
            }))}
            xKey="at"
            series={[{ key: 'loadTimeSec', label: 'Load time', color: SERIES_COLORS[0] }]}
          />
        ) : (
          <TrendChart
            {...common}
            data={data.buckets.map((b) => ({
              at: clock(b.start),
              p50LoadSec: b.p50LoadSec,
              p95LoadSec: b.p95LoadSec,
            }))}
            xKey="at"
            series={[
              { key: 'p50LoadSec', label: 'Median', color: SERIES_COLORS[0] },
              { key: 'p95LoadSec', label: '95th percentile', color: SERIES_COLORS[1] },
            ]}
          />
        );
      }}
    </QueryBoundary>
  );
}
