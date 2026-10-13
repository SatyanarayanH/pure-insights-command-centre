# Snowflake validation run: dirty, incomplete input file

Run at 2026-10-13T16:47:33.953Z against Snowflake 10.37.100 in AWS_AP_SOUTHEAST_7, warehouse COMPUTE_WH, database PURE_INSIGHTS_SIM.

Input: 89 rows cut from the case-study file (30 reports, 3 periods, one row removed) with blank owners, `NaN`, padded and mixed-case addresses, lowercase and blank statuses, non-numeric and blank credits, and blank measurements. This is the same variant `apps/api/test/data-variants.test.ts` builds. It exists to compare how the two engines treat NULLs, which is where they differ most.

The same SQL files were executed on DuckDB and on Snowflake, from the same generated input files, and every mart was compared row by row.

## Suite execution on Snowflake

| File | Statements | Duration (ms) |
| --- | --- | --- |
| 00_setup.sql | 14 | 2717 |
| loaders/snowflake_load.sql | 14 | 19156 |
| 01_staging_clean.sql | 6 | 3334 |
| 02_attribution_direct.sql | 4 | 2185 |
| 03_attribution_time_weighted.sql | 6 | 3599 |
| 04_unit_economics.sql | 4 | 3156 |
| 05_chargeback.sql | 3 | 1921 |
| 06_cost_anomalies.sql | 3 | 1837 |
| 07_reconciliation_tests.sql | 1 | 1315 |

Total: 39492 ms on Snowflake, 460 ms on DuckDB.

## Reconciliation checks on Snowflake

| Check | What is verified | Expected | Actual | Status |
| --- | --- | --- | --- | --- |
| R01 | Row count: RAW landed rows = STG rows | 89 | 89 | PASS |
| R02 | Grain: (report_id, period_seq) is unique in STG | 89 | 89 | PASS |
| R03 | Panel: rows = distinct reports x distinct periods | 90 | 89 | WARN |
| R04 | Credits: raw total = clean total + quarantined total | 51308.49 | 51308.49 | PASS |
| R05 | Method A: max |query-attributed credits - reported credits| per report-period | 0 | 1.136868377e-13 | PASS |
| R06 | Quarantine: rejected query credits = quarantined telemetry credits | 0 | 0 | PASS |
| R07 | Completeness: all query credits = report credits + rejected + unattributed | 53531.35 | 53531.35 | PASS |
| R08 | Method B: idle-loaded credits (all workloads) = metered compute credits | 63765.778548783 | 63765.778548783 | PASS |
| R09 | Method C: time-weighted credits (all workloads) = metered compute credits | 63765.778548783 | 63765.778548783 | PASS |
| R10 | Sanity: warehouse-periods where metered credits < attributed credits | 0 | 0 | PASS |
| R11 | Coverage: report-periods without a fully loaded cost | 0 | 0 | PASS |
| R12 | Imputation: rows flagged is_cost_imputed = rows quarantined | 2 | 2 | PASS |
| R13 | Unit cost: zero-view rows with a non-NULL cost per view | 0 | 0 | PASS |
| R14 | Chargeback: sum of owner lines = total cost of all report-periods | 201188.558117278 | 201188.558117278 | PASS |
| R15 | Simulation: report-periods whose query rows <> GREATEST(1, ROUND(query_count / queries_per_row)) | 0 | 0 | PASS |
| R16 | Catalogue: DIM_REPORT rows = distinct reports | 30 | 30 | PASS |

## DuckDB versus Snowflake

Numeric columns compared with relative tolerance 0.000001.

| Table | Rows compared | Result |
| --- | --- | --- |
| DQ.RULE_SUMMARY | 13 | identical |
| DQ.RECONCILIATION | 16 | identical |
| MART.FCT_REPORT_PERIOD | 89 | identical |
| MART.PERIOD_SUMMARY | 3 | identical |
| MART.CHARGEBACK_OWNER | 16 | identical |
| MART.ORPHAN_QUEUE | 8 | identical |
| MART.REPORT_EFFICIENCY | 30 | identical |
| MART.COST_ANOMALIES | 4 | identical |

Every compared table is identical across the two engines.
