import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Principal } from '../auth/principal.js';
import type { BusRecord, BusResume, EventBus } from './bus.js';
import {
  decodePrincipal,
  encodePrincipal,
  newTicket,
  TICKET_TTL_MS,
  type TicketStore,
} from './tickets.js';

/** Entries kept in the stream. Larger than any node's replay buffer. */
const STREAM_MAX_LENGTH = 10_000;
/** Every key is namespaced, so several environments can share one Redis. */
export const DEFAULT_REDIS_PREFIX = 'picc';

export function connectRedis(url: string): Redis {
  return new Redis(url, {
    // Commands issued while Redis is unreachable fail fast instead of queueing without bound;
    // the callers below decide what a failure means for them.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
}

/** Resolves once the connection is usable, or rejects if Redis cannot be reached in time. */
export function whenReady(redis: Redis, timeoutMs = 5000): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Redis was not reachable within ${timeoutMs} ms.`)),
      timeoutMs,
    );
    redis.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Tickets in Redis, so the node that mints a ticket (it has the database and can check the
 * bearer token) need not be the node that redeems it (it holds the connection).
 *
 * The principal travels inside the ticket. GETDEL reads and deletes in one step, which is what
 * makes "single use" hold when two nodes are handed the same ticket at the same instant.
 */
export class RedisTicketStore implements TicketStore {
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: Redis,
    prefix = DEFAULT_REDIS_PREFIX,
  ) {
    this.keyPrefix = `${prefix}:ticket:`;
  }

  async issue(principal: Principal): Promise<string> {
    const ticket = newTicket();
    await this.redis.set(this.keyPrefix + ticket, encodePrincipal(principal), 'PX', TICKET_TTL_MS);
    return ticket;
  }

  async consume(ticket: string | null | undefined): Promise<Principal | null> {
    // The ticket comes from a URL and becomes part of a key: accept only what `issue` produces.
    if (!ticket || !/^[A-Za-z0-9_-]{16,64}$/.test(ticket)) return null;
    const raw = await this.redis.getdel(this.keyPrefix + ticket);
    return raw ? decodePrincipal(raw) : null;
  }
}

/**
 * The event stream in Redis.
 *
 * One node (the core: it owns the database and decides what happened) publishes. Its in-process
 * bus stays the source of event ids; every record is mirrored to a Redis Stream under the id
 * `<n>-0`. Two things follow:
 *
 *   - the stream outlives the process. After a restart the core loads the tail and carries on
 *     numbering where it stopped, so a browser that reconnects resumes with no gap;
 *   - any number of edge nodes, which hold connections and nothing else, follow the stream
 *     into a bus of their own and deliver from it.
 */
export class RedisEventLog {
  private stopped = false;
  private reader: Redis | null = null;
  /** Records that could not be written to Redis. Edge nodes will not have received them. */
  mirrorFailures = 0;
  private readonly streamKey: string;
  private readonly streamIdKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly onError: (error: unknown, what: string) => void = () => undefined,
    prefix = DEFAULT_REDIS_PREFIX,
    /** How long one blocking read waits before checking that the stream is still the same. */
    private readonly blockMs = 5000,
  ) {
    this.streamKey = `${prefix}:events`;
    this.streamIdKey = `${prefix}:events:stream-id`;
  }

  /** The stream as it stands: its identity, the last id issued and the most recent records. */
  async load(capacity: number): Promise<BusResume> {
    await this.redis.set(this.streamIdKey, randomBytes(6).toString('hex'), 'NX');
    const streamId = (await this.redis.get(this.streamIdKey)) ?? '';
    const tail = await this.redis.xrevrange(this.streamKey, '+', '-', 'COUNT', capacity);
    const records = tail.reverse().map(([, fields]) => JSON.parse(fields[1]!) as BusRecord);
    return { streamId, lastId: records.at(-1)?.id ?? 0, records };
  }

  /** Core: copy everything the bus publishes into the stream. */
  mirror(bus: EventBus): () => void {
    return bus.subscribe((record) => {
      this.redis
        .xadd(
          this.streamKey,
          'MAXLEN',
          '~',
          STREAM_MAX_LENGTH,
          `${record.id}-0`,
          'r',
          JSON.stringify(record),
        )
        .catch((error: unknown) => {
          this.mirrorFailures += 1;
          this.onError(error, 'mirror');
        });
    });
  }

  /**
   * Edge: feed the bus from the stream until `stop`. Uses a connection of its own, because a
   * blocking read holds the connection it is issued on.
   *
   * If the stream's identity changes under a running edge (Redis lost its data and the core
   * began a new stream), the ids this node holds mean nothing any more. `onReset` is called
   * and the node should exit and let its supervisor start it clean.
   */
  follow(bus: EventBus, onReset: () => void): void {
    const reader = this.redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    this.reader = reader;
    reader.on('error', (error) => this.onError(error, 'follow'));
    const loop = async (): Promise<void> => {
      let cursor = `${bus.latestId}-0`;
      while (!this.stopped) {
        try {
          const batches = await reader.xread(
            'COUNT',
            500,
            'BLOCK',
            this.blockMs,
            'STREAMS',
            this.streamKey,
            cursor,
          );
          if (!batches) {
            const current = await reader.get(this.streamIdKey);
            if (current !== null && current !== bus.streamId) {
              onReset();
              return;
            }
            continue;
          }
          for (const [, entries] of batches) {
            for (const [id, fields] of entries) {
              bus.accept(JSON.parse(fields[1]!) as BusRecord);
              cursor = id;
            }
          }
        } catch (error) {
          if (this.stopped) return;
          this.onError(error, 'follow');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    this.reader?.disconnect();
  }
}
