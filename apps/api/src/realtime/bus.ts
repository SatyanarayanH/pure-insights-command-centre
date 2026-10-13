import { randomBytes } from 'node:crypto';
import type { ServerEventData, ServerEventType, Topic } from '@picc/contracts';

/** An event as held on the bus: not yet tailored to any one recipient. */
export interface BusRecord<T extends ServerEventType = ServerEventType> {
  id: number;
  ts: string;
  type: T;
  topic: Topic;
  /** Set when the event concerns one report; drives row-level filtering at delivery. */
  reportId: string | null;
  /** Who owned that report when the event was published. A recipient limited to their own
   *  reports receives the event only if this is them. Carried on the record, not looked up at
   *  delivery, so a node that holds connections but no database can still enforce it. */
  ownerEmail: string | null;
  /** The event body with nothing withheld. The renderer redacts it per recipient. */
  payload: unknown;
}

/** State to carry on from when the stream outlives the process (see RedisEventLog). */
export interface BusResume {
  streamId: string;
  lastId: number;
  records: BusRecord[];
}

type Listener = (record: BusRecord) => void;

export interface ReplayResult {
  records: BusRecord[];
  /** True when events between `afterId` and the oldest buffered event have been dropped. */
  gap: boolean;
  oldestAvailable: number;
}

/**
 * In-process event bus with a bounded replay buffer.
 *
 * Every published event gets the next integer id. Transports (WebSocket, SSE) subscribe as
 * listeners; a reconnecting client asks for everything after the last id it saw.
 *
 * On its own this serves one process. With REDIS_URL set, RedisEventLog mirrors every record
 * to a Redis Stream: the stream then outlives a restart (`resume`), and other nodes that only
 * hold connections replay it into a bus of their own (`accept`).
 */
export class EventBus {
  private readonly buffer: BusRecord[] = [];
  private readonly listeners = new Set<Listener>();
  private nextId = 1;
  /** Identifies one run of the event ids. In-process it changes on every restart, when ids
   *  start again from 1; a client resuming with an id from a previous stream must not have it
   *  compared with this one's. Backed by Redis it is stable, because the ids carry on. */
  readonly streamId: string;
  /** Looks up the current owner of a report at publish time. Set by the composition root. */
  resolveOwner: (reportId: string) => string | null = () => null;

  constructor(
    private readonly capacity = 2000,
    private readonly now: () => Date = () => new Date(),
    resume?: BusResume,
  ) {
    this.streamId = resume?.streamId ?? randomBytes(6).toString('hex');
    if (resume) {
      this.buffer.push(...resume.records.slice(-capacity));
      this.nextId = resume.lastId + 1;
    }
  }

  publish<T extends ServerEventType>(
    type: T,
    topic: Topic,
    payload: unknown,
    reportId: string | null = null,
  ): BusRecord<T> {
    const record: BusRecord<T> = {
      id: this.nextId++,
      ts: this.now().toISOString(),
      type,
      topic,
      reportId,
      ownerEmail: reportId === null ? null : this.resolveOwner(reportId),
      payload,
    };
    this.dispatch(record);
    return record;
  }

  /** Takes a record that another node published. Ignores anything already seen, so a replay
   *  that overlaps the live tail does not deliver an event twice. */
  accept(record: BusRecord): boolean {
    if (record.id <= this.latestId) return false;
    this.nextId = record.id + 1;
    this.dispatch(record);
    return true;
  }

  private dispatch(record: BusRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const listener of this.listeners) {
      // A failing transport must never stop the others from receiving the event.
      try {
        listener(record);
      } catch {
        /* isolated */
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get latestId(): number {
    return this.nextId - 1;
  }

  get size(): number {
    return this.buffer.length;
  }

  replayAfter(afterId: number): ReplayResult {
    const oldestAvailable = this.buffer[0]?.id ?? this.nextId;
    return {
      records: this.buffer.filter((record) => record.id > afterId),
      gap: afterId < oldestAvailable - 1,
      oldestAvailable,
    };
  }
}

export type { ServerEventData };
