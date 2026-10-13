/**
 * Proves the scale-out stack does what it claims, against the real containers.
 *
 *   docker compose -f docker-compose.scale.yml up --build -d
 *   npm run verify:scale-out
 *
 * It drives the stack only through the load balancer, the way a browser would, and looks
 * inside the containers only to read their connection counts. Writes
 * docs/evidence/redis-scale-out.md.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const BASE = process.env.SCALE_URL ?? 'http://localhost:4100';
const WS_BASE = BASE.replace(/^http/, 'ws');
const COMPOSE = ['compose', '-f', 'docker-compose.scale.yml'];
const ROOT = join(import.meta.dirname, '..');

interface ServerEvent {
  id: number;
  type: string;
  ts: string;
  data: Record<string, unknown> & {
    alert?: { reportId: string; routing: { ownerEmail: string | null } };
    streamId?: string;
    resumedFrom?: number | null;
    replayed?: number;
  };
}

const results: { check: string; result: string; ok: boolean }[] = [];
const record = (check: string, ok: boolean, result: string): void => {
  results.push({ check, result, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}: ${result}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args: string[]): string =>
  execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8' }).trim();

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}`);
  return (await response.json()) as T;
}
const login = async (email: string): Promise<Record<string, string>> => {
  const { accessToken } = await api<{ accessToken: string }>('/auth/demo-login', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  return { authorization: `Bearer ${accessToken}` };
};

class Client {
  readonly events: ServerEvent[] = [];
  closed = false;
  constructor(
    readonly who: string,
    readonly socket: WebSocket,
  ) {
    socket.on('message', (raw) => this.events.push(JSON.parse(raw.toString()) as ServerEvent));
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => undefined);
  }
  get ready(): ServerEvent {
    return this.events.find((e) => e.type === 'connection.ready')!;
  }
  get lastId(): number {
    return Math.max(0, ...this.events.map((e) => e.id));
  }
  async waitFor(match: (e: ServerEvent) => boolean, what: string, ms = 8000): Promise<ServerEvent> {
    for (let waited = 0; waited < ms; waited += 50) {
      const found = this.events.find(match);
      if (found) return found;
      await sleep(50);
    }
    throw new Error(`${this.who} did not receive ${what}`);
  }
}

async function connect(who: string, auth: Record<string, string>, query = ''): Promise<Client> {
  const { ticket } = await api<{ ticket: string }>('/realtime/ticket', {
    method: 'POST',
    headers: auth,
  });
  const client = new Client(who, new WebSocket(`${WS_BASE}/ws?ticket=${ticket}${query}`));
  await client.waitFor((e) => e.type === 'connection.ready', 'connection.ready');
  return client;
}

/** WebSocket connections held by each container, read from its own metrics endpoint. */
function connectionsByNode(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const service of ['core', 'edge']) {
    for (const id of docker(...COMPOSE, 'ps', '-q', service)
      .split('\n')
      .filter(Boolean)) {
      const name = docker('inspect', '-f', '{{.Name}}', id).replace(
        /^\/pure-insights-command-centre-/,
        '',
      );
      const metrics = docker(
        'exec',
        id,
        'node',
        '-e',
        "fetch('http://127.0.0.1:4000/metrics').then(r=>r.text()).then(t=>console.log(t))",
      );
      const line = metrics
        .split('\n')
        .find((l) => l.startsWith('picc_realtime_connections{transport="websocket"}'));
      counts[name] = Number(line?.split(' ').at(-1) ?? Number.NaN);
    }
  }
  return counts;
}

async function waitForCore(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${BASE}/readyz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('the core did not come back');
}

const inject = (auth: Record<string, string>, reportId: string, kind: string) =>
  api('/admin/incidents', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ reportId, kind }),
  });

// ---------------------------------------------------------------------------------------------
let admin = await login('admin@company.com');
const viewer = await login('viewer@company.com');
const owner = await login('user_7@company.com');
const reports = (
  await api<{ items: { reportId: string; ownerEmail: string | null }[] }>('/reports?pageSize=500', {
    headers: admin,
  })
).items;
const ownedBy7 = reports.find((r) => r.ownerEmail === 'user_7@company.com')!.reportId;
const ownedByOther = reports.find(
  (r) => r.ownerEmail !== null && r.ownerEmail !== 'user_7@company.com',
)!;
// A clean slate for the two reports used, so each injection opens a fresh alert.
for (const reportId of [ownedBy7, ownedByOther.reportId]) {
  for (let i = 0; i < 3; i++) await inject(admin, reportId, 'recovery');
}

// 1. Where do connections land?
const admins = await Promise.all(
  Array.from({ length: 6 }, (_, i) =>
    connect(`admin-${i + 1}`, admin, '&topics=alerts,reports,telemetry,system'),
  ),
);
const viewerClient = await connect('viewer', viewer, '&topics=alerts');
const ownerClient = await connect('owner', owner, '&topics=alerts');
const everyone = [...admins, viewerClient, ownerClient];
await sleep(300);
const spread = connectionsByNode();
record(
  'Connections are held by the edge tier, not the core',
  spread['core-1'] === 0 && spread['edge-1']! > 0 && spread['edge-2']! > 0,
  `core ${spread['core-1']}, edge-1 ${spread['edge-1']}, edge-2 ${spread['edge-2']} (of ${everyone.length} opened through the load balancer)`,
);
record(
  'Every node speaks for the same event stream',
  new Set(everyone.map((c) => c.ready.data.streamId)).size === 1,
  `stream ${String(admins[0]!.ready.data.streamId)} reported by all ${everyone.length} connections`,
);

// 2. An event decided on the core reaches clients on both edges, under the same access rules.
await inject(admin, ownedByOther.reportId, 'refresh_failure');
const isFired = (reportId: string) => (e: ServerEvent) =>
  e.type === 'alert.fired' && e.data.alert?.reportId === reportId;
const seen = await Promise.all(
  admins.map((c) => c.waitFor(isFired(ownedByOther.reportId), 'alert.fired')),
);
record(
  'An alert raised on the core reaches every client on every edge',
  new Set(seen.map((e) => e.id)).size === 1,
  `event #${seen[0]!.id} received by all ${admins.length} admin connections, ${Date.now() - Date.parse(seen[0]!.ts)} ms after it was published`,
);
const masked = await viewerClient.waitFor(isFired(ownedByOther.reportId), 'alert.fired');
record(
  'Field-level security holds on a node with no user table',
  masked.data.alert?.routing.ownerEmail === 'u***@company.com' &&
    seen[0]!.data.alert?.routing.ownerEmail === ownedByOther.ownerEmail,
  `viewer sees "${String(masked.data.alert?.routing.ownerEmail)}", admin sees the real address`,
);
await inject(admin, ownedBy7, 'refresh_failure');
await ownerClient.waitFor(isFired(ownedBy7), 'alert.fired for their own report');
const ownerSaw = ownerClient.events
  .filter((e) => e.type === 'alert.fired')
  .map((e) => e.data.alert?.reportId);
record(
  'Row-level security holds on a node with no ownership table',
  ownerSaw.length === 1 && ownerSaw[0] === ownedBy7,
  `the report owner received the alert for ${ownedBy7} and not the one for ${ownedByOther.reportId}`,
);

// 3. Server-Sent Events take the same route.
{
  const { ticket } = await api<{ ticket: string }>('/realtime/ticket', {
    method: 'POST',
    headers: admin,
  });
  const controller = new AbortController();
  const response = await fetch(`${BASE}/api/v1/stream?ticket=${ticket}&topics=alerts`, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  let text = '';
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += new TextDecoder().decode(value);
    }
  })().catch(() => undefined);
  await inject(admin, ownedByOther.reportId, 'refresh_timeout');
  for (let waited = 0; waited < 5000 && !text.includes('event: alert.updated'); waited += 50)
    await sleep(50);
  controller.abort();
  await read;
  record(
    'Server-Sent Events are served by the edge tier too',
    text.includes('event: connection.ready') && text.includes('event: alert.updated'),
    'connection.ready, then the alert update, over the SSE path through the load balancer',
  );
}

// 4. Restart the core. The API goes away; the connections must not.
const beforeRestart = Math.max(...admins.map((c) => c.lastId));
const restartStarted = Date.now();
docker(...COMPOSE, 'restart', 'core');
await waitForCore();
const restartSeconds = ((Date.now() - restartStarted) / 1000).toFixed(1);
const dropped = everyone.filter((c) => c.closed).length;
record(
  'Restarting the core drops no client connection',
  dropped === 0,
  `${everyone.length - dropped} of ${everyone.length} connections still open after a ${restartSeconds} s restart`,
);
admin = await login('admin@company.com');
await inject(admin, ownedByOther.reportId, 'recovery');
const afterRestart = await Promise.all(
  admins.map((c) =>
    c.waitFor(
      (e) => e.id > beforeRestart && e.type === 'alert.resolved',
      'an event after the restart',
    ),
  ),
);
const idsSeen = [
  ...new Set(admins[0]!.events.map((e) => e.id).filter((id) => id > beforeRestart)),
].sort((a, b) => a - b);
// These connections subscribe to every topic and see every report, so they see every id.
const consecutive = idsSeen.every((id, i) =>
  i === 0 ? id === beforeRestart + 1 : id === idsSeen[i - 1]! + 1,
);
record(
  'Event numbering carries on across the restart',
  consecutive &&
    afterRestart.every((e) => e.id > beforeRestart) &&
    new Set(everyone.map((c) => c.ready.data.streamId)).size === 1,
  `#${beforeRestart} was the last event before the restart and #${idsSeen[0]} the first after; ${idsSeen.length} events since, none skipped, same stream`,
);

// 5. Lose an edge. Its clients reconnect through the balancer and resume on the survivor.
const edgeIds = docker(...COMPOSE, 'ps', '-q', 'edge')
  .split('\n')
  .filter(Boolean);
docker('stop', '-t', '1', edgeIds[0]!);
// Whatever happens next, the stack is left as it was found.
process.on('exit', () => {
  try {
    docker('start', edgeIds[0]!);
  } catch {
    /* best effort */
  }
});
await sleep(1500);
const orphaned = admins.filter((c) => c.closed);
const survivors = admins.filter((c) => !c.closed);
// Something happens while the orphaned clients are away.
await inject(admin, ownedBy7, 'recovery');
await inject(admin, ownedBy7, 'refresh_failure');
const atEdgeLoss = Math.max(...orphaned.map((c) => c.lastId), beforeRestart);
await survivors[0]?.waitFor(
  (e) =>
    (e.type === 'alert.fired' || e.type === 'alert.updated') &&
    e.id > atEdgeLoss &&
    e.data.alert?.reportId === ownedBy7,
  'the alert on the surviving edge',
);
let resumedOk = orphaned.length > 0;
let detail = '';
for (const old of orphaned) {
  const back = await connect(
    `${old.who} (reconnected)`,
    admin,
    `&topics=alerts,reports,telemetry,system&lastEventId=${old.lastId}&streamId=${String(old.ready.data.streamId)}`,
  );
  await sleep(300);
  const gap = back.events.some((e) => e.type === 'replay.gap');
  const replayed = back.events.filter((e) => e.id > old.lastId).length;
  resumedOk &&= !gap && back.ready.data.resumedFrom === old.lastId && replayed > 0;
  detail = `${orphaned.length} disconnected clients reconnected on the surviving edge, resumed from their last event id and were replayed ${replayed} missed event(s) with no gap`;
  back.socket.close();
}
record('Losing an edge loses no events', resumedOk, detail || 'no client was on the stopped edge');

for (const client of everyone) client.socket.close();

const failed = results.filter((r) => !r.ok);
writeFileSync(
  join(ROOT, 'docs', 'evidence', 'redis-scale-out.md'),
  [
    '# Scale-out with Redis: verification run',
    '',
    `Run at ${new Date().toISOString()} against the stack in \`docker-compose.scale.yml\`: one core, two edge nodes, Redis and an nginx load balancer, all from the same application image.`,
    '',
    'Every check below was made from outside, through the load balancer, the way a browser reaches the system. The containers were inspected only to read their own connection counts, and were restarted and stopped with `docker`.',
    '',
    '| Check | Result | |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.check} | ${r.result} | ${r.ok ? 'PASS' : 'FAIL'} |`),
    '',
    '',
    'Reproduce with `docker compose -f docker-compose.scale.yml up --build -d` and `npm run verify:scale-out`.',
    '',
  ].join('\n'),
);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
