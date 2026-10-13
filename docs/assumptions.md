# Assumptions

Everything here is something the brief or the dataset did not settle. Each line says what was assumed, why, and where to change it.

## About the dataset

| # | Assumption | Why | Where it lives |
| --- | --- | --- | --- |
| A1 | The 2,000 rows are 20 reporting periods of the same 100 reports, in file order. | 100 report ids each appear exactly 20 times, in blocks of 100, with no date column. No other reading uses every row once. | `sql/01_staging_clean.sql` (`period_seq`) |
| A2 | A period is 30 days, and the last one ends on 1 October 2026. | Column names say "monthly" and "last_30d". The file has no dates, so the calendar is an explicit table rather than arithmetic. Any dates work. | `RAW.PERIOD_CALENDAR`, `DEFAULT_SIMULATION_PARAMS` |
| A3 | "Current state" is the latest period (P20). | The newest observation is the best description of now. | `MART.DIM_REPORT` |
| A4 | `nan` and `ORPHANED_REPORT` both mean "no owner". | `nan` is how pandas writes a missing value to text; the brief names both. | `sql/01_staging_clean.sql` |
| A5 | A negative credit figure is a reporting defect, not a refund. | Snowflake does not meter negative compute. The brief calls for "anomaly filtering". | Rule DQ-02 |
| A6 | `UNKNOWN` refresh status means the outcome was not reported. | It is neither success nor failure, and the brief does not mention it. | Rule DQ-05, alert rule `refresh_unknown` |
| A7 | `TIMED_OUT` is a refresh failure. | The data did not refresh. | Alert rule `refresh_failure` |
| A8 | "Exceeds 15 seconds" means strictly greater than 15. | Plain reading of "exceeds". Seven rows sit at exactly 15.0. | `apps/api/src/alerts/rules.ts` |
| A9 | The owner columns for different periods are independent observations, so ownership genuinely changes. | Each report has 7 to 13 different named owners. That is implausible for a real portal but it is what the data says; the system reports it rather than smoothing it. | `MART.OWNERSHIP_HISTORY` |

## About cost

| # | Assumption | Why | Where it lives |
| --- | --- | --- | --- |
| C1 | One Snowflake credit costs $3.00. | A typical list price for Enterprise edition; the real figure is contractual. | `CONFIG.COST_PARAMS.credit_price_usd` |
| C2 | `snowflake_credits_consumed` is compute attributed to the report's own queries, excluding warehouse idle time. | That is what `QUERY_ATTRIBUTION_HISTORY` reports, and it makes Method A reconcile to the dataset exactly. | `sql/02_attribution_direct.sql` |
| C3 | `aws_hosting_cost_usd` is already allocated per report. | It arrives per report and nothing in the data would support re-allocating it. | `MART.FCT_REPORT_PERIOD` |
| C4 | "Active user view" is `monthly_active_views`. | It is the only per-report usage count that scales with audience. | Unit cost formulas |

## Made by the ACCOUNT_USAGE simulator

The dataset has no query logs, so these are inventions. They affect Methods B and C and the unattributed buckets; they do not affect Method A, which reconciles to the dataset by construction.

| # | Assumption | Effect |
| --- | --- | --- |
| S1 | One simulated row stands for about 100 real queries. | Keeps the suite to seconds. Nothing in the method depends on it. |
| S2 | Two shared warehouses; each report always uses the same one. | Gives Method B something to load per warehouse. |
| S3 | Every metered hour carries 4% to 30% idle time on top of query credits. | Makes the metered bill larger than attributed credits, as it is in practice. |
| S4 | About 5% extra credits per period come from workloads with no usable report tag. | Exercises the unattributed buckets. |
| S5 | A query's elapsed time is proportional to its credits, with 20% noise for concurrency. | Makes time-weighted attribution meaningful, and imperfect. |
| S6 | For a report-period with negative credits, the queries really cost that report's median valid credits. | Something has to stand in for the unknown truth. This is what Method C then recovers, so the quarantine estimate ($49,300) is only as good as this assumption. With real logs, the assumption disappears. |
| S7 | Query volume follows a weekday, business-hours pattern. | Cosmetic. |

## About the system

| # | Assumption | Why |
| --- | --- | --- |
| Y1 | The portal can push telemetry events and set a `QUERY_TAG`. | Both are a few lines in the portal's query layer; without the tag, per-report attribution is not possible on a shared service user. |
| Y2 | An owner assigned in the Command Centre overrides the portal's value. | The assignment is a deliberate, audited act; the portal's value demonstrably flickers. In production the assignment would be written back to the portal. |
| Y3 | Chargeback follows who owned the report at the time; assignments do not rewrite history. | A new owner should not inherit last year's bill. |
| Y4 | Viewers may see health but not cost or personal email addresses. | A reasonable least-privilege default; it is one table to change. |
