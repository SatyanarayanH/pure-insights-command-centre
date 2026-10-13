# Snowflake Cloud Cost Allocation SQL Suite

Deliverable 3 of Case Study 3. Eight scripts that take report telemetry and Snowflake `ACCOUNT_USAGE` logs and produce: credits attributed to each report, unit cost per active view, chargeback by owner, a list of cost anomalies, and a set of checks that prove the numbers add up.

The scripts are written in Snowflake SQL. They have been run on a real Snowflake account, where all 16 reconciliation checks pass and every result table matches the DuckDB run row for row ([evidence](../docs/evidence/snowflake-run.md)). They also run unchanged on DuckDB, which is how they are tested on every build and how the application loads its data.

## Run it

```bash
npm run sql:duckdb
```

Simulates `ACCOUNT_USAGE` (about 254,000 query rows), runs the eight scripts and prints the reconciliation table. Takes a few seconds. Exits non-zero if a statement or a check fails.

To run the same files on a real Snowflake account, see [Running on Snowflake](#running-on-snowflake).

## The files

| File | Produces | What it does |
| --- | --- | --- |
| `00_setup.sql` | schemas, `CONFIG.COST_PARAMS`, landing tables | Parameters live in one table; no thresholds or prices are buried in queries. |
| `loaders/duckdb_load.sql` | loaded `RAW` and `ACCOUNT_USAGE` | DuckDB: two compatibility macros and `read_csv`. |
| `loaders/snowflake_load.sql` | the same | Snowflake: stage, `PUT`, `COPY INTO`. |
| `01_staging_clean.sql` | `STG.REPORT_TELEMETRY`, `DQ.RULES`, `DQ.FINDINGS`, `DQ.QUARANTINE`, `DQ.RULE_SUMMARY` | Types, conforms and quality-checks the telemetry. Nothing is deleted. |
| `02_attribution_direct.sql` | `STG.QUERY_CLASSIFIED`, `STG.QUERY_ATTRIBUTION`, `MART.CREDITS_DIRECT`, `MART.CREDITS_UNATTRIBUTED` | Method A: credits per report from `QUERY_ATTRIBUTION_HISTORY` by query tag. |
| `03_attribution_time_weighted.sql` | `STG.WAREHOUSE_PERIOD`, `MART.CREDITS_IDLE_LOADED`, `MART.CREDITS_TIME_WEIGHTED`, `MART.ATTRIBUTION_COMPARISON` | Methods B and C: getting from query credits to the metered bill. |
| `04_unit_economics.sql` | `MART.FCT_REPORT_PERIOD`, `MART.OWNERSHIP_HISTORY`, `MART.DIM_REPORT`, `MART.PERIOD_SUMMARY` | Unit cost per active view and the marts the application reads. |
| `05_chargeback.sql` | `MART.CHARGEBACK_OWNER_PERIOD`, `MART.CHARGEBACK_OWNER`, `MART.ORPHAN_QUEUE` | Cost by owner, with unowned spend as its own line. |
| `06_cost_anomalies.sql` | `MART.USAGE_COST_CORRELATION`, `MART.REPORT_EFFICIENCY`, `MART.COST_ANOMALIES` | Where cost and usage disagree, with a dollar figure. |
| `07_reconciliation_tests.sql` | `DQ.RECONCILIATION` | Sixteen checks. The runner fails if any is not `PASS`. |

## What the dataset is, and is not

The case-study file has 2,000 rows, but only 100 distinct `report_id` values. Each appears exactly 20 times, in repeating blocks of 100, with no date column. The suite reads it as **20 reporting periods of the same 100 reports**, keyed `(report_id, period_seq)`, where a report's nth occurrence in file order is its nth period.

The file holds per-report totals. It contains no `ACCOUNT_USAGE` logs, and the brief asks for SQL against them, so they are simulated. `apps/api/src/warehouse/simulator.ts` disaggregates each report-period's totals into three tables with the same column names as the real views:

| Simulated table | Real view | Rows |
| --- | --- | --- |
| `ACCOUNT_USAGE.QUERY_HISTORY` | `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` | 253,593 |
| `ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY` | `SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY` | 253,593 |
| `ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` | `SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` | 27,594 |

The simulator follows three rules:

1. **Pure disaggregation.** For every report and period, simulated query credits sum back to the dataset value exactly, defects included. Negative credits stay negative in the query log. Cleaning is the SQL suite's job.
2. **Deterministic.** Seeded. The same input gives byte-identical files.
3. **Scaled, and says so.** One simulated row stands for about 100 real queries (`CONFIG.SIM_PARAMS.queries_per_row`), carrying their combined credits and elapsed time. Full fidelity would be 25 million rows; nothing in the method depends on the scale.

It also adds what a real shared warehouse has and the dataset does not: idle time in every metered hour, and workloads that belong to no catalogued report (a dbt job, untagged ad hoc queries, a free-text legacy tag, and a report id that is not in the catalogue). They exist so the attribution has something to get wrong.

Assumptions the simulator makes that are not in the data are listed in [`docs/assumptions.md`](../docs/assumptions.md).

## Attribution: three methods

The portal runs every query as one service user, so `USER_NAME` cannot identify a report. Attribution depends on the portal setting a JSON `QUERY_TAG` with the report id (specified in the technical specification, section 8).

| Method | How | Total, all periods | Use it for |
| --- | --- | --- | --- |
| **A. Direct** | Sum `QUERY_ATTRIBUTION_HISTORY.credits_attributed_compute` by the tag's `report_id`. | 1,206,352 credits | Unit cost per active view. Snowflake's own figure; excludes warehouse idle time. |
| **B. Idle-loaded** | Method A times `metered / attributed` for the query's warehouse and period. | 1,427,330 credits | Chargeback. Owner lines add up to the bill. |
| **C. Time-weighted** | Ignore attribution history. Split each metered warehouse-hour across the queries running in it, by milliseconds of overlap. | 1,427,883 credits | Cross-check; accounts without attribution history; the estimate for quarantined rows. |

B and C are computed from different inputs and agree: correlation 0.9976 across 2,000 report-periods, median difference 2.1%.

Of 1,490,481 metered compute credits, 80.9% are attributed to reports, 14.5% are warehouse idle time, 3.6% belong to other or untagged workloads, and 1.0% sit behind quarantined figures. Check R07 and R08 verify that split on every run.

### Why Method C matters here

Twenty-four report-periods report negative credits (sum −161.04). The suite quarantines those figures: it does not delete the rows, take the absolute value, or set them to zero. But the queries behind them still ran and were still billed. Method C never looks at the reported figure, so it gives an independent estimate for exactly those rows: **16,434 credits, about $49,300**. Filtering the bad rows and stopping there would have under-reported cost by that amount.

`MART.FCT_REPORT_PERIOD` keeps the two bases apart. `credits_attributed` is Method A and is NULL for quarantined rows. `credits_fully_loaded` is Method B, falling back to Method C, and `is_cost_imputed` marks the fallback.

## Unit cost per active view

```
snowflake_cost_per_view_usd = credits_attributed   * credit_price_usd / NULLIF(monthly_active_views, 0)
total_cost_per_view_usd     = (credits_fully_loaded * credit_price_usd + aws_hosting_cost_usd)
                              / NULLIF(monthly_active_views, 0)
```

The first is the brief's metric on Snowflake's own attribution. The second is what a view really costs once idle time and AWS hosting are included. Four report-periods have zero views; their unit cost is NULL, not an error and not infinity (check R13).

`credit_price_usd` is 3.00 in `CONFIG.COST_PARAMS`. Change that one row for a different contract price.

## Data quality rules

`DQ.RULES` is the registry; `DQ.FINDINGS` has one row per violation with the source line it came from. The generated report is [`docs/data-quality-report.md`](../docs/data-quality-report.md).

| Rule | Rows | In the brief | Action |
| --- | --- | --- | --- |
| DQ-01 orphaned owner (`nan` or `ORPHANED_REPORT`) | 245 | yes | Normalised to a NULL owner |
| DQ-02 negative credits | 24 | yes | Quarantined from cost |
| DQ-03 latency over 15 s | 1,490 | yes | Flagged; drives alerting |
| DQ-04 hosting cost per view outlier | 27 | yes | Flagged (modified z-score on log scale) |
| DQ-11 refresh failed or timed out | 564 | yes | Flagged; drives alerting |
| DQ-05 refresh status `UNKNOWN` | 100 | no | Flagged as a telemetry gap |
| DQ-06 repeated `report_id` | 1,900 | no | Restructured into periods |
| DQ-07 named owner changed since last period | 1,371 | no | Flagged |
| DQ-08 zero views with cost | 4 | no | Unit cost set to NULL |
| DQ-09 peak concurrency above monthly views | 93 | no | Flagged |
| DQ-10, DQ-12 type and email format | 0 | no | Schema guards |

## Reconciliation

`07_reconciliation_tests.sql` writes one row per check to `DQ.RECONCILIATION`. Selected checks:

| Check | Verifies |
| --- | --- |
| R01–R03 | No row lost between landing and staging; `(report_id, period_seq)` is unique; the panel is complete. |
| R04 | Raw credits = clean credits + quarantined credits. |
| R05 | Method A reproduces the reported figure for every valid report-period. |
| R07 | Every query credit lands in exactly one bucket. |
| R08, R09 | Methods B and C each allocate the metered bill in full, creating and losing nothing. |
| R11, R12 | Every report-period has a cost; exactly the quarantined ones are imputed. |
| R13 | Zero views never yields a unit cost. |
| R14 | Chargeback lines sum to the fact table. |

The application runs this suite at start-up and will not serve data if a check fails.

## Portability

The suite stays inside the subset both engines execute. Where they differ, the Snowflake form is used and DuckDB is given a shim.

| Used | Avoided | Reason |
| --- | --- | --- |
| `a / NULLIF(b, 0)` | `DIV0`, `DIV0NULL` | Not in DuckDB. |
| `CASE WHEN` | `IFF` | Not in DuckDB. |
| `QUALIFY ROW_NUMBER() ...` | | Both support it. |
| `TRY_CAST`, `MEDIAN`, `CORR`, `PERCENT_RANK`, `DATEDIFF('millisecond', ...)` | `PERCENTILE_CONT ... WITHIN GROUP`, `LISTAGG ... WITHIN GROUP`, `DATEADD` | Syntax differs. |
| A calendar table (`RAW.PERIOD_CALENDAR`) | Date arithmetic in queries | Portable, and makes the period assumption explicit and replaceable. |
| `GET_PATH(TRY_PARSE_JSON(tag), 'report_id')` | `tag:report_id::string` | Two macros in `loaders/duckdb_load.sql` cover it. |
| `DOUBLE`, `INTEGER`, `VARCHAR`, `TIMESTAMP` | `NUMBER(p,s)`, `TIMESTAMP_NTZ` | DuckDB does not know the names. |

One performance note is in `03_attribution_time_weighted.sql`: "which metered hours does this query overlap" is a range join, and with two warehouses the equality on `warehouse_id` barely narrows it. Expanding each query to the calendar days it touches first turns the expensive part into an equi-join. On DuckDB that took the script from 13.5 seconds to under one.

## Running on Snowflake

Needs a Snowflake account (a free trial is enough) and a role that can create a database.

1. Put the connection details in a `.env` file in the repository root. It is git-ignored. See `.env.example` for the variable names; password, programmatic access token and key-pair authentication are supported.
2. Run:

```bash
npm run sql:snowflake
```

This installs the Snowflake driver into `tools/snowflake/` (kept out of the main install), creates the database `PURE_INSIGHTS_SIM`, uploads the files to an internal stage, runs the same eight scripts, and then compares every mart row by row with the DuckDB run. The result is written to `docs/evidence/snowflake-run.md`.

To run against production data instead of the simulation, replace the `ACCOUNT_USAGE` schema references with `SNOWFLAKE.ACCOUNT_USAGE` and drop the loader; the column names are the real ones. Two things to know about the real views: they lag by up to a few hours, and `QUERY_ATTRIBUTION_HISTORY` omits very short queries, which Method B's overhead factor absorbs.
