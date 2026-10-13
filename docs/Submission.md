# Pure Insights Command Centre

**Case Study 3 · Technical Data AI Validation (Monetization)** · Satyanarayan H

An operational admin dashboard for the Pure Insights analytics portal. It restores what the business lost when it moved off Tableau Server: who owns each report, which ones are failing or slow, and what each one costs in Snowflake credits.

> **Code repository:** {{REPO_LINK}}
>
> The repository holds the runnable codebase, the SQL suite, a recorded demo and the full test evidence. This document is self-contained: it summarises the work and reproduces the two written deliverables in full (Part B, the REST and WebSocket specification; Part C, the SQL suite).

## How to run it

Needs Node.js 22.13 or newer. No database, account or API key to set up.

```
git clone {{REPO_URL}}
cd pure-insights-command-centre
npm install
npm run dev          # then open http://localhost:5173
```

Or `docker compose up --build` and open http://localhost:4000. The sign-in page offers one-click personas for each role.

## The three deliverables

| Deliverable | Where |
| --- | --- |
| 1. Runnable full-stack codebase (React, Node.js/Express) | The repository: `apps/web`, `apps/api`, `packages/contracts` |
| 2. REST API and WebSocket technical specification | **Part B of this document**; also `docs/Technical-Specification.pdf`, `docs/api/openapi.json`, `docs/api/asyncapi.json` |
| 3. Snowflake cloud cost allocation SQL script suite | **Part C of this document**; also the `sql/` folder |

# Part A: Summary

## 1. What the data turned out to be

The brief lists four injected defects. Profiling the file found its real structure and several more, and each one changed the design.

| Finding | Consequence |
| --- | --- |
| **The 2,000 rows are 100 reports observed 20 times.** Each report id repeats 20 times in blocks of 100; there is no date column. | Rows are keyed (report, period). Treating rows as reports would count each one 20 times; de-duplicating would discard 95% of the data. |
| **74.5% of observations exceed the 15-second threshold;** 82% break some alert rule. | A notification per breach would be noise. The alert engine keeps one alert per report and rule, with severity tiers. Every breach still produces an event, as the brief requires. |
| **24 negative credit values**, summing to −161 credits. | Quarantined, not deleted or zeroed. A second attribution method shows the queries behind them cost about **$49,300**, which filtering alone would have hidden. |
| **245 orphaned rows** in two encodings (`nan`, `ORPHANED_REPORT`); 14 reports orphaned now. | Both normalised to "no owner". Orphans are ranked by cost at risk (about $32,400 a month) with a suggested owner from each report's own history. |
| **A fourth refresh status, `UNKNOWN`,** in 100 rows (not in the brief). | Treated as a monitoring gap: it neither opens nor closes a refresh-failure alert. |
| **4 rows with zero views and real cost;** 93 with peak concurrency above monthly views. | Unit cost per view is NULL for zero views, never a division error. Both are flagged. |
| **Usage and cost are uncorrelated** (every pair under 0.05). | This is the "discrepancy between active users and AWS cost" in the brief. It is quantified, and low-usage, high-cost reports are listed with a dollar figure. |
| **The file has totals, not `ACCOUNT_USAGE` logs.** | A seeded simulator disaggregates the totals into `QUERY_HISTORY`, `QUERY_ATTRIBUTION_HISTORY` and `WAREHOUSE_METERING_HISTORY`, reconciling exactly to the file. |

## 2. Architecture

![Architecture](diagrams/architecture.svg)

- **One declaration per endpoint** mounts the route, validates the request, enforces the permission, validates the response and generates the OpenAPI operation. The specification cannot drift from the code.
- **Access control on three levels**, defined once and shared by the API, the real-time gateway and the interface: endpoint permissions, row-level scope (Report Owners see only their own reports) and field-level redaction (no cost or readable email without the permission). Redaction happens on the server.
- **Four roles:** Platform Admin, FinOps Analyst, Report Owner, Viewer.
- **Two stores:** DuckDB locally (Snowflake in production) for the cost model, SQLite locally (Postgres in production) for users, alerts, assignments and the audit log.

![Overview page](shot:02-overview)

## 3. Real-time alerting

![Alert lifecycle](diagrams/alert-lifecycle.svg)

- **Rules from the brief:** load latency over 15 seconds; automated refresh failed or timed out. Two more were added for what profiling found: unknown refresh status, and invalid telemetry such as negative credits.
- **Lifecycle:** one alert per rule per report; severity tiers at 15, 30 and 45 seconds; two healthy readings to clear; reopen and flap detection; acknowledge and snooze.
- **Routing:** to the report's owner, or to administrators when the report has none.
- **Transport:** WebSocket with a documented protocol (single-use tickets, topics, heartbeats, resume by event id, restart detection), and Server-Sent Events as a fallback carrying the same events.
- **Same access rules as REST:** each event is rendered separately for each recipient, so the stream cannot leak what the API withholds.

![Alerts page](shot:06-alerts)

## 4. Cost attribution

Three methods, kept side by side, over 1,490,481 metered compute credits:

| Method | How | Credits to reports | Used for |
| --- | --- | --- | --- |
| A. Direct | `QUERY_ATTRIBUTION_HISTORY` summed by the report id in the query tag | 1,206,352 | Unit cost per active view |
| B. Idle-loaded | Method A scaled by metered ÷ attributed per warehouse and period | 1,427,330 | Chargeback; adds up to the bill |
| C. Time-weighted | Each metered warehouse-hour split by query overlap | 1,427,883 | Cross-check; estimate for quarantined rows |

- Methods B and C are computed independently and agree: correlation 0.9976, median difference 2.1%.
- Of the metered bill, 80.9% is attributed to reports, 14.5% is warehouse idle time, 3.6% belongs to other or untagged workloads, and 1.0% sits behind quarantined figures.
- For the latest period: total cost $248,044; Snowflake cost per active view $2.27; fully loaded cost per view $3.07.
- **Sixteen reconciliation checks** run inside the suite and block start-up if any fails. The guiding question: can every credit on the bill be traced to exactly one line?
- **Verified on real Snowflake.** The same files ran unchanged on a Snowflake account (version 10.37, AWS). All 16 checks pass there and every result table, including the 2,000-row fact table, is identical to the DuckDB run. A dirtier, incomplete variant of the input file was compared the same way, with the same result.

![Cost page](shot:07-cost-top)

## 5. Quality

| Area | What was done |
| --- | --- |
| Automated tests | 150 unit and integration tests; 22 browser tests against the production build |
| Access control | Every route called as every role and anonymously, generated from the route registry |
| Alert engine | 23 scripted cases, then 6,000 random observations checked against an independent reference model |
| Other input files | The whole pipeline run on dirtier, flat, single-row and incomplete files |
| Two SQL engines | DuckDB and Snowflake, every result table compared row by row |
| Browser sweep | Every page for every role, light and dark: no console errors, failed requests, broken values, sideways scroll or WCAG 2 AA violations |
| Documentation | OpenAPI, AsyncAPI, the API reference and the data-quality report are generated from the code; a test fails if they are stale |

A deliberate bug hunt found and fixed 26 defects, each now covered by a regression test. The most serious: a single malformed request could crash the server; after a restart, connected browsers silently ignored live events; "masked" owner emails were reversible. The full list, with cause and fix, is in `docs/testing.md`.

![Data quality page](shot:08-data-quality-top)

## 6. Rubric map

| Rubric area | Where it is addressed |
| --- | --- |
| Full-stack web architecture | Sections 2 and 5; `apps/api/src/http`, `apps/api/src/services`, `packages/contracts/src/rbac.ts`, `apps/web/src` |
| Real-time alerting and telemetry | Section 3; Part B sections 6 and 7; `apps/api/src/alerts`, `apps/api/src/realtime`, `apps/web/src/lib/realtime.ts` |
| Cloud cost SQL attribution | Section 4; Part C; `sql/`, `docs/evidence/snowflake-run.md` |
| Code quality and system docs | Section 5; `docs/architecture.md`, `docs/assumptions.md`, `docs/testing.md`, `docs/production-path.md` |

## 7. Scope and limits

- **`ACCOUNT_USAGE` is simulated**, because the dataset contains none. The SQL ran on real Snowflake, against the simulated tables. The simulator's assumptions are listed in `docs/assumptions.md`; the one that matters most is how much the queries behind a negative credit figure really cost.
- **Credit price is assumed** at $3.00 and is one row in a parameter table.
- **Single process.** The event bus and ticket store are in memory. The path to several servers is in `docs/production-path.md`.
- **Demo mode is on by default:** seeded accounts and one-click sign-in.
