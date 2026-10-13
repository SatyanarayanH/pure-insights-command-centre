import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * Operational store: users, sessions, alerts, ownership assignments, audit log.
 *
 * SQLite through Node's built-in driver keeps the project free of native add-ons, so
 * `npm install` works on any machine. In production this is the role of Postgres/RDS; the
 * repositories are the only code that would change.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  family_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS report_state (
  report_id               TEXT PRIMARY KEY,
  load_time_sec           REAL,
  refresh_status          TEXT,
  refresh_failure_streak  INTEGER NOT NULL DEFAULT 0,
  observed_at             TEXT,
  source                  TEXT
);

CREATE TABLE IF NOT EXISTS owner_assignments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id             TEXT NOT NULL,
  owner_email           TEXT NOT NULL,
  previous_owner_email  TEXT,
  assigned_by           TEXT NOT NULL,
  assigned_at           TEXT NOT NULL,
  note                  TEXT
);
CREATE INDEX IF NOT EXISTS owner_assignments_report ON owner_assignments(report_id, id);

CREATE TABLE IF NOT EXISTS alert_rules (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL,
  enabled             INTEGER NOT NULL,
  in_brief            INTEGER NOT NULL,
  warning_threshold   REAL,
  high_threshold      REAL,
  critical_threshold  REAL,
  escalate_after      INTEGER,
  resolve_after       INTEGER NOT NULL,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id                  TEXT PRIMARY KEY,
  fingerprint         TEXT NOT NULL,
  rule_id             TEXT NOT NULL,
  report_id           TEXT NOT NULL,
  severity            TEXT NOT NULL,
  status              TEXT NOT NULL,
  message             TEXT NOT NULL,
  value               REAL,
  threshold           REAL,
  unit                TEXT,
  occurrences         INTEGER NOT NULL,
  reopen_count        INTEGER NOT NULL DEFAULT 0,
  ok_streak           INTEGER NOT NULL DEFAULT 0,
  obs_since_resolved  INTEGER NOT NULL DEFAULT 0,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  resolved_at         TEXT,
  acknowledged_by     TEXT,
  acknowledged_at     TEXT,
  ack_note            TEXT,
  snoozed_until       TEXT,
  source              TEXT NOT NULL,
  seq                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_fingerprint ON alerts(fingerprint, seq);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS alerts_report ON alerts(report_id);

CREATE TABLE IF NOT EXISTS alert_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id  TEXT NOT NULL REFERENCES alerts(id),
  type      TEXT NOT NULL,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  severity  TEXT,
  value     REAL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS alert_events_alert ON alert_events(alert_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  actor_role   TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  detail       TEXT NOT NULL,
  request_id   TEXT
);
`;

export type SqlValue = SQLInputValue;

export class OpsDb {
  private readonly db: DatabaseSync;
  /** Prepared statements, keyed by SQL text: the hot paths run the same few thousands of times. */
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  /** Runs `fn` atomically: everything it writes commits together or not at all. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
