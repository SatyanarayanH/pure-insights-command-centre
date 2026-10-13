import {
  type Notification,
  SEVERITY_RANK,
  type ServerEventType,
  type Severity,
} from '@picc/contracts';
import type { Logger } from '../logger.js';
import type { OpsDb } from '../opsdb/db.js';
import type { BusRecord, EventBus } from '../realtime/bus.js';
import type { AlertPayload, PresenterContext } from '../services/presenters.js';

export const ADMIN_RECIPIENT = 'platform-admins';
/** Notifications older than this are deleted, unless still waiting to be delivered. */
const KEEP_DAYS = 30;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 15 * 60_000;
/** This many notifications due together are sent as one message instead of one each. */
const DIGEST_FROM = 4;
const DIGEST_MAX = 20;

export interface NotificationOptions {
  /** Where notifications are POSTed. Null: they are recorded and marked `skipped`. */
  webhookUrl: string | null;
  /** `slack` posts `{ text }`, which Slack, Teams and Mattermost incoming webhooks accept. */
  format: 'slack' | 'json';
  /** Alerts below this severity stay on the dashboard and notify nobody. */
  minSeverity: Severity;
  /** A notified alert still unacknowledged after this long goes to the platform admins. */
  escalateAfterMin: number;
  timeoutMs: number;
  maxAttempts: number;
  /** How long a new notification waits for others to join it before delivery starts. */
  batchWindowMs: number;
  fetch: typeof fetch;
}

export const DEFAULT_NOTIFICATION_OPTIONS: NotificationOptions = {
  webhookUrl: null,
  format: 'slack',
  minSeverity: 'high',
  escalateAfterMin: 15,
  timeoutMs: 5000,
  maxAttempts: 5,
  batchWindowMs: 2000,
  fetch: (...args) => fetch(...args),
};

interface NotificationRow {
  id: number;
  dedupe_key: string;
  kind: Notification['kind'];
  alert_id: string | null;
  episode: number;
  report_id: string | null;
  severity: Severity | null;
  recipient: string;
  title: string;
  body: string;
  channel: Notification['channel'];
  status: Notification['status'];
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string | null;
  sent_at: string | null;
}

interface NewNotification {
  dedupeKey: string;
  kind: Notification['kind'];
  alertId?: string;
  episode?: number;
  reportId?: string;
  severity: Severity | null;
  recipient: string;
  title: string;
  body: string;
}

const toDto = (r: NotificationRow): Notification => ({
  id: r.id,
  kind: r.kind,
  alertId: r.alert_id,
  reportId: r.report_id,
  severity: r.severity,
  recipient: r.recipient,
  title: r.title,
  body: r.body,
  channel: r.channel,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at,
  sentAt: r.sent_at,
});

const ALERT_EVENTS: ReadonlySet<ServerEventType> = new Set([
  'alert.fired',
  'alert.updated',
  'alert.resolved',
]);

/**
 * Tells people about alerts when they are not looking at the dashboard.
 *
 * Deciding to notify and delivering are separate steps joined by a table (an outbox). The
 * decision is a row written the moment the alert event happens; delivery reads rows and
 * retries with backoff. A crash, a restart or a webhook outage between the two loses nothing,
 * and the unique `dedupe_key` means the same thing is never announced twice.
 *
 * What gets announced, per alert and per time it opens:
 *   fired / reopened   once, at or above the minimum severity, unless snoozed or flapping
 *   escalated          once per severity reached
 *   unacknowledged     once, to the admins, if nobody acknowledges it in time
 *   resolved           once, and only if the opening was announced
 *
 * A burst is delivered as one digest message rather than one message each, so an incident that
 * touches fifty reports does not bury the channel it is meant to alert.
 */
export class NotificationService {
  private readonly unsubscribe: () => void;
  private flushing: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: OpsDb,
    bus: EventBus,
    private readonly ctx: PresenterContext,
    private readonly logger: Logger,
    private readonly options: NotificationOptions,
  ) {
    this.unsubscribe = bus.subscribe((record) => this.onEvent(record));
  }

  get channel(): Notification['channel'] {
    return this.options.webhookUrl ? 'webhook' : 'none';
  }

  get policy(): { minSeverity: Severity; escalateAfterMin: number } {
    return {
      minSeverity: this.options.minSeverity,
      escalateAfterMin: this.options.escalateAfterMin,
    };
  }

  private onEvent(record: BusRecord): void {
    if (!ALERT_EVENTS.has(record.type)) return;
    const { alert, change } = record.payload as AlertPayload;
    const kind =
      record.type === 'alert.fired'
        ? 'fired'
        : record.type === 'alert.resolved'
          ? 'resolved'
          : change === 'escalated' || change === 'reopened'
            ? change
            : null;
    if (!kind) return;

    if (kind === 'resolved') {
      // Only close a loop that was opened: nobody wants "resolved" for something they were
      // never told about.
      if (!this.announced(alert.id, alert.reopenCount)) return;
    } else {
      if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[this.options.minSeverity]) return;
      if (alert.snoozedUntil) return;
      if (kind === 'reopened' && alert.isFlapping) return;
    }

    const label = kind === 'resolved' ? 'RESOLVED' : alert.severity.toUpperCase();
    const context = [
      // A resolved alert still carries the message of its last breach.
      kind === 'resolved' ? `Cleared. It had been open for: ${alert.message}` : alert.message,
      `Report: ${alert.reportName} (${alert.reportId})`,
      alert.routing.ownerEmail
        ? `Owner: ${alert.routing.ownerEmail}`
        : 'Owner: none, routed to platform admins',
      ...(alert.reopenCount > 0 && kind !== 'resolved'
        ? [`Reopened ${alert.reopenCount} time(s)`]
        : []),
    ];
    this.enqueue({
      dedupeKey:
        kind === 'escalated'
          ? `${alert.id}:escalated:${alert.reopenCount}:${alert.severity}`
          : `${alert.id}:${kind}:${alert.reopenCount}`,
      kind,
      alertId: alert.id,
      episode: alert.reopenCount,
      reportId: alert.reportId,
      severity: alert.severity,
      recipient: alert.routing.ownerEmail ?? ADMIN_RECIPIENT,
      title: `[${label}] ${alert.ruleName}: ${alert.reportName}`,
      body: context.join('\n'),
    });
  }

  private announced(alertId: string, episode: number): boolean {
    return (
      this.db.get(
        `SELECT 1 AS found FROM notifications WHERE alert_id = ? AND episode = ? AND kind <> 'resolved' LIMIT 1`,
        alertId,
        episode,
      ) !== undefined
    );
  }

  /** A notification about the system itself, not about one alert. Goes to the admins. */
  enqueueSystem(
    kind: 'feed_silent' | 'feed_recovered' | 'warehouse_refresh_failed',
    dedupeKey: string,
    title: string,
    body: string,
  ): void {
    this.enqueue({
      dedupeKey: `system:${kind}:${dedupeKey}`,
      kind,
      severity: kind === 'feed_recovered' ? 'info' : 'high',
      recipient: ADMIN_RECIPIENT,
      title,
      body,
    });
  }

  private enqueue(n: NewNotification): void {
    const now = this.ctx.now().toISOString();
    const deliverable = this.options.webhookUrl !== null;
    const { changes } = this.db.run(
      `INSERT INTO notifications (dedupe_key, kind, alert_id, episode, report_id, severity, recipient, title,
         body, channel, status, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
      n.dedupeKey,
      n.kind,
      n.alertId ?? null,
      n.episode ?? 0,
      n.reportId ?? null,
      n.severity,
      n.recipient,
      n.title,
      n.body,
      this.channel,
      deliverable ? 'pending' : 'skipped',
      now,
      deliverable ? now : null,
    );
    // Delivery happens off the path that produced the event: ingest never waits on a webhook.
    // The short wait lets a burst collect into one digest.
    if (changes > 0 && deliverable && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.options.batchWindowMs);
      this.flushTimer.unref();
    }
  }

  /**
   * Periodic work: escalate what nobody has taken, retry what is due, drop what is old.
   * Returns the number of escalations raised.
   */
  sweep(): number {
    const now = this.ctx.now();
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - this.options.escalateAfterMin * 60_000).toISOString();
    const overdue = this.db.all<{
      id: string;
      report_id: string;
      rule_id: string;
      severity: Severity;
      message: string;
      reopen_count: number;
      notified_at: string;
    }>(
      `SELECT a.id, a.report_id, a.rule_id, a.severity, a.message, a.reopen_count, MIN(n.created_at) AS notified_at
       FROM alerts a
       JOIN notifications n ON n.alert_id = a.id AND n.episode = a.reopen_count
       WHERE a.status = 'firing'
         AND n.kind IN ('fired', 'reopened', 'escalated')
         AND (a.snoozed_until IS NULL OR a.snoozed_until <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM notifications u
           WHERE u.alert_id = a.id AND u.episode = a.reopen_count AND u.kind = 'unacknowledged')
       GROUP BY a.id
       HAVING MIN(n.created_at) <= ?`,
      nowIso,
      cutoff,
    );
    for (const alert of overdue) {
      const owner = this.ctx.ownership.ownerOf(alert.report_id).email;
      const rule = this.ctx.rules().find((r) => r.id === alert.rule_id)?.name ?? alert.rule_id;
      const minutes = Math.round((now.getTime() - Date.parse(alert.notified_at)) / 60_000);
      this.enqueue({
        dedupeKey: `${alert.id}:unacknowledged:${alert.reopen_count}`,
        kind: 'unacknowledged',
        alertId: alert.id,
        episode: alert.reopen_count,
        reportId: alert.report_id,
        severity: alert.severity,
        recipient: ADMIN_RECIPIENT,
        title: `[UNACKNOWLEDGED] ${rule}: ${this.ctx.reportName(alert.report_id)}`,
        body: [
          `Nobody has acknowledged this ${alert.severity} alert for ${minutes} minutes.`,
          alert.message,
          `Report: ${this.ctx.reportName(alert.report_id)} (${alert.report_id})`,
          owner ? `Owner: ${owner}` : 'Owner: none',
        ].join('\n'),
      });
    }

    this.db.run(
      `DELETE FROM notifications WHERE status <> 'pending' AND created_at < ?`,
      new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString(),
    );
    if (this.options.webhookUrl) void this.flush();
    return overdue.length;
  }

  /** Delivers everything that is due. One run at a time; callers share it. */
  flush(): Promise<void> {
    this.flushing ??= this.deliverDue()
      .catch((error: unknown) =>
        this.logger.error({ err: error }, 'notification delivery run failed'),
      )
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private async deliverDue(): Promise<void> {
    const url = this.options.webhookUrl;
    if (!url) return;
    for (;;) {
      const due = this.db.all<NotificationRow>(
        `SELECT * FROM notifications WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`,
        this.ctx.now().toISOString(),
        DIGEST_MAX,
      );
      if (due.length === 0) return;
      if (due.length >= DIGEST_FROM) await this.deliver(due, url);
      else for (const row of due) await this.deliver([row], url);
    }
  }

  private payload(rows: readonly NotificationRow[]): unknown {
    const structured = (row: NotificationRow) => ({
      ...toDto(row),
      status: undefined,
      attempts: undefined,
      lastError: undefined,
    });
    if (rows.length === 1) {
      const row = rows[0]!;
      return this.options.format === 'slack'
        ? { text: `*${row.title}*\n${row.body}` }
        : structured(row);
    }
    return this.options.format === 'slack'
      ? {
          text: [
            `*${rows.length} alert notifications*`,
            ...rows.map((row) => `• ${row.title} — ${row.body.split('\n')[0]} (${row.recipient})`),
          ].join('\n'),
        }
      : { digest: true, count: rows.length, notifications: rows.map(structured) };
  }

  /** One POST for one notification, or for a digest of several. They succeed or fail together. */
  private async deliver(rows: readonly NotificationRow[], url: string): Promise<void> {
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => '?').join(', ');
    try {
      const response = await this.options.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.payload(rows)),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!response.ok) throw new Error(`The webhook answered HTTP ${response.status}`);
      this.db.run(
        `UPDATE notifications SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = ?,
           next_attempt_at = NULL WHERE id IN (${marks})`,
        this.ctx.now().toISOString(),
        ...ids,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const row of rows) {
        const attempts = row.attempts + 1;
        const gaveUp = attempts >= this.options.maxAttempts;
        const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS);
        this.db.run(
          'UPDATE notifications SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
          gaveUp ? 'failed' : 'pending',
          attempts,
          message.slice(0, 300),
          gaveUp ? null : new Date(this.ctx.now().getTime() + delay).toISOString(),
          row.id,
        );
      }
      // The URL is a credential for most webhook providers, so it is never logged.
      this.logger.warn(
        { notifications: ids.length, reason: message },
        'notification delivery failed',
      );
    }
  }

  list(
    page: number,
    pageSize: number,
    status?: Notification['status'],
  ): { items: Notification[]; total: number } {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    return {
      total:
        this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications ${where}`, ...params)
          ?.n ?? 0,
      items: this.db
        .all<NotificationRow>(
          `SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
          ...params,
          pageSize,
          (page - 1) * pageSize,
        )
        .map(toDto),
    };
  }

  stats(): Record<Notification['status'], number> {
    const stats = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const row of this.db.all<{ status: Notification['status']; n: number }>(
      'SELECT status, COUNT(*) AS n FROM notifications GROUP BY status',
    )) {
      stats[row.status] = row.n;
    }
    return stats;
  }

  close(): void {
    this.unsubscribe();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}
