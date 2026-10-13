import type { AnyServerEvent, RealtimeTicket, Topic } from '@picc/contracts';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export type Transport = 'websocket' | 'sse';

export interface RealtimeState {
  status: ConnectionStatus;
  transport: Transport;
  /** Round-trip time of the last application ping, WebSocket only. */
  latencyMs: number | null;
  lastEventId: number;
  reconnects: number;
}

interface Options {
  getTicket: () => Promise<RealtimeTicket>;
  onEvent: (event: AnyServerEvent) => void;
  onState: (state: RealtimeState) => void;
  topics?: Topic[];
}

const MAX_BACKOFF_MS = 30_000;
/** After this many failed WebSocket attempts in a row, use Server-Sent Events instead. */
const WS_FAILURES_BEFORE_FALLBACK = 3;
const UNAUTHORIZED = 4401;

/**
 * Client side of the real-time protocol.
 *
 *  - Authenticates each connection with a fresh single-use ticket.
 *  - Reconnects with exponential backoff and jitter, so a server restart does not bring every
 *    browser back in the same instant.
 *  - Resumes from the last event id it processed, so a dropped connection loses nothing.
 *  - Ignores an event id it has already seen (delivery is at-least-once).
 *  - Falls back from WebSocket to SSE when WebSocket cannot be established.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private source: EventSource | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private wsFailures = 0;
  private stopped = true;
  private readonly topics: Set<Topic>;
  private state: RealtimeState = {
    status: 'idle',
    transport: 'websocket',
    latencyMs: null,
    lastEventId: 0,
    reconnects: 0,
  };

  constructor(private readonly options: Options) {
    this.topics = new Set(options.topics ?? ['alerts', 'reports', 'system']);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    this.update({ status: 'closed' });
  }

  subscribe(topic: Topic): void {
    this.topics.add(topic);
    this.sendControl({ type: 'subscribe', topics: [topic] });
  }

  unsubscribe(topic: Topic): void {
    this.topics.delete(topic);
    this.sendControl({ type: 'unsubscribe', topics: [topic] });
  }

  private sendControl(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    // SSE has no client-to-server channel: the topic set takes effect on the next connect.
    else if (this.source) this.reconnectNow();
  }

  private update(patch: Partial<RealtimeState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }

  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
    this.source?.close();
    this.source = null;
  }

  private reconnectNow(): void {
    this.teardown();
    void this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.teardown();
    this.attempt += 1;
    const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1));
    // Full jitter: anywhere between half the ceiling and the ceiling.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.update({ status: 'reconnecting', reconnects: this.state.reconnects + 1 });
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.update({ status: this.attempt === 0 ? 'connecting' : 'reconnecting' });
    let ticket: RealtimeTicket;
    try {
      ticket = await this.options.getTicket();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const params = new URLSearchParams({
      ticket: ticket.ticket,
      topics: [...this.topics].join(','),
    });
    if (this.state.lastEventId > 0) params.set('lastEventId', String(this.state.lastEventId));

    if (this.wsFailures >= WS_FAILURES_BEFORE_FALLBACK) this.connectSse(ticket.ssePath, params);
    else this.connectWebSocket(ticket.wsPath, params);
  }

  private connectWebSocket(path: string, params: URLSearchParams): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}${path}?${params}`);
    this.socket = socket;
    this.update({ transport: 'websocket' });
    let opened = false;

    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as AnyServerEvent;
      if (event.type === 'connection.ready') {
        opened = true;
        this.attempt = 0;
        this.wsFailures = 0;
        this.update({ status: 'open' });
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, event.data.heartbeatIntervalMs);
        socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } else if (event.type === 'pong' && event.data.clientTs) {
        this.update({ latencyMs: Date.now() - event.data.clientTs });
      }
      this.dispatch(event);
    };
    socket.onclose = (close) => {
      if (!opened && close.code !== UNAUTHORIZED) this.wsFailures += 1;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose follows and handles it */
    };
  }

  private connectSse(path: string, params: URLSearchParams): void {
    // EventSource would reconnect by itself with the same URL, but the ticket in that URL is
    // already spent. So reconnection is handled here: close, take a new ticket, resume.
    const source = new EventSource(`${path}?${params}`);
    this.source = source;
    this.update({ transport: 'sse', latencyMs: null });
    const handle = (message: MessageEvent<string>): void => {
      const event = JSON.parse(message.data) as AnyServerEvent;
      if (event.type === 'connection.ready') {
        this.attempt = 0;
        this.update({ status: 'open' });
      }
      this.dispatch(event);
    };
    for (const type of [
      'connection.ready',
      'alert.fired',
      'alert.updated',
      'alert.resolved',
      'telemetry.observed',
      'report.owner_changed',
      'system.notice',
      'replay.gap',
    ]) {
      source.addEventListener(type, handle as EventListener);
    }
    source.onerror = () => this.scheduleReconnect();
  }

  private dispatch(event: AnyServerEvent): void {
    if (event.id > 0) {
      if (event.id <= this.state.lastEventId) return; // duplicate after a resume
      this.state = { ...this.state, lastEventId: event.id };
    }
    this.options.onEvent(event);
  }
}
