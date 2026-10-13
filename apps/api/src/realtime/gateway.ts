import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type AnyServerEvent,
  ClientMessageSchema,
  DEFAULT_TOPICS,
  PROTOCOL_VERSION,
  type ServerEventData,
  type ServerEventType,
  TOPICS,
  type Topic,
  WS_CLOSE_CODES,
  WS_PATH,
} from '@picc/contracts';
import type { Request, Response } from 'express';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Principal } from '../auth/principal.js';
import type { Logger } from '../logger.js';
import { type PresenterContext, renderForRecipient } from '../services/presenters.js';
import type { BusRecord, EventBus } from './bus.js';
import type { TicketStore } from './tickets.js';

export interface GatewayOptions {
  heartbeatIntervalMs: number;
  /** Connections older than this are closed so the client re-authenticates with a new ticket. */
  maxConnectionAgeMs: number;
  /** A client whose unsent backlog exceeds this is dropped rather than buffered without bound. */
  maxBufferedBytes: number;
  allowedOrigins: readonly string[];
  enforceOrigin: boolean;
}

export const DEFAULT_GATEWAY_OPTIONS: GatewayOptions = {
  heartbeatIntervalMs: 25_000,
  maxConnectionAgeMs: 60 * 60_000,
  maxBufferedBytes: 1_048_576,
  allowedOrigins: [],
  enforceOrigin: false,
};

interface WsConnection {
  id: string;
  socket: WebSocket;
  principal: Principal;
  topics: Set<Topic>;
  alive: boolean;
  openedAt: number;
}

interface SseConnection {
  id: string;
  res: Response;
  principal: Principal;
  topics: Set<Topic>;
}

function parseTopics(raw: string | null): Set<Topic> {
  if (!raw) return new Set(DEFAULT_TOPICS);
  const wanted = raw.split(',').map((t) => t.trim());
  const valid = TOPICS.filter((t) => wanted.includes(t));
  return new Set(valid.length ? valid : DEFAULT_TOPICS);
}

function parseEventId(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Delivers bus events to browsers over WebSocket and Server-Sent Events.
 *
 * Both transports share authentication (single-use ticket), authorisation (the presenter
 * decides per recipient), the event envelope, and resume-by-event-id. WebSocket adds a
 * client-to-server channel for heartbeats and topic subscriptions.
 */
export class RealtimeGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly ws = new Map<string, WsConnection>();
  private readonly sse = new Map<string, SseConnection>();
  private readonly unsubscribe: () => void;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly tickets: TicketStore,
    private readonly ctx: PresenterContext,
    private readonly logger: Logger,
    private readonly options: GatewayOptions = DEFAULT_GATEWAY_OPTIONS,
  ) {
    this.unsubscribe = bus.subscribe((record) => this.deliver(record));
  }

  // ---- WebSocket --------------------------------------------------------------------------

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.checkConnections(), this.options.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    // A ticket can only be minted with a bearer token, which a cross-site page does not have;
    // the Origin check is defence in depth against cross-site WebSocket hijacking.
    // The page that the API itself serves is same-origin and always allowed; anything else
    // must be on the allow-list.
    const origin = req.headers.origin;
    if (this.options.enforceOrigin && origin && !this.isAllowedOrigin(origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // The upgrade is accepted before the ticket is checked on purpose: a browser cannot read
      // the status of a refused upgrade, but it can read a close code.
      const principal = this.tickets.consume(url.searchParams.get('ticket'));
      if (!principal) {
        ws.close(WS_CLOSE_CODES.UNAUTHORIZED.code, WS_CLOSE_CODES.UNAUTHORIZED.reason);
        return;
      }
      this.onConnection(
        ws,
        principal,
        parseTopics(url.searchParams.get('topics')),
        parseEventId(url.searchParams.get('lastEventId')),
      );
    });
  }

  private isAllowedOrigin(origin: string, host: string | undefined): boolean {
    if (this.options.allowedOrigins.includes(origin)) return true;
    try {
      return host !== undefined && new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  private onConnection(
    socket: WebSocket,
    principal: Principal,
    topics: Set<Topic>,
    lastEventId: number | null,
  ): void {
    const connection: WsConnection = {
      id: randomUUID(),
      socket,
      principal,
      topics,
      alive: true,
      openedAt: Date.now(),
    };
    this.ws.set(connection.id, connection);
    this.logger.debug(
      { connectionId: connection.id, user: principal.email, lastEventId },
      'ws connected',
    );

    const send = (event: AnyServerEvent) => this.sendWs(connection, event);
    this.handshake(connection.id, principal, topics, lastEventId, send);

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (raw) => this.onMessage(connection, raw.toString()));
    socket.on('close', () => this.ws.delete(connection.id));
    socket.on('error', (error) =>
      this.logger.debug({ err: error, connectionId: connection.id }, 'ws error'),
    );
  }

  private onMessage(connection: WsConnection, raw: string): void {
    connection.alive = true;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.sendWs(
        connection,
        this.local('error', { code: 'bad_json', message: 'Message is not valid JSON.' }),
      );
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.sendWs(
        connection,
        this.local('error', {
          code: 'bad_message',
          message: 'Unknown message type or invalid fields. See the AsyncAPI document.',
        }),
      );
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'ping':
        this.sendWs(connection, this.local('pong', { clientTs: message.ts ?? null }));
        break;
      case 'subscribe':
        for (const topic of message.topics) connection.topics.add(topic);
        this.sendWs(connection, this.local('subscribed', { topics: [...connection.topics] }));
        break;
      case 'unsubscribe':
        for (const topic of message.topics) connection.topics.delete(topic);
        this.sendWs(connection, this.local('subscribed', { topics: [...connection.topics] }));
        break;
    }
  }

  private sendWs(connection: WsConnection, event: AnyServerEvent): void {
    const { socket } = connection;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > this.options.maxBufferedBytes) {
      socket.close(WS_CLOSE_CODES.SLOW_CONSUMER.code, WS_CLOSE_CODES.SLOW_CONSUMER.reason);
      return;
    }
    socket.send(JSON.stringify(event));
  }

  private checkConnections(): void {
    const now = Date.now();
    for (const connection of this.ws.values()) {
      if (!connection.alive) {
        connection.socket.close(
          WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.code,
          WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.reason,
        );
        connection.socket.terminate();
        this.ws.delete(connection.id);
        continue;
      }
      if (now - connection.openedAt > this.options.maxConnectionAgeMs) {
        connection.socket.close(
          WS_CLOSE_CODES.UNAUTHORIZED.code,
          'Session expired; reconnect with a new ticket',
        );
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
    for (const connection of this.sse.values()) connection.res.write(': keepalive\n\n');
  }

  // ---- Server-Sent Events -----------------------------------------------------------------

  handleSse = (req: Request, res: Response): void => {
    const principal = this.tickets.consume(
      typeof req.query.ticket === 'string' ? req.query.ticket : null,
    );
    if (!principal) {
      res.status(401).type('application/problem+json').json({
        type: 'https://pure-insights.example/problems/unauthorized',
        title: 'Unauthorized',
        status: 401,
        code: 'unauthorized',
        detail: 'Missing, expired or already-used ticket.',
      });
      return;
    }
    const topics = parseTopics(typeof req.query.topics === 'string' ? req.query.topics : null);
    // EventSource resends the last id it saw in this header when it reconnects on its own.
    const lastEventId = parseEventId(
      req.get('last-event-id') ??
        (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : null),
    );

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const connection: SseConnection = { id: randomUUID(), res, principal, topics };
    this.sse.set(connection.id, connection);
    this.handshake(connection.id, principal, topics, lastEventId, (event) =>
      this.sendSse(connection, event),
    );
    req.on('close', () => this.sse.delete(connection.id));
  };

  private sendSse(connection: SseConnection, event: AnyServerEvent): void {
    // Connection-scoped messages have id 0 and carry no `id:` line, so they never move the
    // browser's Last-Event-ID backwards.
    const idLine = event.id > 0 ? `id: ${event.id}\n` : '';
    connection.res.write(`${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  // ---- shared -----------------------------------------------------------------------------

  private local<T extends ServerEventType>(type: T, data: ServerEventData<T>): AnyServerEvent {
    return {
      v: PROTOCOL_VERSION,
      id: 0,
      type,
      ts: new Date().toISOString(),
      data,
    } as AnyServerEvent;
  }

  /** Greets a new connection and replays whatever it missed while it was away. */
  private handshake(
    connectionId: string,
    principal: Principal,
    topics: Set<Topic>,
    lastEventId: number | null,
    send: (event: AnyServerEvent) => void,
  ): void {
    const replay = lastEventId === null ? null : this.bus.replayAfter(lastEventId);
    const missed = (replay?.records ?? [])
      .map((record) => renderForRecipient(record, principal, topics, this.ctx))
      .filter((event): event is AnyServerEvent => event !== null);

    send(
      this.local('connection.ready', {
        connectionId,
        protocolVersion: PROTOCOL_VERSION,
        user: { email: principal.email, role: principal.role, scope: principal.scope },
        topics: [...topics],
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        latestEventId: this.bus.latestId,
        resumedFrom: lastEventId,
        replayed: missed.length,
      }),
    );
    if (replay?.gap) {
      send(
        this.local('replay.gap', {
          requestedFrom: lastEventId ?? 0,
          oldestAvailable: replay.oldestAvailable,
          message: 'Some events are no longer buffered. Refetch current state over REST.',
        }),
      );
    }
    for (const event of missed) send(event);
  }

  private deliver(record: BusRecord): void {
    for (const connection of this.ws.values()) {
      const event = renderForRecipient(record, connection.principal, connection.topics, this.ctx);
      if (event) this.sendWs(connection, event);
    }
    for (const connection of this.sse.values()) {
      const event = renderForRecipient(record, connection.principal, connection.topics, this.ctx);
      if (event) this.sendSse(connection, event);
    }
  }

  stats(): { webSocketClients: number; sseClients: number } {
    return { webSocketClients: this.ws.size, sseClients: this.sse.size };
  }

  close(): void {
    this.unsubscribe();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const connection of this.ws.values()) {
      connection.socket.close(
        WS_CLOSE_CODES.SERVER_SHUTDOWN.code,
        WS_CLOSE_CODES.SERVER_SHUTDOWN.reason,
      );
    }
    for (const connection of this.sse.values()) connection.res.end();
    this.ws.clear();
    this.sse.clear();
    this.wss.close();
  }
}
