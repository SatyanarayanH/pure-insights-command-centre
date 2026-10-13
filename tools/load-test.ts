/**
 * Load test: many browsers connected, telemetry arriving fast. Measures what an operator would
 * ask about: does every event reach every connected client, how late, and what does ingest
 * cost the emitter.
 *
 *   npm run load-test -- --clients 300 --rate 200 --duration 30
 *
 * Needs a running server in demo mode (the test signs in as the demo admin and uses the ingest
 * key). Start it with the rate limit raised, or the test itself is throttled:
 *
 *   RATE_LIMIT_PER_MIN=1000000 SIMULATOR_ENABLED=false LOG_LEVEL=warn npm start
 *
 * Results go to stdout and, with --out, to a Markdown file.
 */
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4000' },
    /** Where the stream is served, if not the same place. Comma-separated for several edges. */
    'ws-url': { type: 'string' },
    clients: { type: 'string', default: '100' },
    rate: { type: 'string', default: '100' },
    duration: { type: 'string', default: '20' },
    batch: { type: 'string', default: '20' },
    'api-key': { type: 'string', default: 'demo-ingest-key-change-me' },
    email: { type: 'string', default: 'admin@company.com' },
    label: { type: 'string', default: '' },
    out: { type: 'string' },
  },
});

const base = args.url.replace(/\/$/, '');
// One or more places the stream is served from; clients are spread across them in turn.
const wsBases = (args['ws-url'] ?? base)
  .split(',')
  .map((url) => url.trim().replace(/^http/, 'ws').replace(/\/$/, ''));
const CLIENTS = Number(args.clients);
const RATE = Number(args.rate);
const DURATION_S = Number(args.duration);
const BATCH = Number(args.batch);
/** Clients whose every message is parsed to measure delay. The rest only count. */
const PROBES = Math.min(10, CLIENTS);

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const summarise = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  };
};
const ms = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value.toFixed(value < 10 ? 1 : 0)} ms`;

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

// ---- sign in and find out what there is to send telemetry about -----------------------------
const { accessToken } = await json<{ accessToken: string }>('/api/v1/auth/demo-login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: args.email }),
});
const bearer = { authorization: `Bearer ${accessToken}` };
const reports = (
  await json<{ items: { reportId: string }[] }>('/api/v1/reports?pageSize=500', { headers: bearer })
).items.map((r) => r.reportId);

// ---- connect the clients ---------------------------------------------------------------------
interface Client {
  socket: WebSocket;
  telemetry: number;
  messages: number;
}
const clients: Client[] = [];
const pushLagMs: number[] = [];
let measuring = false;

async function openClient(index: number): Promise<void> {
  const { ticket } = await json<{ ticket: string }>('/api/v1/realtime/ticket', {
    method: 'POST',
    headers: bearer,
  });
  const socket = new WebSocket(
    `${wsBases[index % wsBases.length]}/ws?ticket=${ticket}&topics=alerts,telemetry,system`,
  );
  const client: Client = { socket, telemetry: 0, messages: 0 };
  const probe = index < PROBES;
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('message', () => resolve());
  });
  socket.on('message', (raw) => {
    if (!measuring) return;
    const text = raw.toString();
    client.messages += 1;
    if (!text.includes('"type":"telemetry.observed"')) return;
    client.telemetry += 1;
    if (probe) {
      const { ts } = JSON.parse(text) as { ts: string };
      pushLagMs.push(Date.now() - Date.parse(ts));
    }
  });
  socket.on('error', () => undefined);
  clients.push(client);
}

const connectStarted = performance.now();
for (let i = 0; i < CLIENTS; i += 25) {
  await Promise.all(Array.from({ length: Math.min(25, CLIENTS - i) }, (_, j) => openClient(i + j)));
}
const connectMs = performance.now() - connectStarted;
console.log(`${clients.length} clients connected in ${Math.round(connectMs)} ms`);

// ---- send telemetry at a fixed rate ----------------------------------------------------------
const ingestMs: number[] = [];
const totals = { sent: 0, accepted: 0, rejected: 0, duplicates: 0, alertsFired: 0, failed: 0 };
const inFlight = new Set<Promise<void>>();
let sequence = 0;
const runId = Date.now().toString(36);

function makeEvent(): Record<string, unknown> {
  sequence += 1;
  const roll = Math.random();
  return {
    reportId: reports[Math.floor(Math.random() * reports.length)],
    eventId: `load-${runId}-${sequence}`,
    // Mostly healthy, with the slow tail and failure rate that make the alert engine work.
    loadTimeSec:
      Math.round((roll < 0.7 ? 2 + Math.random() * 12 : 15 + Math.random() * 40) * 10) / 10,
    refreshStatus: Math.random() < 0.08 ? 'FAILED' : 'SUCCESS',
  };
}

function post(events: Record<string, unknown>[]): void {
  const started = performance.now();
  totals.sent += events.length;
  const request = fetch(`${base}/api/v1/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': args['api-key'] },
    body: JSON.stringify({ events }),
  })
    .then(async (response) => {
      ingestMs.push(performance.now() - started);
      if (!response.ok) {
        totals.failed += events.length;
        return;
      }
      const body = (await response.json()) as {
        accepted: number;
        duplicates: number;
        rejected: unknown[];
        alertsFired: number;
      };
      totals.accepted += body.accepted;
      totals.duplicates += body.duplicates;
      totals.rejected += body.rejected.length;
      totals.alertsFired += body.alertsFired;
    })
    .catch(() => {
      totals.failed += events.length;
    })
    .finally(() => inFlight.delete(request));
  inFlight.add(request);
}

// A scrape resets the server's event-loop histogram, so it covers this run and not start-up.
await fetch(`${base}/metrics`).catch(() => undefined);
measuring = true;
const TICK_MS = 100;
const started = performance.now();
let owed = 0;
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    const elapsed = performance.now() - started;
    if (elapsed >= DURATION_S * 1000) {
      clearInterval(timer);
      resolve();
      return;
    }
    // Send what the schedule says should have gone by now, so a slow tick does not lower the rate.
    owed = Math.floor((elapsed / 1000) * RATE) - sequence;
    while (owed > 0) {
      const size = Math.min(BATCH, owed);
      post(Array.from({ length: size }, makeEvent));
      owed -= size;
    }
  }, TICK_MS);
});
await Promise.all(inFlight);
const sendSeconds = (performance.now() - started) / 1000;

// Give the last events time to arrive, up to five seconds.
const expected = totals.accepted;
for (let waited = 0; waited < 5000; waited += 100) {
  if (clients.every((c) => c.telemetry >= expected)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
measuring = false;

// ---- the server's own view, from its metrics endpoint ----------------------------------------
const metricsText = await fetch(`${base}/metrics`)
  .then((r) => (r.ok ? r.text() : ''))
  .catch(() => '');
const metric = (line: string): number | null => {
  const found = metricsText.split('\n').find((l) => l.startsWith(`${line} `));
  return found ? Number(found.slice(line.length + 1)) : null;
};

for (const client of clients) client.socket.close();

const delivered = clients.map((c) => c.telemetry);
// At least, not exactly: with the built-in simulator running, clients see its events too.
const complete = delivered.filter((n) => n >= expected).length;
const stillOpen = clients.filter((c) => c.socket.readyState <= WebSocket.CLOSING).length;
const ingest = summarise(ingestMs);
const lag = summarise(pushLagMs);
const totalMessages = clients.reduce((a, c) => a + c.messages, 0);

const rows: [string, string][] = [
  ['Connected clients', `${clients.length} WebSocket (${stillOpen} still open at the end)`],
  ['Target rate', `${RATE} events/s for ${DURATION_S} s, ${BATCH} per request`],
  [
    'Events sent',
    `${totals.sent.toLocaleString()} (${Math.round(totals.sent / sendSeconds)}/s achieved)`,
  ],
  [
    'Events accepted',
    `${totals.accepted.toLocaleString()} · ${totals.rejected} rejected · ${totals.duplicates} duplicates · ${totals.failed} failed requests`,
  ],
  ['Alerts opened', totals.alertsFired.toLocaleString()],
  [
    'Ingest request time',
    `p50 ${ms(ingest.p50)} · p95 ${ms(ingest.p95)} · p99 ${ms(ingest.p99)} · max ${ms(ingest.max)}`,
  ],
  [
    'Messages pushed',
    `${totalMessages.toLocaleString()} in total (${Math.round(totalMessages / sendSeconds).toLocaleString()}/s)`,
  ],
  [
    'Delivery',
    `${complete} of ${clients.length} clients received all ${expected.toLocaleString()} telemetry events (fewest ${Math.min(...delivered).toLocaleString()})`,
  ],
  [
    'Push delay, publish to client',
    `p50 ${ms(lag.p50)} · p95 ${ms(lag.p95)} · p99 ${ms(lag.p99)} · max ${ms(lag.max)}`,
  ],
  [
    'Server event-loop delay',
    metric('picc_event_loop_lag_seconds{quantile="0.99"}') === null
      ? 'not available'
      : `p99 ${ms((metric('picc_event_loop_lag_seconds{quantile="0.99"}') ?? 0) * 1000)} · max ${ms((metric('picc_event_loop_lag_seconds{quantile="1"}') ?? 0) * 1000)}`,
  ],
  [
    'Server memory',
    metric('picc_process_resident_memory_bytes') === null
      ? 'not available'
      : `${Math.round((metric('picc_process_resident_memory_bytes') ?? 0) / 1_048_576)} MB resident`,
  ],
];

const table = [
  '| Measure | Result |',
  '| --- | --- |',
  ...rows.map(([k, v]) => `| ${k} | ${v} |`),
].join('\n');
const heading = `### ${args.label || `${CLIENTS} clients, ${RATE} events/s`}`;
console.log(`\n${heading}\n\n${table}\n`);

if (args.out) {
  const cpu = cpus();
  writeFileSync(
    args.out,
    [
      heading,
      '',
      `Run at ${new Date().toISOString()} on ${cpu[0]?.model ?? 'unknown CPU'} (${cpu.length} cores, ${Math.round(totalmem() / 1_073_741_824)} GB), Node ${process.version}. Load generator and server on the same machine.`,
      '',
      table,
      '',
    ].join('\n'),
  );
}
process.exit(complete === clients.length && totals.failed === 0 ? 0 : 1);
