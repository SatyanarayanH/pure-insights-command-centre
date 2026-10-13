# From case study to production

What changes to run this against the real portal, and what does not.

## Stays as it is

The contracts package, the route registry, the alert engine, the telemetry pipeline, the real-time protocol, the presenters, the React app and the SQL suite's logic. They do not know which database they are talking to.

## Changes

| Area | Now | Production | Size of change |
| --- | --- | --- | --- |
| Warehouse | DuckDB over simulated `ACCOUNT_USAGE` | Snowflake over `SNOWFLAKE.ACCOUNT_USAGE` | Point the schema references at the real views and drop the loader. The `Warehouse` interface has four methods; `tools/snowflake/run.ts` implements it for the Snowflake driver. |
| Suite scheduling | Runs at application start | A Snowflake task or dbt job, hourly; the app reads the marts | The app's snapshot loader becomes a query on a schedule. |
| Report catalogue | The CSV | The portal's own metadata table | One loader. |
| Operational store | SQLite file | Postgres on RDS | The repositories in `opsdb/` are the only SQL that changes. |
| Sign-in | Seeded accounts, demo login | Corporate IdP over OIDC; roles from group claims | Replace `/auth/login`; everything downstream consumes the same `Principal`. |
| Telemetry | Built-in simulator | The portal posts to `/api/v1/telemetry` | A few lines in the portal's request layer. |
| Query tagging | Simulated | The portal sets `QUERY_TAG` per statement | A few lines in the portal's Snowflake client. Without it, per-report attribution is not possible. |
| Notifications | In-app | Also email or chat to the routed owner | A subscriber on the event bus. |
| Ownership | Override stored here | Written back to the portal | One outbound call in `OrphanService.assign`. |

## AWS topology

- **Compute.** The container on ECS Fargate, two or more tasks across availability zones, behind an Application Load Balancer. ALB supports WebSocket; set the idle timeout above the 25-second heartbeat.
- **Static assets.** The same container serves them; CloudFront in front if latency matters.
- **State.** RDS Postgres (Multi-AZ). ElastiCache Redis for the event stream and tickets.
- **Secrets.** `JWT_SECRET`, the ingest key and the Snowflake key pair in Secrets Manager, injected as task secrets.
- **Snowflake access.** Key-pair authentication for a service user with a read-only role on the marts and on `SNOWFLAKE.ACCOUNT_USAGE`.

## Scaling the real-time layer

One process holds every connection today. Past one node:

1. `EventBus.publish` appends to a Redis Stream instead of an in-memory array. The stream id replaces the integer event id; clients already treat it as opaque and ordered.
2. Each node consumes the stream and delivers to its own connections. Per-recipient filtering stays where it is.
3. Tickets move to Redis with a 30-second TTL and atomic delete-on-read.
4. No sticky sessions are needed: a client that lands on a different node after a reconnect resumes from its last event id.

## Cost controls worth adding on the Snowflake side

- A resource monitor on each portal warehouse, with a notify threshold below the suspend threshold.
- `AUTO_SUSPEND` reviewed against the idle share this suite reports (14.5% in the simulation).
- A scheduled query on `MART.CREDITS_UNATTRIBUTED`: growth there means the portal has started issuing untagged queries.
