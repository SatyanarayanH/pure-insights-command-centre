# Snowflake validation run

Run at 2026-10-13T15:53:05.734Z against Snowflake 10.37.100 in AWS_AP_SOUTHEAST_7, warehouse COMPUTE_WH, database PURE_INSIGHTS_SIM.

The same SQL files were executed on DuckDB and on Snowflake, from the same generated input files, and every mart was compared row by row.

## Suite execution on Snowflake

| File | Statements | Duration (ms) |
| --- | --- | --- |
| 00_setup.sql | 14 | 2834 |
| loaders/snowflake_load.sql | 14 | 22571 |
| 01_staging_clean.sql | 6 | 3228 |
| 02_attribution_direct.sql | 4 | 3182 |
| 03_attribution_time_weighted.sql | 6 | 3970 |
| 04_unit_economics.sql | 4 | 2883 |
| 05_chargeback.sql | 3 | 1634 |
| 06_cost_anomalies.sql | 3 | 2021 |
| 07_reconciliation_tests.sql | 1 | 1548 |

Total: 44125 ms on Snowflake, 1354 ms on DuckDB.

## Reconciliation checks on Snowflake

| Check | What is verified | Expected | Actual | Status |
| --- | --- | --- | --- | --- |
| R01 | Row count: RAW landed rows = STG rows | 2000 | 2000 | PASS |
| R02 | Grain: (report_id, period_seq) is unique in STG | 2000 | 2000 | PASS |
| R03 | Panel: rows = distinct reports x distinct periods | 2000 | 2000 | PASS |
| R04 | Credits: raw total = clean total + quarantined total | 1206191.44 | 1206191.44 | PASS |
| R05 | Method A: max |query-attributed credits - reported credits| per report-period | 0 | 2.273736754e-13 | PASS |
| R06 | Quarantine: rejected query credits = quarantined telemetry credits | -161.04 | -161.04 | PASS |
| R07 | Completeness: all query credits = report credits + rejected + unattributed | 1259535.23 | 1259535.23 | PASS |
| R08 | Method B: idle-loaded credits (all workloads) = metered compute credits | 1490481.30595409 | 1490481.30595409 | PASS |
| R09 | Method C: time-weighted credits (all workloads) = metered compute credits | 1490481.30595409 | 1490481.30595409 | PASS |
| R10 | Sanity: warehouse-periods where metered credits < attributed credits | 0 | 0 | PASS |
| R11 | Coverage: report-periods without a fully loaded cost | 0 | 0 | PASS |
| R12 | Imputation: rows flagged is_cost_imputed = rows quarantined | 24 | 24 | PASS |
| R13 | Unit cost: zero-view rows with a non-NULL cost per view | 0 | 0 | PASS |
| R14 | Chargeback: sum of owner lines = total cost of all report-periods | 4793240.45417921 | 4793240.45417921 | PASS |
| R15 | Simulation: report-periods whose query rows <> GREATEST(1, ROUND(query_count / queries_per_row)) | 0 | 0 | PASS |
| R16 | Catalogue: DIM_REPORT rows = distinct reports | 100 | 100 | PASS |

## DuckDB versus Snowflake

Numeric columns compared with relative tolerance 0.000001.

| Table | Rows compared | Result |
| --- | --- | --- |
| DQ.RULE_SUMMARY | 12 | identical |
| DQ.RECONCILIATION | 16 | identical |
| MART.FCT_REPORT_PERIOD | 2000 | identical |
| MART.PERIOD_SUMMARY | 20 | identical |
| MART.CHARGEBACK_OWNER | 15 | identical |
| MART.ORPHAN_QUEUE | 14 | identical |
| MART.REPORT_EFFICIENCY | 100 | identical |
| MART.COST_ANOMALIES | 5 | identical |

Every compared table is identical across the two engines.
