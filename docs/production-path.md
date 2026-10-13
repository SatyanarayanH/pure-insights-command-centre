# From case study to production

What it takes to run this against the real portal: what is already built and proven, what still has to change, and what does not change at all.

## Already built

Each of these was built, tested and measured on this project. Details and evidence are in [operations.md](operations.md).

| Need in production | What exists | Evidence |
| --- | --- | --- |
| People must be told about alerts | Webhook notifications with routing, escalation of unacknowledged alerts, retries and burst digests | `apps/api/test/production.test.ts` |
| A dead feed must not look healthy | Feed-silent detection and per-report stale alerts | same |
| The emitter will retry | Idempotent ingest by `eventId` | same |
| "How is it behaving now?" | Stored readings and live trend charts | same, plus a browser test |
| Operators need visibility | Prometheus metrics at `/metrics` | same |
| Know the limits | Load test with published numbers | [evidence/load-test.md](evidence/load-test.md) |
| Fresh cost data without downtime | Scheduled and on-demand warehouse refresh; bad data is refused | `apps/api/test/production.test.ts` |
| The real warehouse | The application reads Snowflake directly | [evidence/snowflake-live-read.md](evidence/snowflake-live-read.md) |
| More connections than one server holds; deploys that drop nobody | Redis event stream, shared tickets, connection-only edge nodes | [evidence/redis-scale-out.md](evidence/redis-scale-out.md) |

## Stays as it is

The contracts package, the route registry, the alert engine, the telemetry pipeline, the real-time protocol, the presenters, the React app and the SQL suite's logic. They do not know which database they are talking to.

## Still to change

| Area | Now | Production | Size of change |
| --- | --- | --- | --- |
| Usage tables | Simulated `ACCOUNT_USAGE`, loaded into Snowflake | `SNOWFLAKE.ACCOUNT_USAGE` | Point the schema references at the real views and drop the loader. |
| Suite scheduling | Run by hand (`npm run sql:snowflake`) | A Snowflake task or dbt job, hourly | Scheduling only. The application already reads whatever the last run produced and refreshes on a timer. |
| Report catalogue | The CSV | The portal's own metadata table | One loader. |
| Operational store | SQLite file, one core | Postgres on RDS, several cores | The repositories in `opsdb/` and the in-process caches beside them. This is the largest remaining change, and the one that removes the single core. |
| Sign-in | Seeded accounts, demo login | Corporate IdP over OIDC; roles from group claims | Replace `/auth/login`; everything downstream consumes the same `Principal`. |
| Telemetry | Built-in simulator | The portal posts to `/api/v1/telemetry` with an `eventId` per event | A few lines in the portal's request layer. |
| Query tagging | Simulated | The portal sets `QUERY_TAG` per statement | A few lines in the portal's Snowflake client. Without it, per-report attribution is not possible. |
| Readings store | SQLite table, 7 days | A time-series store, or Snowflake | One repository with four queries. |
| Ownership | Override stored here | Written back to the portal | One outbound call in `OrphanService.assign`. |

## AWS topology

- **Compute.** Two ECS Fargate services from the one image: `core` (one task until the operational store moves to Postgres) and `edge` (two or more tasks across availability zones). An Application Load Balancer routes `/ws` and `/api/v1/stream` to the edge target group and everything else to the core, exactly as `deploy/nginx.scale.conf` does locally. Set the ALB idle timeout above the 25-second heartbeat.
- **Static assets.** The core serves them; CloudFront in front if latency matters.
- **State.** ElastiCache Redis (Multi-AZ, TLS, AUTH) for the event stream and tickets; RDS Postgres (Multi-AZ) once the operational store moves.
- **Secrets.** `JWT_SECRET`, the ingest key, the webhook URL, the metrics token and the Snowflake key pair in Secrets Manager, injected as task secrets.
- **Snowflake access.** Key-pair authentication for a service user with a read-only role on the marts.
- **Monitoring.** Scrape `/metrics` on both services. Alert on `picc_telemetry_feed_silent`, `picc_warehouse_refreshes{outcome="failed"}`, `picc_notifications{status="failed"}`, `picc_redis_mirror_failures` and `picc_event_loop_lag_seconds`.

Not verified here: managed Redis behaviour (TLS, failover, cluster mode) and anything that needs real AWS networking. The local stack uses the same Redis commands and the same routing rule.

## How the real-time layer scales

Built and described in [operations.md](operations.md#9-scale-out-with-redis). In short: the core numbers each event and mirrors it to a Redis Stream; edge nodes follow the stream and deliver to their own connections; tickets live in Redis and are redeemed with an atomic read-and-delete; no sticky sessions are needed, because a client that lands on a different node resumes from its last event id. Adding capacity for more browsers is adding edge tasks.

## Cost controls worth adding on the Snowflake side

- A resource monitor on each portal warehouse, with a notify threshold below the suspend threshold.
- `AUTO_SUSPEND` reviewed against the idle share this suite reports (14.5% in the simulation).
- A scheduled query on `MART.CREDITS_UNATTRIBUTED`: growth there means the portal has started issuing untagged queries.
