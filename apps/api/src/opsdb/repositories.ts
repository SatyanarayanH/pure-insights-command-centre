import type { AuditEntry, OwnerAssignment, RefreshStatus, Role } from '@picc/contracts';
import type { OpsDb } from './db.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  created_at: string;
  last_login_at: string | null;
}

export class UserRepository {
  constructor(private readonly db: OpsDb) {}

  findByEmail(email: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email.toLowerCase());
  }

  findById(id: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  list(): UserRow[] {
    return this.db.all<UserRow>(
      `SELECT * FROM users
       ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'finops' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END, email`,
    );
  }

  upsert(user: Omit<UserRow, 'last_login_at'>): void {
    this.db.run(
      `INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, role = excluded.role,
         password_hash = excluded.password_hash`,
      user.id,
      user.email,
      user.name,
      user.role,
      user.password_hash,
      user.created_at,
    );
  }

  touchLogin(id: string, at: string): void {
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', at, id);
  }
}

export interface ReportState {
  reportId: string;
  loadTimeSec: number | null;
  refreshStatus: RefreshStatus | null;
  refreshFailureStreak: number;
  observedAt: string | null;
  source: string | null;
}

interface ReportStateRow {
  report_id: string;
  load_time_sec: number | null;
  refresh_status: RefreshStatus | null;
  refresh_failure_streak: number;
  observed_at: string | null;
  source: string | null;
}

/** Latest known operational state per report, updated by every telemetry observation. */
export class ReportStateRepository {
  private readonly cache = new Map<string, ReportState>();

  constructor(private readonly db: OpsDb) {
    for (const r of db.all<ReportStateRow>('SELECT * FROM report_state')) {
      this.cache.set(r.report_id, {
        reportId: r.report_id,
        loadTimeSec: r.load_time_sec,
        refreshStatus: r.refresh_status,
        refreshFailureStreak: r.refresh_failure_streak,
        observedAt: r.observed_at,
        source: r.source,
      });
    }
  }

  get(reportId: string): ReportState | undefined {
    return this.cache.get(reportId);
  }

  save(state: ReportState): void {
    this.cache.set(state.reportId, state);
    this.db.run(
      `INSERT INTO report_state (report_id, load_time_sec, refresh_status, refresh_failure_streak, observed_at, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(report_id) DO UPDATE SET load_time_sec = excluded.load_time_sec,
         refresh_status = excluded.refresh_status, refresh_failure_streak = excluded.refresh_failure_streak,
         observed_at = excluded.observed_at, source = excluded.source`,
      state.reportId,
      state.loadTimeSec,
      state.refreshStatus,
      state.refreshFailureStreak,
      state.observedAt,
      state.source,
    );
  }
}

interface AssignmentRow {
  id: number;
  report_id: string;
  owner_email: string;
  previous_owner_email: string | null;
  assigned_by: string;
  assigned_at: string;
  note: string | null;
}

const toAssignment = (r: AssignmentRow): OwnerAssignment => ({
  id: r.id,
  reportId: r.report_id,
  ownerEmail: r.owner_email,
  previousOwnerEmail: r.previous_owner_email,
  assignedBy: r.assigned_by,
  assignedAt: r.assigned_at,
  note: r.note,
});

export class OwnerAssignmentRepository {
  constructor(private readonly db: OpsDb) {}

  all(): OwnerAssignment[] {
    return this.db
      .all<AssignmentRow>('SELECT * FROM owner_assignments ORDER BY id')
      .map(toAssignment);
  }

  forReport(reportId: string): OwnerAssignment[] {
    return this.db
      .all<AssignmentRow>(
        'SELECT * FROM owner_assignments WHERE report_id = ? ORDER BY id DESC',
        reportId,
      )
      .map(toAssignment);
  }

  insert(a: Omit<OwnerAssignment, 'id'>): OwnerAssignment {
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO owner_assignments (report_id, owner_email, previous_owner_email, assigned_by, assigned_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      a.reportId,
      a.ownerEmail,
      a.previousOwnerEmail,
      a.assignedBy,
      a.assignedAt,
      a.note,
    );
    return { ...a, id: lastInsertRowid };
  }
}

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string;
  request_id: string | null;
}

export interface AuditInput {
  actor: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown>;
  requestId?: string | null;
}

/** Append-only record of every state-changing action: who, what, on which object, when. */
export class AuditLog {
  constructor(
    private readonly db: OpsDb,
    private readonly now: () => Date,
  ) {}

  record(entry: AuditInput): void {
    this.db.run(
      `INSERT INTO audit_log (at, actor, actor_role, action, target_type, target_id, detail, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.now().toISOString(),
      entry.actor,
      entry.actorRole,
      entry.action,
      entry.targetType,
      entry.targetId,
      JSON.stringify(entry.detail ?? {}),
      entry.requestId ?? null,
    );
  }

  list(page: number, pageSize: number, action?: string): { items: AuditEntry[]; total: number } {
    const where = action ? 'WHERE action = ?' : '';
    const params = action ? [action] : [];
    const total =
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${where}`, ...params)?.n ?? 0;
    const rows = this.db.all<AuditRow>(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    );
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actor: r.actor,
        actorRole: r.actor_role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        detail: JSON.parse(r.detail) as Record<string, unknown>,
        requestId: r.request_id,
      })),
    };
  }
}
