import type { Persona } from '@picc/contracts';
import { AlertEngine } from './alerts/engine.js';
import { AlertRepository, AlertRuleRepository } from './alerts/repository.js';
import { AlertService } from './alerts/service.js';
import { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { OpsDb } from './opsdb/db.js';
import {
  AuditLog,
  OwnerAssignmentRepository,
  ReportStateRepository,
  UserRepository,
} from './opsdb/repositories.js';
import { demoUsers, seedDemoUsers, toPersona } from './opsdb/seed.js';
import { EventBus } from './realtime/bus.js';
import { DEFAULT_GATEWAY_OPTIONS, type GatewayOptions, RealtimeGateway } from './realtime/gateway.js';
import { TicketStore } from './realtime/tickets.js';
import { CostService } from './services/costs.js';
import { DqService } from './services/dq.js';
import { OrphanService } from './services/orphans.js';
import { OwnershipService } from './services/ownership.js';
import type { PresenterContext } from './services/presenters.js';
import { ReportService } from './services/reports.js';
import { TelemetryService } from './telemetry/service.js';
import { LiveSimulator } from './telemetry/simulator.js';
import type { WarehouseSnapshot } from './warehouse/snapshot.js';

export interface Container {
  config: Config;
  logger: Logger;
  snapshot: WarehouseSnapshot;
  db: OpsDb;
  users: UserRepository;
  tokens: TokenService;
  tickets: TicketStore;
  bus: EventBus;
  audit: AuditLog;
  ownership: OwnershipService;
  alerts: AlertService;
  telemetry: TelemetryService;
  reports: ReportService;
  costs: CostService;
  dq: DqService;
  orphans: OrphanService;
  simulator: LiveSimulator;
  gateway: RealtimeGateway;
  personas: Persona[];
  startedAt: number;
  now: () => Date;
  close(): void;
}

export interface ContainerOverrides {
  logger?: Logger;
  now?: () => Date;
  gateway?: Partial<GatewayOptions>;
}

/**
 * Composition root: the one place that knows how the pieces fit. Everything below receives its
 * collaborators through its constructor, which is what lets the tests build the same graph
 * against an in-memory database and a fixed clock.
 */
export function createContainer(config: Config, snapshot: WarehouseSnapshot, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger(config);
  const now = overrides.now ?? (() => new Date());

  const db = new OpsDb(config.opsDb);
  const users = new UserRepository(db);
  const state = new ReportStateRepository(db);
  const audit = new AuditLog(db, now);
  const alertRepository = new AlertRepository(db);
  const ruleRepository = new AlertRuleRepository(db);
  ruleRepository.seedDefaults(now().toISOString());

  const seed = demoUsers(snapshot.facts.map((f) => f.owner_email).filter((e): e is string => e !== null));
  if (config.demoMode) seedDemoUsers(users, seed, config.demoPassword, now().toISOString());

  const ownership = new OwnershipService(new OwnerAssignmentRepository(db), snapshot.dim);
  const names = new Map(snapshot.dim.map((d) => [d.report_id, d.report_name]));
  const ctx: PresenterContext = {
    ownership,
    reportName: (reportId) => names.get(reportId) ?? reportId,
    rules: () => ruleRepository.list(),
  };

  const bus = new EventBus(2000, now);
  const tickets = new TicketStore(() => now().getTime());
  const tokens = new TokenService(config, db, now);
  const engine = new AlertEngine(alertRepository, () => ruleRepository.list());
  const alerts = new AlertService(alertRepository, ruleRepository, bus, audit, ctx, now);
  const telemetry = new TelemetryService(db, state, engine, alerts, ownership, bus, now);

  const backfill = telemetry.backfill(snapshot);
  if (backfill.ran) logger.info({ observations: backfill.observations }, 'alert history backfilled from the dataset');

  const reports = new ReportService(snapshot, state, ownership, alerts);
  const costs = new CostService(snapshot, ownership);
  const dq = new DqService(snapshot);
  const orphans = new OrphanService(snapshot, ownership, users, state, alerts, audit, bus, now);
  const simulator = new LiveSimulator(telemetry, snapshot.facts, config.simulatorIntervalMs, now);
  const gateway = new RealtimeGateway(bus, tickets, ctx, logger, {
    ...DEFAULT_GATEWAY_OPTIONS,
    allowedOrigins: config.corsOrigins,
    enforceOrigin: config.env === 'production',
    ...overrides.gateway,
  });

  return {
    config,
    logger,
    snapshot,
    db,
    users,
    tokens,
    tickets,
    bus,
    audit,
    ownership,
    alerts,
    telemetry,
    reports,
    costs,
    dq,
    orphans,
    simulator,
    gateway,
    personas: config.demoMode ? seed.map(toPersona) : [],
    startedAt: Date.now(),
    now,
    close() {
      simulator.stop();
      gateway.close();
      db.close();
    },
  };
}
