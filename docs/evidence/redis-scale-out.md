# Scale-out with Redis: verification run

Run at 2026-10-13T20:01:07.466Z against the stack in `docker-compose.scale.yml`: one core, two edge nodes, Redis and an nginx load balancer, all from the same application image.

Every check below was made from outside, through the load balancer, the way a browser reaches the system. The containers were inspected only to read their own connection counts, and were restarted and stopped with `docker`.

| Check | Result | |
| --- | --- | --- |
| Connections are held by the edge tier, not the core | core 0, edge-1 7, edge-2 1 (of 8 opened through the load balancer) | PASS |
| Every node speaks for the same event stream | stream 3afb2081cf0f reported by all 8 connections | PASS |
| An alert raised on the core reaches every client on every edge | event #14923 received by all 6 admin connections, 55 ms after it was published | PASS |
| Field-level security holds on a node with no user table | viewer sees "u***@company.com", admin sees the real address | PASS |
| Row-level security holds on a node with no ownership table | the report owner received the alert for RPT_230 and not the one for RPT_200 | PASS |
| Server-Sent Events are served by the edge tier too | connection.ready, then the alert update, over the SSE path through the load balancer | PASS |
| Restarting the core drops no client connection | 8 of 8 connections still open after a 1.5 s restart | PASS |
| Event numbering carries on across the restart | #14927 was the last event before the restart and #14928 the first after; 5 events since, none skipped, same stream | PASS |
| Losing an edge loses no events | 5 disconnected clients reconnected on the surviving edge, resumed from their last event id and were replayed 9 missed event(s) with no gap | PASS |


Reproduce with `docker compose -f docker-compose.scale.yml up --build -d` and `npm run verify:scale-out`.
