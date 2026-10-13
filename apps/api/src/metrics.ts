import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { safeEqual } from './auth/passwords.js';
import type { Config } from './config.js';

type Labels = Record<string, string | number>;

const labelText = (labels: Labels): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries
    .map(
      ([key, value]) =>
        `${key}="${String(value).replace(/[\\"\n]/g, (c) => (c === '\n' ? '\\n' : `\\${c}`))}"`,
    )
    .join(',')}}`;
};

interface Counter {
  kind: 'counter';
  help: string;
  values: Map<string, number>;
}

interface Histogram {
  kind: 'histogram';
  help: string;
  buckets: readonly number[];
  /** Per label set: one count per bucket, then +Inf, then the sum. */
  values: Map<string, { labels: Labels; counts: number[]; sum: number }>;
}

interface Gauge {
  kind: 'gauge';
  help: string;
  collect: () => number | { labels: Labels; value: number }[];
}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

/**
 * Metrics in the Prometheus text format, served at `/metrics`.
 *
 * Counters and histograms are incremented where things happen; gauges are read from the
 * owning component at scrape time, so they are never out of date and cost nothing between
 * scrapes. Hand-written because the format is a few lines and the alternative is a dependency.
 */
export class Metrics {
  private readonly series = new Map<string, Counter | Histogram | Gauge>();
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.loopDelay.enable();
    this.gauge(
      'picc_event_loop_lag_seconds',
      'Event loop delay since the previous scrape. High values mean requests are queueing behind synchronous work.',
      () => {
        const values = [
          { labels: { quantile: '0.5' }, value: this.loopDelay.percentile(50) / 1e9 },
          { labels: { quantile: '0.99' }, value: this.loopDelay.percentile(99) / 1e9 },
          { labels: { quantile: '1' }, value: this.loopDelay.max / 1e9 },
        ];
        this.loopDelay.reset();
        return values;
      },
    );
    this.gauge('picc_process_uptime_seconds', 'Seconds since the process started.', () =>
      process.uptime(),
    );
    this.gauge(
      'picc_process_resident_memory_bytes',
      'Resident set size.',
      () => process.memoryUsage().rss,
    );
    this.gauge(
      'picc_process_heap_used_bytes',
      'V8 heap in use.',
      () => process.memoryUsage().heapUsed,
    );
  }

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    let counter = this.series.get(name) as Counter | undefined;
    if (!counter) {
      counter = { kind: 'counter', help, values: new Map() };
      this.series.set(name, counter);
    }
    const key = labelText(labels);
    counter.values.set(key, (counter.values.get(key) ?? 0) + by);
  }

  observe(name: string, help: string, labels: Labels, value: number): void {
    let histogram = this.series.get(name) as Histogram | undefined;
    if (!histogram) {
      histogram = { kind: 'histogram', help, buckets: DURATION_BUCKETS, values: new Map() };
      this.series.set(name, histogram);
    }
    const key = labelText(labels);
    let entry = histogram.values.get(key);
    if (!entry) {
      entry = { labels, counts: new Array<number>(histogram.buckets.length + 1).fill(0), sum: 0 };
      histogram.values.set(key, entry);
    }
    const index = histogram.buckets.findIndex((bound) => value <= bound);
    entry.counts[index === -1 ? histogram.buckets.length : index]! += 1;
    entry.sum += value;
  }

  gauge(name: string, help: string, collect: Gauge['collect']): void {
    this.series.set(name, { kind: 'gauge', help, collect });
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, series] of this.series) {
      lines.push(`# HELP ${name} ${series.help}`, `# TYPE ${name} ${series.kind}`);
      if (series.kind === 'counter') {
        for (const [labels, value] of series.values) lines.push(`${name}${labels} ${value}`);
      } else if (series.kind === 'gauge') {
        const collected = series.collect();
        if (typeof collected === 'number') lines.push(`${name} ${collected}`);
        else
          for (const { labels, value } of collected)
            lines.push(`${name}${labelText(labels)} ${value}`);
      } else {
        for (const { labels, counts, sum } of series.values.values()) {
          let cumulative = 0;
          series.buckets.forEach((bound, index) => {
            cumulative += counts[index]!;
            lines.push(`${name}_bucket${labelText({ ...labels, le: bound })} ${cumulative}`);
          });
          cumulative += counts[series.buckets.length]!;
          lines.push(
            `${name}_bucket${labelText({ ...labels, le: '+Inf' })} ${cumulative}`,
            `${name}_sum${labelText(labels)} ${sum}`,
            `${name}_count${labelText(labels)} ${cumulative}`,
          );
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  close(): void {
    this.loopDelay.disable();
  }
}

/**
 * The Prometheus scrape endpoint. With METRICS_TOKEN set it needs that bearer token; without
 * one it is served only where the deployment is open anyway (development and demo mode), and
 * is otherwise indistinguishable from a route that does not exist.
 */
export function metricsHandler(config: Config, metrics: Metrics): RequestHandler {
  return (req, res) => {
    const presented = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const allowed = config.metricsToken
      ? safeEqual(presented, config.metricsToken)
      : config.env !== 'production' || config.demoMode;
    if (!allowed) {
      res.status(404).type('application/problem+json').json({
        type: 'https://pure-insights.example/problems/not_found',
        title: 'Not found',
        status: 404,
        code: 'not_found',
        detail: 'No such endpoint.',
      });
      return;
    }
    res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  };
}
