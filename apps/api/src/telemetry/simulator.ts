import type { SimulatorState } from '@picc/contracts';
import { createRng } from '../warehouse/prng.js';
import type { FactRow } from '../warehouse/snapshot.js';
import type { TelemetryService } from './service.js';

/**
 * Stand-in for the portal's telemetry emitter.
 *
 * Each tick takes the next report in a shuffled order and re-emits one of that report's own
 * 20 historical observations, chosen at random. Values therefore stay faithful to the dataset
 * (same latency distribution, same failure rate per report) while the stream never runs dry.
 * It calls the same TelemetryService.ingest the HTTP endpoint does.
 */
export class LiveSimulator {
  private timer: NodeJS.Timeout | null = null;
  private eventsEmitted = 0;
  private lastEventAt: string | null = null;
  private cursor = 0;
  private readonly order: string[];
  private readonly history = new Map<string, FactRow[]>();
  private readonly rng = createRng('live-simulator');

  constructor(
    private readonly telemetry: TelemetryService,
    facts: readonly FactRow[],
    private intervalMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const fact of facts) {
      const list = this.history.get(fact.report_id) ?? [];
      list.push(fact);
      this.history.set(fact.report_id, list);
    }
    this.order = [...this.history.keys()];
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [this.order[i], this.order[j]] = [this.order[j]!, this.order[i]!];
    }
  }

  start(): void {
    if (this.timer || this.order.length === 0) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  configure(change: { running?: boolean; intervalMs?: number }): SimulatorState {
    const wasRunning = this.timer !== null;
    if (change.intervalMs !== undefined && change.intervalMs !== this.intervalMs) {
      this.intervalMs = change.intervalMs;
      if (wasRunning) {
        this.stop();
        this.start();
      }
    }
    if (change.running === true) this.start();
    if (change.running === false) this.stop();
    return this.state();
  }

  tick(): void {
    const reportId = this.order[this.cursor % this.order.length]!;
    this.cursor += 1;
    const samples = this.history.get(reportId)!;
    const sample = samples[this.rng.int(samples.length)]!;
    this.telemetry.ingest(
      [
        {
          reportId,
          loadTimeSec: sample.avg_load_time_sec ?? undefined,
          refreshStatus: sample.refresh_status,
        },
      ],
      { source: 'live' },
    );
    this.eventsEmitted += 1;
    this.lastEventAt = this.now().toISOString();
  }

  state(): SimulatorState {
    return {
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      eventsEmitted: this.eventsEmitted,
      lastEventAt: this.lastEventAt,
    };
  }
}
