import type { WarehouseRefreshResult } from '@picc/contracts';
import type { WarehouseSnapshot } from './snapshot.js';

/**
 * The warehouse snapshot currently in service.
 *
 * Services hold the handle, not a snapshot, and read `current` on every call. Replacing the
 * snapshot is therefore a single assignment that every service sees at once: a refresh needs
 * no restart and no request ever observes half of the old data and half of the new.
 */
export class WarehouseHandle {
  private version = 0;
  private readonly memo = new Map<string, { version: number; value: unknown }>();
  private readonly listeners = new Set<(snapshot: WarehouseSnapshot) => void>();

  constructor(private snapshot: WarehouseSnapshot) {}

  get current(): WarehouseSnapshot {
    return this.snapshot;
  }

  /** A lookup built from the snapshot, computed once per snapshot and then reused. */
  derive<T>(key: string, build: (snapshot: WarehouseSnapshot) => T): T {
    const held = this.memo.get(key);
    if (held && held.version === this.version) return held.value as T;
    const value = build(this.snapshot);
    this.memo.set(key, { version: this.version, value });
    return value;
  }

  replace(next: WarehouseSnapshot): void {
    this.snapshot = next;
    this.version += 1;
    this.memo.clear();
    for (const listener of this.listeners) listener(next);
  }

  onChange(listener: (snapshot: WarehouseSnapshot) => void): void {
    this.listeners.add(listener);
  }
}

export type SnapshotBuilder = () => Promise<WarehouseSnapshot>;

export interface RefreshState {
  refreshEveryMin: number;
  lastRefreshAt: string | null;
  lastRefreshOutcome: WarehouseRefreshResult['outcome'] | null;
  lastRefreshError: string | null;
}

/**
 * Re-reads the warehouse while the application keeps serving.
 *
 * A refresh that fails, or that brings back data failing a reconciliation check, changes
 * nothing: the previous snapshot stays in service and the failure is reported. Bad data never
 * goes live, and a warehouse outage degrades to "figures are as of the last good read".
 */
export class WarehouseRefresher {
  readonly counts = { refreshed: 0, unchanged: 0, failed: 0 };
  private inFlight: Promise<WarehouseRefreshResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshAt: string | null = null;
  private lastRefreshOutcome: WarehouseRefreshResult['outcome'] | null = null;
  private lastRefreshError: string | null = null;

  constructor(
    private readonly handle: WarehouseHandle,
    private readonly build: SnapshotBuilder,
    private readonly now: () => Date,
    private readonly refreshEveryMin: number,
    private readonly onResult: (result: WarehouseRefreshResult) => void = () => undefined,
  ) {}

  /** Concurrent callers share one run: two admins pressing the button do one refresh. */
  refresh(): Promise<WarehouseRefreshResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<WarehouseRefreshResult> {
    const started = performance.now();
    let result: WarehouseRefreshResult;
    try {
      const next = await this.build();
      const failed = next.reconciliation.filter((check) => check.status === 'FAIL');
      if (failed.length > 0) {
        throw new Error(
          `The rebuilt warehouse failed ${failed.length} reconciliation check(s): ${failed
            .map((check) => check.check_id)
            .join(', ')}.`,
        );
      }
      const unchanged = next.builtAt === this.handle.current.builtAt;
      if (!unchanged) this.handle.replace(next);
      result = {
        outcome: unchanged ? 'unchanged' : 'refreshed',
        builtAt: this.handle.current.builtAt,
        durationMs: Math.round(performance.now() - started),
        error: null,
      };
    } catch (error) {
      result = {
        outcome: 'failed',
        builtAt: this.handle.current.builtAt,
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.counts[result.outcome] += 1;
    this.lastRefreshAt = this.now().toISOString();
    this.lastRefreshOutcome = result.outcome;
    this.lastRefreshError = result.error;
    this.onResult(result);
    return result;
  }

  start(): void {
    if (this.timer || this.refreshEveryMin <= 0) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshEveryMin * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): RefreshState {
    return {
      refreshEveryMin: this.refreshEveryMin,
      lastRefreshAt: this.lastRefreshAt,
      lastRefreshOutcome: this.lastRefreshOutcome,
      lastRefreshError: this.lastRefreshError,
    };
  }
}
