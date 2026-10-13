import { randomBytes } from 'node:crypto';
import type { Principal } from '../auth/principal.js';

export const TICKET_TTL_MS = 30_000;

/**
 * Browsers cannot attach an Authorization header to a WebSocket or EventSource request, and a
 * JWT in a URL ends up in access logs. So an authenticated REST call mints a ticket that is
 * random, single-use and dead in 30 seconds; the stream is opened with that instead.
 */
export class TicketStore {
  private readonly tickets = new Map<string, { principal: Principal; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(principal: Principal): string {
    this.sweep();
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { principal, expiresAt: this.now() + TICKET_TTL_MS });
    return ticket;
  }

  /** Returns the principal once; any further use of the same ticket fails. */
  consume(ticket: string | null | undefined): Principal | null {
    if (!ticket) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    return entry.expiresAt > this.now() ? entry.principal : null;
  }

  private sweep(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}
