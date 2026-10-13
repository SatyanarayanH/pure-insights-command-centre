# Docker run

`docker compose up --build` on Docker version 28.3.0, arm64, 2026-10-13T20:00Z.

| Check | Result |
| --- | --- |
| Image builds | yes, 868MB |
| SQL suite inside the build | 100 reports, 2000 report-periods, 16/16 reconciliation checks pass; the build fails otherwise |
| Container status after start | Up 20 seconds (healthy) |
| `GET /readyz` | `{"status":"ready","warehouse":{"dialect":"duckdb",...,"reports":100}}` |
| Web app served at `/` | 200 text/html; charset=utf-8 |
| Sign-in and `GET /api/v1/overview` | 200 |
| Upgrade of an existing data volume | the volume written by the previous build (schema version 2) was migrated in place to version 3 on start, keeping its alerts and audit log; no errors logged |
| `GET /metrics` | served; 16 reconciliation checks PASS, 0 FAIL, open alerts by severity, telemetry counts |
| `POST /api/v1/admin/warehouse/refresh` | `{"outcome":"unchanged",...,"durationMs":160,"error":null}` |
| Notifications without a webhook | recorded with status `skipped`; `channel: none` in system status |
| WebSocket `/ws` | 20 clients connected with tickets; every one received every event, median push delay 3 ms |
| Content security policy | `script-src 'self'`; the API explorer at `/docs` loads under it |

The image builds the warehouse at build time, so the container is ready about a second after it starts.

The same image also runs the scale-out stack (`docker-compose.scale.yml`: one core, two edge nodes, Redis, a load balancer). That run is recorded in [redis-scale-out.md](redis-scale-out.md).
