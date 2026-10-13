import { randomBytes } from 'node:crypto';
import type { Permission } from '@picc/contracts';
import type { Principal } from '../auth/principal.js';

export const TICKET_TTL_MS = 30_000;

/**
 * Browsers cannot attach an Authorization header to a WebSocket or EventSource request, and a
 * JWT in a URL ends up in access logs. So an authenticated REST call mints a ticket that is
 * random, single-use and dead in 30 seconds; the stream is opened with that instead.
 *
 * The interface is asynchronous because the ticket may be minted by one node and redeemed on
 * another, in which case it lives in Redis (RedisTicketStore).
 */
export interface TicketStore {
  issue(principal: Principal): Promise<string>;
  /** Returns the principal once; any further use of the same ticket fails. */
  consume(ticket: string | null | undefined): Promise<Principal | null>;
}

export const newTicket = (): string => randomBytes(24).toString('base64url');

/** A principal as it travels between nodes. */
export const encodePrincipal = (principal: Principal): string =>
  JSON.stringify({ ...principal, permissions: [...principal.permissions] });

export function decodePrincipal(raw: string): Principal {
  const parsed = JSON.parse(raw) as Omit<Principal, 'permissions'> & { permissions: Permission[] };
  return { ...parsed, permissions: new Set(parsed.permissions) };
}

export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, { principal: Principal; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async issue(principal: Principal): Promise<string> {
    this.sweep();
    const ticket = newTicket();
    this.tickets.set(ticket, { principal, expiresAt: this.now() + TICKET_TTL_MS });
    return ticket;
  }

  async consume(ticket: string | null | undefined): Promise<Principal | null> {
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
