# The application reading from Snowflake

Run at 2026-10-13T19:40:50.245Z against Snowflake database PURE_INSIGHTS_SIM, through the adapter the server uses when started with `WAREHOUSE=snowflake`.

Reading everything the application needs took 9999 ms: 17 result sets, 10,194 rows.

## Snapshot read from Snowflake versus the one built on DuckDB

Every value of every row, numbers compared with relative tolerance 0.000001.

| Part of the snapshot | Rows | Values compared | Result |
| --- | --- | --- | --- |
| `params` | 1 | 9 | identical |
| `methods` | 1 | 5 | identical |
| `dim` | 100 | 4,900 | identical |
| `facts` | 2000 | 78,000 | identical |
| `efficiency` | 100 | 900 | identical |
| `ownershipHistory` | 2000 | 8,000 | identical |
| `periodSummary` | 20 | 140 | identical |
| `unattributed` | 4 | 20 | identical |
| `correlations` | 5 | 20 | identical |
| `orphanQueue` | 14 | 238 | identical |
| `chargebackOwners` | 15 | 180 | identical |
| `chargebackLatest` | 15 | 30 | identical |
| `anomalies` | 48 | 336 | identical |
| `dqRules` | 13 | 130 | identical |
| `dqFindings` | 5818 | 34,908 | identical |
| `quarantine` | 24 | 168 | identical |
| `reconciliation` | 16 | 112 | identical |

The application holds exactly the same data whichever engine it reads from.

## The application running on it

| Check | Result |  |
| --- | --- | --- |
| The server reports Snowflake as its source | source snowflake, 16/16 reconciliation checks pass, marts built 2026-10-13T19:40:18.411Z | PASS |
| Overview is served from it | 100 reports, total cost $248,044 for P20 | PASS |
| Cost summary is served from it | 20 periods, credit price $3 | PASS |
| Data-quality summary is served from it | 13 rules, 24 rows quarantined, engine "snowflake" | PASS |
| A report page is served from it | RPT_200: 20 periods of history | PASS |
| A refresh re-reads Snowflake while the application keeps running | outcome "unchanged" in 7291 ms (the marts have not been rebuilt since the first read) | PASS |
