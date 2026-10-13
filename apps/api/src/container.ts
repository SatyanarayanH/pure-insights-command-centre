import type { Persona, WarehouseRefreshResult } from '@picc/contracts';
import { AlertEngine } from './alerts/engine.js';
import { AlertRepository, AlertRuleRepository } from './alerts/repository.js';
import { AlertService } from './alerts/service.js';
import { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { Metrics } from './metrics.js';
import {
  DEFAULT_NOTIFICATION_OPTIONS,
  type NotificationOptions,
  NotificationService,
} from './notifications/service.js';
import { OpsDb } from './opsdb/db.js';
import {
  AuditLog,
  OwnerAssignmentRepository,
  ReportStateRepository,
  UserRepository,
} from './opsdb/repositories.js';
import { demoUsers, seedDemoUsers, toPersona } from './opsdb/seed.js';
import { EventBus } from './realtime/bus.js';
import {
  DEFAULT_GATEWAY_OPTIONS,
  type GatewayOptions,
  RealtimeGateway,
} from './realtime/gateway.js';
import { MemoryTicketStore, type TicketStore } from './realtime/tickets.js';
import { CostService } from './services/costs.js';
import { DqService } from './services/dq.js';
import { OrphanService } from './services/orphans.js';
import { OwnershipService } from './services/ownership.js';
import type { PresenterContext } from './services/presenters.js';
import { ReportService } from './services/reports.js';
import { ObservationRepository } from './telemetry/observations.js';
import { TelemetrySeriesService } from './telemetry/series.js';
import { TelemetryService } from './telemetry/service.js';
import { LiveSimulator } from './telemetry/simulator.js';
import { StalenessMonitor } from './telemetry/staleness.js';
import { type SnapshotBuilder, WarehouseHandle, WarehouseRefresher } from './warehouse/handle.js';
import type { WarehouseSnapshot } from './warehouse/snapshot.js';
import { snapshotBuilderFor } from './warehouse/source.js';

export interface Container {
  config: Config;
  logger: Logger;
  /** The warehouse snapshot in service right now. Changes when the warehouse is refreshed. */
  readonly snapshot: WarehouseSnapshot;
  warehouse: WarehouseRefresher;
  db: OpsDb;
  users: UserRepository;
  tokens: TokenService;
  tickets: TicketStore;
  bus: EventBus;
  audit: AuditLog;
  ownership: OwnershipService;
  alerts: AlertService;
  telemetry: TelemetryService;
  observations: ObservationRepository;
  series: TelemetrySeriesService;
  staleness: StalenessMonitor;
  notifications: NotificationService;
  metrics: Metrics;
  reports: ReportService;
  costs: CostService;
  dq: DqService;
  orphans: OrphanService;
  simulator: LiveSimulator;
  gateway: RealtimeGateway;
  personas: Persona[];
  startedAt: number;
  now: () => Date;
  /** Starts the timers: staleness and escalation sweeps, scheduled warehouse refresh. */
  startBackgroundWork(): void;
  close(): void;
}

export interface ContainerOverrides {
  logger?: Logger;
  now?: () => Date;
  gateway?: Partial<GatewayOptions>;
  notifications?: Partial<NotificationOptions>;
  /** How to obtain a fresh snapshot on refresh. Defaults to the configured warehouse source. */
  buildSnapshot?: SnapshotBuilder;
  /** A bus that continues a stream held in Redis, and tickets shared with other nodes. */
  bus?: EventBus;
  tickets?: TicketStore;
}

/**
 * Composition root: the one place that knows how the pieces fit. Everything below receives its
 * collaborators through its constructor, which is what lets the tests build the same graph
 * against an in-memory database and a fixed clock.
 */
export function createContainer(
  config: Config,
  snapshot: WarehouseSnapshot,
  overrides: ContainerOverrides = {},
): Container {
  const logger = overrides.logger ?? createLogger(config);
  const now = overrides.now ?? (() => new Date());
  const warehouse = new WarehouseHandle(snapshot);

  const db = new OpsDb(config.opsDb);
  const users = new UserRepository(db);
  const state = new ReportStateRepository(db);
  const observations = new ObservationRepository(db);
  const audit = new AuditLog(db, now);
  const alertRepository = new AlertRepository(db);
  const ruleRepository = new AlertRuleRepository(db);
  ruleRepository.seedDefaults(now().toISOString());

  const seed = demoUsers(
    snapshot.facts.map((f) => f.owner_email).filter((e): e is string => e !== null),
  );
  if (config.demoMode) seedDemoUsers(users, seed, config.demoPassword, now().toISOString());

  const ownership = new OwnershipService(new OwnerAssignmentRepository(db), warehouse);
  const reportNames = () =>
    warehouse.derive('names', (s) => new Map(s.dim.map((d) => [d.report_id, d.report_name])));
  const ctx: PresenterContext = {
    ownership,
    reportName: (reportId) => reportNames().get(reportId) ?? reportId,
    rules: () => ruleRepository.list(),
    now,
  };

  const bus = overrides.bus ?? new EventBus(2000, now);
  bus.resolveOwner = (reportId) => ownership.ownerOf(reportId).email;
  const tickets = overrides.tickets ?? new MemoryTicketStore(() => now().getTime());
  const tokens = new TokenService(config, db, now);
  const engine = new AlertEngine(alertRepository, () => ruleRepository.list());
  const alerts = new AlertService(alertRepository, ruleRepository, bus, audit, ctx, now);
  const telemetry = new TelemetryService(
    db,
    state,
    observations,
    engine,
    alerts,
    ownership,
    bus,
    now,
  );

  const backfill = telemetry.backfill(snapshot);
  if (backfill.ran)
    logger.info(
      { observations: backfill.observations },
      'alert history backfilled from the dataset',
    );

  const notifications = new NotificationService(db, bus, ctx, logger, {
    ...DEFAULT_NOTIFICATION_OPTIONS,
    ...config.notify,
    ...overrides.notifications,
  });
  const staleness = new StalenessMonitor(
    telemetry,
    observations,
    alerts,
    ownership,
    bus,
    notifications,
    now,
    {
      feedSilentAfterSec: config.feedSilentAfterSec,
      sweepIntervalMs: 30_000,
      retentionDays: config.telemetryRetentionDays,
    },
    (error) => logger.error({ err: error }, 'staleness sweep failed'),
  );
  const series = new TelemetrySeriesService(
    observations,
    ownership,
    alerts,
    now,
    () => telemetry.counts.accepted,
  );

  const reports = new ReportService(warehouse, state, ownership, alerts);
  const costs = new CostService(warehouse, ownership);
  const dq = new DqService(warehouse);
  const orphans = new OrphanService(warehouse, ownership, users, state, alerts, audit, bus, now);
  const simulator = new LiveSimulator(
    telemetry,
    snapshot.facts,
    config.simulatorIntervalMs,
    now,
    (error) => logger.error({ err: error }, 'telemetry simulator tick failed'),
  );
  warehouse.onChange((next) => simulator.load(next.facts));

  const refresher = new WarehouseRefresher(
    warehouse,
    overrides.buildSnapshot ?? snapshotBuilderFor(config),
    now,
    config.warehouseRefreshMin,
    (result: WarehouseRefreshResult) => {
      if (result.outcome === 'refreshed') {
        logger.info(
          { builtAt: result.builtAt, durationMs: result.durationMs },
          'warehouse refreshed',
        );
        bus.publish('system.notice', 'system', {
          level: 'info',
          code: 'warehouse.refreshed',
          message: 'Cost and data-quality figures were refreshed from the warehouse.',
        });
      } else if (result.outcome === 'failed') {
        logger.error(
          { reason: result.error },
          'warehouse refresh failed; keeping the previous data',
        );
        const message = `The warehouse could not be refreshed, so figures are as of ${result.builtAt}. ${result.error ?? ''}`;
        bus.publish('system.notice', 'system', {
          level: 'warning',
          code: 'warehouse.refresh_failed',
          message,
        });
        // One notification per hour of failing, not one per attempt.
        notifications.enqueueSystem(
          'warehouse_refresh_failed',
          now().toISOString().slice(0, 13),
          '[WAREHOUSE] Refresh failed',
          message,
        );
      }
    },
  );

  const gateway = new RealtimeGateway(bus, tickets, logger, {
    ...DEFAULT_GATEWAY_OPTIONS,
    allowedOrigins: config.corsOrigins,
    enforceOrigin: config.env === 'production',
    ...overrides.gateway,
  });

  const metrics = new Metrics();
  const transitions = bus.subscribe((record) => {
    if (record.type.startsWith('alert.')) {
      metrics.inc('picc_alert_events_total', 'Alert lifecycle events published.', {
        type: record.type.slice(6),
      });
    }
  });

  return {
    config,
    logger,
    get snapshot() {
      return warehouse.current;
    },
    warehouse: refresher,
    db,
    users,
    tokens,
    tickets,
    bus,
    audit,
    ownership,
    alerts,
    telemetry,
    observations,
    series,
    staleness,
    notifications,
    metrics,
    reports,
    costs,
    dq,
    orphans,
    simulator,
    gateway,
    personas: config.demoMode ? seed.map(toPersona) : [],
    startedAt: Date.now(),
    now,
    startBackgroundWork() {
      staleness.start();
      refresher.start();
    },
    close() {
      simulator.stop();
      staleness.stop();
      refresher.stop();
      transitions();
      notifications.close();
      metrics.close();
      gateway.close();
      db.close();
    },
  };
}
