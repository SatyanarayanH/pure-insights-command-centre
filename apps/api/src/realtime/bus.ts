import type { ServerEventData, ServerEventType, Topic } from '@picc/contracts';

/** An event as held on the bus: not yet tailored to any one recipient. */
export interface BusRecord<T extends ServerEventType = ServerEventType> {
  id: number;
  ts: string;
  type: T;
  topic: Topic;
  /** Set when the event concerns one report; drives row-level filtering at delivery. */
  reportId: string | null;
  /** Internal payload. The gateway's renderer turns it into the wire shape per recipient. */
  payload: unknown;
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
 * Scale-out: this class is the seam. Behind a load balancer, `publish` would write to Redis
 * Streams (or SNS + per-node SQS) and each node would run `deliver` from its consumer; ids
 * would become the stream offsets. Nothing else in the codebase would change.
 */
export class EventBus {
  private readonly buffer: BusRecord[] = [];
  private readonly listeners = new Set<Listener>();
  private nextId = 1;

  constructor(
    private readonly capacity = 2000,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      payload,
    };
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
    return record;
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
