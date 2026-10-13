# Load test

How the system behaves with many browsers connected and telemetry arriving fast: does every event reach every client, how late, and what does it cost the emitter.

Run on Apple M2 (8 cores, 8 GB), Node v23.11.0, with the load generator on the same machine as the servers, so these are conservative figures for the hardware and not a capacity claim for a production host. The server was the production build with the built-in simulator off. Each run lasted 20 seconds.

Reproduce with `npm run load-test -- --clients 300 --rate 200` (see the header of `tools/load-test.ts`).

## What the numbers mean

- **Events** are telemetry observations posted to `POST /api/v1/telemetry`, 20 per request, each with its own `eventId`. About 30% are slow and 8% are failed refreshes, so the alert engine is doing real work: every run opens several hundred alerts.
- **Messages pushed** counts every WebSocket message to every client. One observation becomes about 1.8 messages per connected client (the observation itself, plus the alert event it causes).
- **Delivery** is checked per client: each one must receive every accepted observation.
- **Push delay** is the time from the server publishing an event to a client receiving it.

## Summary

| Setup | Clients | Events/s | Messages/s | Everything delivered | Ingest request p50 / p99 | Push delay p50 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| One process | 100 | 100 | 18,476 | yes | 19 ms / 99 ms | 1.0 ms / 4.0 ms |
| One process | 300 | 200 | 109,360 | yes | 49 ms / 187 ms | 1.0 ms / 5.0 ms |
| One process | 500 | 300 | 193,780 | yes | 1.5 s / 17.7 s | 1.0 ms / 8.0 ms |
| Core + 2 edges | 300 | 200 | 109,653 | yes | 4.9 ms / 91 ms | 11 ms / 64 ms |
| Core + 2 edges | 500 | 300 | 270,887 | yes | 16 ms / 173 ms | 42 ms / 554 ms |
| Core + 2 edges | 800 | 300 | 433,547 | yes | 47 ms / 299 ms | 2.4 s / 5.4 s |

## Reading the results

1. **One process is comfortable to about 100,000 pushed messages a second** (300 clients at 200 events/s): everything delivered, a few milliseconds late.
2. **Past roughly 200,000 messages a second one process is saturated.** Nothing is lost and nothing arrives late once published; instead the emitter's requests queue (seconds, not milliseconds). The system slows the sender down rather than dropping data, which is the right failure, but it is the limit.
3. **Moving the connections to two edge nodes removes that limit.** At the load that saturated one process, the emitter's request time falls from seconds to tens of milliseconds, because the core now writes each event to Redis once instead of to every socket. The price is the extra hop: push delay rises from about 1 ms to tens of milliseconds.
4. **Edges have a limit of their own, and it is reached by adding clients, not events.** With 800 clients on two edges everything is still delivered, but seconds late. The answer is a third edge, which is a change to one number in the compose file.

One optimisation came out of this test. The gateway used to render and serialise each event once per connection; it now does so once per class of recipient (those who may see email addresses and those who may not) and writes the same text to every socket in the class. That raised the single-process ceiling from about 155,000 to about 200,000 messages a second on this machine. A test asserts that every recipient in a class would have received byte-identical output.

## Runs

### One process: 100 clients, 100 events/s

| Measure | Result |
| --- | --- |
| Connected clients | 100 WebSocket (100 still open at the end) |
| Target rate | 100 events/s for 20 s, 20 per request |
| Events sent | 1,992 (99/s achieved) |
| Events accepted | 1,992 · 0 rejected · 0 duplicates · 0 failed requests |
| Alerts opened | 416 |
| Ingest request time | p50 19 ms · p95 43 ms · p99 99 ms · max 218 ms |
| Messages pushed | 370,000 in total (18,476/s) |
| Delivery | 100 of 100 clients received all 1,992 telemetry events (fewest 1,992) |
| Push delay, publish to client | p50 1.0 ms · p95 2.0 ms · p99 4.0 ms · max 27 ms |
| Server event-loop delay | p99 55 ms · max 82 ms |
| Server memory | 69 MB resident |

### One process: 300 clients, 200 events/s

| Measure | Result |
| --- | --- |
| Connected clients | 300 WebSocket (300 still open at the end) |
| Target rate | 200 events/s for 20 s, 20 per request |
| Events sent | 3,996 (199/s achieved) |
| Events accepted | 3,996 · 0 rejected · 0 duplicates · 0 failed requests |
| Alerts opened | 910 |
| Ingest request time | p50 49 ms · p95 112 ms · p99 187 ms · max 209 ms |
| Messages pushed | 2,196,000 in total (109,360/s) |
| Delivery | 300 of 300 clients received all 3,996 telemetry events (fewest 3,996) |
| Push delay, publish to client | p50 1.0 ms · p95 2.0 ms · p99 5.0 ms · max 40 ms |
| Server event-loop delay | p99 116 ms · max 172 ms |
| Server memory | 77 MB resident |

### One process, overloaded: 500 clients, 300 events/s

| Measure | Result |
| --- | --- |
| Connected clients | 500 WebSocket (500 still open at the end) |
| Target rate | 300 events/s for 20 s, 20 per request |
| Events sent | 5,984 (214/s achieved) |
| Events accepted | 5,984 · 0 rejected · 0 duplicates · 0 failed requests |
| Alerts opened | 1,306 |
| Ingest request time | p50 1.5 s · p95 17.1 s · p99 17.7 s · max 17.8 s |
| Messages pushed | 5,422,000 in total (193,780/s) |
| Delivery | 500 of 500 clients received all 5,984 telemetry events (fewest 5,984) |
| Push delay, publish to client | p50 1.0 ms · p95 4.0 ms · p99 8.0 ms · max 34 ms |
| Server event-loop delay | p99 1.9 s · max 2.2 s |
| Server memory | 83 MB resident |

### Core and two edges: 300 clients, 200 events/s

| Measure | Result |
| --- | --- |
| Connected clients | 300 WebSocket (300 still open at the end) |
| Target rate | 200 events/s for 20 s, 20 per request |
| Events sent | 3,980 (199/s achieved) |
| Events accepted | 3,980 · 0 rejected · 0 duplicates · 0 failed requests |
| Alerts opened | 862 |
| Ingest request time | p50 4.9 ms · p95 39 ms · p99 91 ms · max 92 ms |
| Messages pushed | 2,193,300 in total (109,653/s) |
| Delivery | 300 of 300 clients received all 3,980 telemetry events (fewest 3,980) |
| Push delay, publish to client | p50 11 ms · p95 27 ms · p99 64 ms · max 150 ms |
| Server event-loop delay | p99 41 ms · max 84 ms |
| Server memory | 56 MB resident |

### Core and two edges: 500 clients, 300 events/s

| Measure | Result |
| --- | --- |
| Connected clients | 500 WebSocket (500 still open at the end) |
| Target rate | 300 events/s for 20 s, 20 per request |
| Events sent | 5,976 (298/s achieved) |
| Events accepted | 5,976 · 0 rejected · 0 duplicates · 0 failed requests |
| Alerts opened | 1,317 |
| Ingest request time | p50 16 ms · p95 64 ms · p99 173 ms · max 288 ms |
| Messages pushed | 5,423,500 in total (270,887/s) |
| Delivery | 500 of 500 clients received all 5,976 telemetry events (fewest 5,976) |
| Push delay, publish to client | p50 42 ms · p95 396 ms · p99 554 ms · max 645 ms |
| Server event-loop delay | p99 60 ms · max 252 ms |
| Server memory | 61 MB resident |

### Core and two edges, overloaded: 800 clients, 300 events/s

| Measure | Result |
| --- | --- |
| Connected clients | 800 WebSocket (800 still open at the end) |
| Target rate | 300 events/s for 20 s, 20 per request |
| Events sent | 5,990 (298/s achieved) |
| Events accepted | 5,990 · 0 rejected · 0 duplicates · 0 failed requests |
| Alerts opened | 1,312 |
| Ingest request time | p50 47 ms · p95 183 ms · p99 299 ms · max 312 ms |
| Messages pushed | 8,705,600 in total (433,547/s) |
| Delivery | 800 of 800 clients received all 5,990 telemetry events (fewest 5,990) |
| Push delay, publish to client | p50 2.4 s · p95 5.4 s · p99 5.4 s · max 5.5 s |
| Server event-loop delay | p99 94 ms · max 295 ms |
| Server memory | 26 MB resident |
