# SQL suite on DuckDB

`npm run sql:duckdb`, 2026-10-13T20:06Z.

```
ACCOUNT_USAGE simulation reused: 253,593 query rows, 27,594 metered warehouse-hours
┌─────────┬────────────────────────────────────┬────────────┬────────────┐
│ (index) │ file                               │ statements │ durationMs │
├─────────┼────────────────────────────────────┼────────────┼────────────┤
│ 0       │ '00_setup.sql'                     │ 14         │ 2          │
│ 1       │ 'loaders/duckdb_load.sql'          │ 8          │ 813        │
│ 2       │ '01_staging_clean.sql'             │ 6          │ 16         │
│ 3       │ '02_attribution_direct.sql'        │ 4          │ 224        │
│ 4       │ '03_attribution_time_weighted.sql' │ 6          │ 119        │
│ 5       │ '04_unit_economics.sql'            │ 4          │ 12         │
│ 6       │ '05_chargeback.sql'                │ 3          │ 5          │
│ 7       │ '06_cost_anomalies.sql'            │ 3          │ 3          │
│ 8       │ '07_reconciliation_tests.sql'      │ 1          │ 6          │
└─────────┴────────────────────────────────────┴────────────┴────────────┘
┌─────────┬───────┬────────────────────────────────────────────────────────────────────────────────────────────────────┬─────────────────────┬────────────────────────┬────────┐
│ (index) │ check │ description                                                                                        │ expected            │ actual                 │ status │
├─────────┼───────┼────────────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────┼────────┤
│ 0       │ 'R01' │ 'Row count: RAW landed rows = STG rows'                                                            │ 2000                │ 2000                   │ 'PASS' │
│ 1       │ 'R02' │ 'Grain: (report_id, period_seq) is unique in STG'                                                  │ 2000                │ 2000                   │ 'PASS' │
│ 2       │ 'R03' │ 'Panel: rows = distinct reports x distinct periods'                                                │ 2000                │ 2000                   │ 'PASS' │
│ 3       │ 'R04' │ 'Credits: raw total = clean total + quarantined total'                                             │ 1206191.4399999997  │ 1206191.4399999997     │ 'PASS' │
│ 4       │ 'R05' │ 'Method A: max |query-attributed credits - reported credits| per report-period'                    │ 0                   │ 1.2505552149377763e-12 │ 'PASS' │
│ 5       │ 'R06' │ 'Quarantine: rejected query credits = quarantined telemetry credits'                               │ -161.04000000000002 │ -161.03999999999996    │ 'PASS' │
│ 6       │ 'R07' │ 'Completeness: all query credits = report credits + rejected + unattributed'                       │ 1259535.2299999953  │ 1259535.2300000004     │ 'PASS' │
│ 7       │ 'R08' │ 'Method B: idle-loaded credits (all workloads) = metered compute credits'                          │ 1490481.3059540924  │ 1490481.3059540864     │ 'PASS' │
│ 8       │ 'R09' │ 'Method C: time-weighted credits (all workloads) = metered compute credits'                        │ 1490481.3059540975  │ 1490481.3059540833     │ 'PASS' │
│ 9       │ 'R10' │ 'Sanity: warehouse-periods where metered credits < attributed credits'                             │ 0                   │ 0                      │ 'PASS' │
│ 10      │ 'R11' │ 'Coverage: report-periods without a fully loaded cost'                                             │ 0                   │ 0                      │ 'PASS' │
│ 11      │ 'R12' │ 'Imputation: rows flagged is_cost_imputed = rows quarantined'                                      │ 24                  │ 24                     │ 'PASS' │
│ 12      │ 'R13' │ 'Unit cost: zero-view rows with a non-NULL cost per view'                                          │ 0                   │ 0                      │ 'PASS' │
│ 13      │ 'R14' │ 'Chargeback: sum of owner lines = total cost of all report-periods'                                │ 4793240.4541792115  │ 4793240.454179209      │ 'PASS' │
│ 14      │ 'R15' │ 'Simulation: report-periods whose query rows <> GREATEST(1, ROUND(query_count / queries_per_row))' │ 0                   │ 0                      │ 'PASS' │
│ 15      │ 'R16' │ 'Catalogue: DIM_REPORT rows = distinct reports'                                                    │ 100                 │ 100                    │ 'PASS' │
└─────────┴───────┴────────────────────────────────────────────────────────────────────────────────────────────────────┴─────────────────────┴────────────────────────┴────────┘
Suite passed on duckdb in 1204 ms.
```
