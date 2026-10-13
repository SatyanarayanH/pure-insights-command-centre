import {
  AckAlertRequestSchema,
  AlertDetailSchema,
  AlertListQuerySchema,
  AlertRuleIdSchema,
  AlertRuleSchema,
  AlertSchema,
  AlertStatsSchema,
  AssignOwnerRequestSchema,
  AuditEntrySchema,
  AuditQuerySchema,
  AuthConfigSchema,
  AuthResponseSchema,
  ChargebackSchema,
  CostAnomaliesSchema,
  CostReportsQuerySchema,
  CostReportsSchema,
  CostSummarySchema,
  DemoLoginRequestSchema,
  DqFindingSchema,
  DqFindingsQuerySchema,
  DqSummarySchema,
  InjectIncidentRequestSchema,
  LoginRequestSchema,
  OkSchema,
  OrphanQueueSchema,
  OverviewSchema,
  OwnerAssignmentSchema,
  pageOf,
  QuarantineRowSchema,
  RealtimeTicketSchema,
  ReportDetailSchema,
  ReportIdSchema,
  ReportListQuerySchema,
  ReportSummarySchema,
  SimulatorStateSchema,
  SnoozeAlertRequestSchema,
  SSE_PATH,
  SystemStatusSchema,
  TelemetryIngestRequestSchema,
  TelemetryIngestResponseSchema,
  UpdateAlertRuleRequestSchema,
  UpdateSimulatorRequestSchema,
  UserListSchema,
  UserSchema,
  WS_PATH,
} from '@picc/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { can, toUserDto } from '../auth/principal.js';
import { API_PREFIX, SERVICE_NAME, SERVICE_VERSION } from '../config.js';
import type { Container } from '../container.js';
import type { UserRow } from '../opsdb/repositories.js';
import { TICKET_TTL_MS } from '../realtime/tickets.js';
import { forbidden, notFound, unauthorized } from './errors.js';
import { defineRoute, type RouteDefinition } from './registry.js';

export const REFRESH_COOKIE = 'picc_refresh';
export const SESSION_HINT_COOKIE = 'picc_signed_in';

/** A valid hash of a throwaway value, used to spend the same time on unknown accounts. */
const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-account');

const ReportParams = z.object({ reportId: ReportIdSchema });
const AlertParams = z.object({ alertId: z.string().min(1).max(64) });
const RuleParams = z.object({ ruleId: AlertRuleIdSchema });

export function buildRoutes(c: Container): RouteDefinition[] {
  const { config } = c;

  const setRefreshCookie = (res: Response, token: string): void => {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.forceHttps,
      path: `${API_PREFIX}/auth`,
      maxAge: config.refreshTokenTtlDays * 86_400_000,
    });
    // Readable by the page and worthless on its own: it only tells the client that a session
    // may exist, so a first-time visitor does not fire a refresh that is bound to return 401.
    res.cookie(SESSION_HINT_COOKIE, '1', {
      httpOnly: false,
      sameSite: 'strict',
      secure: config.forceHttps,
      path: '/',
      maxAge: config.refreshTokenTtlDays * 86_400_000,
    });
  };
  const clearRefreshCookie = (res: Response): void => {
    res.clearCookie(REFRESH_COOKIE, { path: `${API_PREFIX}/auth` });
    res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
  };
  const readRefreshCookie = (req: Request): string | undefined =>
    (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];

  const startSession = async (user: UserRow, res: Response, method: string, requestId: string) => {
    c.users.touchLogin(user.id, c.now().toISOString());
    setRefreshCookie(res, c.tokens.issueRefreshToken(user.id));
    c.audit.record({
      actor: user.email,
      actorRole: user.role,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      detail: { method },
      requestId,
    });
    return {
      accessToken: await c.tokens.issueAccessToken({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      }),
      expiresIn: config.accessTokenTtlSec,
      user: toUserDto(user),
    };
  };

  return [
    // ---- Auth ------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/auth/config',
      operationId: 'getAuthConfig',
      tag: 'Auth',
      summary: 'Sign-in options',
      description:
        'Tells the login screen whether demo mode is on and, if so, which personas can be used for one-click sign-in.',
      auth: 'public',
      response: AuthConfigSchema,
      handler: () => ({ demoMode: config.demoMode, personas: c.personas }),
    }),
    defineRoute({
      method: 'post',
      path: '/auth/login',
      operationId: 'login',
      tag: 'Auth',
      summary: 'Sign in with email and password',
      description:
        'Returns a short-lived access token and sets the rotating refresh token as an httpOnly cookie.',
      auth: 'public',
      body: LoginRequestSchema,
      response: AuthResponseSchema,
      handler: async ({ body, res, requestId }) => {
        const user = c.users.findByEmail(body.email);
        // Same message and the same work whether or not the account exists: an unknown email
        // is still checked against a real hash, so response time does not reveal which emails
        // have accounts.
        const matches = verifyPassword(body.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
        if (!user || !matches) {
          c.audit.record({
            actor: 'anonymous',
            actorRole: 'none',
            action: 'auth.login_failed',
            targetType: 'user',
            targetId: body.email.slice(0, 120),
            requestId,
          });
          throw unauthorized('Invalid email or password.');
        }
        return startSession(user, res, 'password', requestId);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/demo-login',
      operationId: 'demoLogin',
      tag: 'Auth',
      summary: 'One-click sign-in as a demo persona',
      description:
        'Only available when the server runs with DEMO_MODE=true. Returns 403 otherwise.',
      auth: 'public',
      body: DemoLoginRequestSchema,
      response: AuthResponseSchema,
      handler: async ({ body, res, requestId }) => {
        if (!config.demoMode) throw forbidden('Demo sign-in is disabled.');
        const user = c.personas.some((p) => p.email === body.email)
          ? c.users.findByEmail(body.email)
          : undefined;
        if (!user) throw notFound('Demo persona');
        return startSession(user, res, 'demo', requestId);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/refresh',
      operationId: 'refreshSession',
      tag: 'Auth',
      summary: 'Exchange the refresh cookie for a new access token',
      description:
        'Rotates the refresh token. Presenting a token that was already rotated revokes the whole session family.',
      auth: 'public',
      response: AuthResponseSchema,
      handler: async ({ req, res }) => {
        const presented = readRefreshCookie(req);
        const rotated = presented ? c.tokens.rotateRefreshToken(presented) : null;
        const user = rotated ? c.users.findById(rotated.userId) : undefined;
        if (!rotated || !user) {
          clearRefreshCookie(res);
          throw unauthorized('No valid session.');
        }
        setRefreshCookie(res, rotated.refreshToken);
        return {
          accessToken: await c.tokens.issueAccessToken({
            sub: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          }),
          expiresIn: config.accessTokenTtlSec,
          user: toUserDto(user),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/logout',
      operationId: 'logout',
      tag: 'Auth',
      summary: 'End the session',
      auth: 'public',
      response: OkSchema,
      handler: ({ req, res }) => {
        const presented = readRefreshCookie(req);
        if (presented) c.tokens.revokeRefreshToken(presented);
        clearRefreshCookie(res);
        return { ok: true as const };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/auth/me',
      operationId: 'getCurrentUser',
      tag: 'Auth',
      summary: 'The signed-in user, with role and permissions',
      auth: 'user',
      response: UserSchema,
      handler: ({ principal }) => {
        const user = c.users.findById(principal.id);
        if (!user) throw unauthorized();
        return toUserDto(user);
      },
    }),

    // ---- Real-time -------------------------------------------------------------------------
    defineRoute({
      method: 'post',
      path: '/realtime/ticket',
      operationId: 'createRealtimeTicket',
      tag: 'Real-time',
      summary: 'Mint a single-use ticket for the WebSocket or SSE stream',
      description:
        'Browsers cannot send an Authorization header when opening a WebSocket or EventSource. Call this with your bearer token, then open the stream with `?ticket=`. The ticket works once and expires in 30 seconds.',
      auth: 'user',
      permission: 'alerts:read',
      response: RealtimeTicketSchema,
      handler: ({ principal }) => ({
        ticket: c.tickets.issue(principal),
        expiresIn: TICKET_TTL_MS / 1000,
        wsPath: WS_PATH,
        ssePath: SSE_PATH,
      }),
    }),

    // ---- Overview and reports --------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/overview',
      operationId: 'getOverview',
      tag: 'Reports',
      summary: 'System health at a glance',
      description:
        'Counts, latency distribution, 20-period trend and the reports that need attention first. Cost figures are included only with `costs:read`.',
      auth: 'user',
      permission: 'reports:read',
      rowScoped: true,
      response: OverviewSchema,
      handler: ({ principal }) => c.reports.overview(principal),
    }),
    defineRoute({
      method: 'get',
      path: '/reports',
      operationId: 'listReports',
      tag: 'Reports',
      summary: 'List reports with current health, owner and cost',
      auth: 'user',
      permission: 'reports:read',
      rowScoped: true,
      query: ReportListQuerySchema,
      response: pageOf(ReportSummarySchema),
      handler: ({ principal, query }) => {
        // Filtering by a real address would let a caller who only sees masked emails work out
        // who owns what, one guess at a time.
        if (query.owner && !can(principal, 'pii:read')) {
          throw forbidden('Filtering by owner requires the "pii:read" permission.');
        }
        return c.reports.list(principal, query);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/reports/:reportId',
      operationId: 'getReport',
      tag: 'Reports',
      summary: 'One report: 20-period history, ownership trail, open alerts, data-quality findings',
      description:
        "Returns 404 for a report outside the caller's scope, the same as for one that does not exist.",
      auth: 'user',
      permission: 'reports:read',
      rowScoped: true,
      params: ReportParams,
      response: ReportDetailSchema,
      handler: ({ principal, params }) => c.reports.detail(principal, params.reportId),
    }),

    // ---- Orphaned reports ------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/orphans',
      operationId: 'getOrphanQueue',
      tag: 'Ownership',
      summary: 'Reports with no owner, ranked by cost at risk',
      description:
        "Each entry carries a suggested owner taken from the report's own ownership history.",
      auth: 'user',
      permission: 'orphans:read',
      response: OrphanQueueSchema,
      handler: ({ principal }) => c.orphans.queue(principal),
    }),
    defineRoute({
      method: 'post',
      path: '/reports/:reportId/owner',
      operationId: 'assignReportOwner',
      tag: 'Ownership',
      summary: 'Assign an owner to a report',
      description:
        "Audited. Broadcasts `report.owner_changed` and re-routes the report's open alerts to the new owner.",
      auth: 'user',
      permission: 'orphans:assign',
      params: ReportParams,
      body: AssignOwnerRequestSchema,
      response: OwnerAssignmentSchema,
      status: 201,
      handler: ({ principal, params, body, requestId }) =>
        c.orphans.assign(principal, params.reportId, body, requestId),
    }),

    // ---- Alerts ----------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/alerts',
      operationId: 'listAlerts',
      tag: 'Alerts',
      summary: 'List alerts, worst first',
      auth: 'user',
      permission: 'alerts:read',
      rowScoped: true,
      query: AlertListQuerySchema,
      response: pageOf(AlertSchema),
      handler: ({ principal, query }) => c.alerts.list(principal, query),
    }),
    defineRoute({
      method: 'get',
      path: '/alerts/stats',
      operationId: 'getAlertStats',
      tag: 'Alerts',
      summary: 'Open alert counts by status, severity and rule',
      auth: 'user',
      permission: 'alerts:read',
      rowScoped: true,
      response: AlertStatsSchema,
      handler: ({ principal }) => c.alerts.stats(principal),
    }),
    defineRoute({
      method: 'get',
      path: '/alerts/:alertId',
      operationId: 'getAlert',
      tag: 'Alerts',
      summary: 'One alert with its full timeline',
      auth: 'user',
      permission: 'alerts:read',
      rowScoped: true,
      params: AlertParams,
      response: AlertDetailSchema,
      handler: ({ principal, params }) => c.alerts.get(principal, params.alertId),
    }),
    defineRoute({
      method: 'post',
      path: '/alerts/:alertId/ack',
      operationId: 'acknowledgeAlert',
      tag: 'Alerts',
      summary: 'Acknowledge an alert',
      description:
        'Marks the alert as owned by the caller. It still resolves on its own once the condition clears.',
      auth: 'user',
      permission: 'alerts:ack',
      rowScoped: true,
      params: AlertParams,
      body: AckAlertRequestSchema,
      response: AlertSchema,
      handler: ({ principal, params, body, requestId }) =>
        c.alerts.acknowledge(principal, params.alertId, body.note, requestId),
    }),
    defineRoute({
      method: 'post',
      path: '/alerts/:alertId/snooze',
      operationId: 'snoozeAlert',
      tag: 'Alerts',
      summary: 'Silence notifications for an alert for a while',
      auth: 'user',
      permission: 'alerts:snooze',
      params: AlertParams,
      body: SnoozeAlertRequestSchema,
      response: AlertSchema,
      handler: ({ principal, params, body, requestId }) =>
        c.alerts.snooze(principal, params.alertId, body.minutes, requestId),
    }),
    defineRoute({
      method: 'get',
      path: '/alert-rules',
      operationId: 'listAlertRules',
      tag: 'Alerts',
      summary: 'Alert rules and their thresholds',
      auth: 'user',
      permission: 'alert-rules:read',
      response: z.object({ items: z.array(AlertRuleSchema) }),
      handler: () => ({ items: c.alerts.listRules() }),
    }),
    defineRoute({
      method: 'put',
      path: '/alert-rules/:ruleId',
      operationId: 'updateAlertRule',
      tag: 'Alerts',
      summary: 'Change an alert rule',
      description:
        'Audited. New thresholds apply from the next observation; open alerts are re-evaluated as telemetry arrives.',
      auth: 'user',
      permission: 'alert-rules:write',
      params: RuleParams,
      body: UpdateAlertRuleRequestSchema,
      response: AlertRuleSchema,
      handler: ({ principal, params, body, requestId }) =>
        c.alerts.updateRule(principal, params.ruleId, body, requestId),
    }),

    // ---- Telemetry -------------------------------------------------------------------------
    defineRoute({
      method: 'post',
      path: '/telemetry',
      operationId: 'ingestTelemetry',
      tag: 'Telemetry',
      summary: 'Push report observations',
      description:
        'The integration point for the portal: one event per dashboard load or refresh. Authenticate with `X-API-Key` (service) or a bearer token holding `telemetry:ingest`. Each event is validated on its own; rejected events are listed in the response and the rest are processed.',
      auth: 'user-or-service',
      permission: 'telemetry:ingest',
      body: TelemetryIngestRequestSchema,
      response: TelemetryIngestResponseSchema,
      status: 202,
      handler: ({ body }) => c.telemetry.ingestRaw(body.events, { source: 'api' }),
    }),

    // ---- Cost ------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/costs/summary',
      operationId: 'getCostSummary',
      tag: 'Cost',
      summary: 'Cost by period, and how the metered bill breaks down',
      description:
        'Platform-wide reconciliation (metered, idle, unattributed, method comparison) is returned only to callers who see all reports.',
      auth: 'user',
      permission: 'costs:read',
      rowScoped: true,
      response: CostSummarySchema,
      handler: ({ principal }) => c.costs.summary(principal),
    }),
    defineRoute({
      method: 'get',
      path: '/costs/reports',
      operationId: 'getCostByReport',
      tag: 'Cost',
      summary: 'Unit economics per report',
      description:
        'Credits, dollars and unit cost per active view for one period or for all periods combined.',
      auth: 'user',
      permission: 'costs:read',
      rowScoped: true,
      query: CostReportsQuerySchema,
      response: CostReportsSchema,
      handler: ({ principal, query }) => c.costs.reports(principal, query.period),
    }),
    defineRoute({
      method: 'get',
      path: '/costs/chargeback',
      operationId: 'getChargeback',
      tag: 'Cost',
      summary: 'Cost by owner, including the unowned pool',
      auth: 'user',
      permission: 'chargeback:read',
      response: ChargebackSchema,
      handler: ({ principal }) => c.costs.chargeback(principal),
    }),
    defineRoute({
      method: 'get',
      path: '/costs/anomalies',
      operationId: 'getCostAnomalies',
      tag: 'Cost',
      summary: 'Where cost and usage disagree, with a monthly dollar figure',
      auth: 'user',
      permission: 'costs:read',
      rowScoped: true,
      response: CostAnomaliesSchema,
      handler: ({ principal }) => c.costs.anomalies(principal),
    }),

    // ---- Data quality ----------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/dq/summary',
      operationId: 'getDataQualitySummary',
      tag: 'Data quality',
      summary: 'Rules, row counts and reconciliation checks',
      auth: 'user',
      permission: 'dq:read',
      response: DqSummarySchema,
      handler: () => c.dq.summary(),
    }),
    defineRoute({
      method: 'get',
      path: '/dq/findings',
      operationId: 'listDataQualityFindings',
      tag: 'Data quality',
      summary: 'Individual rule violations, traceable to a source line',
      auth: 'user',
      permission: 'dq:read',
      query: DqFindingsQuerySchema,
      response: pageOf(DqFindingSchema),
      handler: ({ query }) => c.dq.findings(query),
    }),
    defineRoute({
      method: 'get',
      path: '/dq/quarantine',
      operationId: 'listQuarantine',
      tag: 'Data quality',
      summary: 'Rows excluded from cost attribution, with the imputed replacement',
      auth: 'user',
      permission: 'dq:read',
      response: z.object({ items: z.array(QuarantineRowSchema) }),
      handler: () => ({ items: c.dq.quarantine() }),
    }),

    // ---- Administration --------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/users',
      operationId: 'listUsers',
      tag: 'Admin',
      summary: 'Accounts and their roles',
      auth: 'user',
      permission: 'users:read',
      response: UserListSchema,
      handler: () => ({
        items: c.users.list().map((u) => ({
          ...toUserDto(u),
          reportsOwned: c.ownership.reportsOwnedBy(u.email).length,
          lastLoginAt: u.last_login_at,
        })),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/audit-log',
      operationId: 'listAuditLog',
      tag: 'Admin',
      summary: 'Every state-changing action, newest first',
      auth: 'user',
      permission: 'audit:read',
      query: AuditQuerySchema,
      response: pageOf(AuditEntrySchema),
      handler: ({ query }) => ({
        ...c.audit.list(query.page, query.pageSize, query.action),
        page: query.page,
        pageSize: query.pageSize,
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/admin/incidents',
      operationId: 'injectIncident',
      tag: 'Admin',
      summary: 'Inject a synthetic incident (demo mode)',
      description:
        'Pushes one observation for the chosen report through the normal telemetry pipeline, so the alert it causes is a real one. Disabled unless DEMO_MODE=true.',
      auth: 'user',
      permission: 'incidents:inject',
      body: InjectIncidentRequestSchema,
      response: TelemetryIngestResponseSchema,
      status: 202,
      handler: ({ principal, body, requestId }) => {
        if (!config.demoMode) throw forbidden('Incident injection is disabled outside demo mode.');
        if (!c.ownership.exists(body.reportId)) throw notFound('Report');
        const event =
          body.kind === 'latency_spike'
            ? { reportId: body.reportId, loadTimeSec: body.loadTimeSec ?? 42 }
            : body.kind === 'refresh_failure'
              ? { reportId: body.reportId, refreshStatus: 'FAILED' as const }
              : body.kind === 'refresh_timeout'
                ? { reportId: body.reportId, refreshStatus: 'TIMED_OUT' as const }
                : { reportId: body.reportId, loadTimeSec: 2, refreshStatus: 'SUCCESS' as const };
        c.audit.record({
          actor: principal.email,
          actorRole: principal.role,
          action: 'incident.inject',
          targetType: 'report',
          targetId: body.reportId,
          detail: { kind: body.kind, event },
          requestId,
        });
        // A recovery needs as many healthy observations as the slowest rule asks for.
        const repeats =
          body.kind === 'recovery'
            ? Math.max(...c.alerts.listRules().map((r) => r.resolveAfter))
            : 1;
        const responses = Array.from({ length: repeats }, () =>
          c.telemetry.ingestRaw([event], { source: 'injected' }),
        );
        return {
          accepted: responses.reduce((a, r) => a + r.accepted, 0),
          rejected: responses.flatMap((r) => r.rejected),
          alertsFired: responses.reduce((a, r) => a + r.alertsFired, 0),
          alertsResolved: responses.reduce((a, r) => a + r.alertsResolved, 0),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/admin/simulator',
      operationId: 'getSimulator',
      tag: 'Admin',
      summary: 'State of the built-in telemetry simulator',
      auth: 'user',
      permission: 'simulator:control',
      response: SimulatorStateSchema,
      handler: () => c.simulator.state(),
    }),
    defineRoute({
      method: 'put',
      path: '/admin/simulator',
      operationId: 'updateSimulator',
      tag: 'Admin',
      summary: 'Start, stop or re-pace the telemetry simulator',
      auth: 'user',
      permission: 'simulator:control',
      body: UpdateSimulatorRequestSchema,
      response: SimulatorStateSchema,
      handler: ({ principal, body, requestId }) => {
        const state = c.simulator.configure(body);
        c.audit.record({
          actor: principal.email,
          actorRole: principal.role,
          action: 'simulator.update',
          targetType: 'simulator',
          targetId: 'telemetry',
          detail: body,
          requestId,
        });
        c.bus.publish('system.notice', 'system', {
          level: 'info',
          code: 'simulator.updated',
          message: `Telemetry simulator ${state.running ? `running, one event every ${state.intervalMs} ms` : 'paused'}.`,
        });
        return state;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/system/status',
      operationId: 'getSystemStatus',
      tag: 'System',
      summary: 'Build, warehouse and real-time status',
      auth: 'user',
      permission: 'reports:read',
      response: SystemStatusSchema,
      handler: () => ({
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        uptimeSec: Math.round((Date.now() - c.startedAt) / 1000),
        demoMode: config.demoMode,
        warehouse: {
          dialect: c.snapshot.dialect,
          builtAt: c.snapshot.builtAt,
          suiteDurationMs: c.snapshot.suiteDurationMs,
          reconciliationPassed: c.snapshot.reconciliation.filter((r) => r.status === 'PASS').length,
          reconciliationTotal: c.snapshot.reconciliation.length,
        },
        realtime: {
          ...c.gateway.stats(),
          latestEventId: c.bus.latestId,
          bufferedEvents: c.bus.size,
        },
        simulator: c.simulator.state(),
      }),
    }),
  ];
}
