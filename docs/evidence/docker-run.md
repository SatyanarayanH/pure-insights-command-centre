# Docker run

`docker compose up --build` on Docker version 28.3.0, arm64, 2026-10-13T14:57Z.

| Check | Result |
| --- | --- |
| Image builds | yes, 865MB |
| SQL suite inside the build | Warehouse built in 11396 ms: 100 reports, 2000 report-periods, 16/16 reconciliation checks pass. |
| Container status after start | Up 27 seconds (healthy) |
| `GET /readyz` | `{"status":"ready","warehouse":{"dialect":"duckdb","builtAt":"2026-10-13T14:56:58.794Z","reports":100}}` |
| Web app served at `/` | 200 text/html; charset=utf-8 |
| Sign-in and `GET /api/v1/overview` | 200 |
| WebSocket `/ws` | connected with a ticket and a browser-style `Origin` header; an injected latency spike arrived as an alert event on the stream |

The image builds the warehouse at build time, so the container is ready about a second after it starts. The build fails if any reconciliation check fails.
