-- =============================================================================
-- 07_reconciliation_tests.sql — the suite checks its own arithmetic
--
-- Each check writes one row to DQ.RECONCILIATION with an expected value, an actual
-- value and PASS / FAIL. The runners (DuckDB and Snowflake) read this table last
-- and exit non-zero if any row is FAIL, so a broken allocation cannot ship quietly.
--
-- The guiding question for a cost model: can every credit on the bill be traced to
-- exactly one line, and does nothing get counted twice or dropped?
-- =============================================================================

CREATE OR REPLACE TABLE DQ.RECONCILIATION AS
WITH checks AS (

    -- R01  Nothing is lost between landing and staging.
    SELECT 'R01' AS check_id,
           'Row count: RAW landed rows = STG rows' AS description,
           CAST((SELECT COUNT(*) FROM RAW.REPORT_TELEMETRY) AS DOUBLE) AS expected_value,
           CAST((SELECT COUNT(*) FROM STG.REPORT_TELEMETRY) AS DOUBLE) AS actual_value,
           0.0 AS tolerance

    UNION ALL
    -- R02  (report_id, period_seq) is a key: no report appears twice in a period.
    SELECT 'R02',
           'Grain: (report_id, period_seq) is unique in STG',
           CAST((SELECT COUNT(*) FROM STG.REPORT_TELEMETRY) AS DOUBLE),
           CAST((SELECT COUNT(*) FROM (SELECT DISTINCT report_id, period_seq FROM STG.REPORT_TELEMETRY) k) AS DOUBLE),
           0.0

    UNION ALL
    -- R03  The panel is complete: every report is present in every period.
    SELECT 'R03',
           'Panel: rows = distinct reports x distinct periods',
           CAST((SELECT COUNT(DISTINCT report_id) * COUNT(DISTINCT period_seq) FROM STG.REPORT_TELEMETRY) AS DOUBLE),
           CAST((SELECT COUNT(*) FROM STG.REPORT_TELEMETRY) AS DOUBLE),
           0.0

    UNION ALL
    -- R04  Quarantine is an exact partition: raw credits = clean credits + quarantined credits.
    SELECT 'R04',
           'Credits: raw total = clean total + quarantined total',
           (SELECT SUM(credits_raw) FROM STG.REPORT_TELEMETRY),
           (SELECT SUM(credits_clean) FROM STG.REPORT_TELEMETRY)
             + (SELECT COALESCE(SUM(credits_raw), 0) FROM DQ.QUARANTINE),
           (SELECT reconciliation_tolerance FROM CONFIG.COST_PARAMS)

    UNION ALL
    -- R05  Method A reproduces the telemetry figure for every valid report-period.
    SELECT 'R05',
           'Method A: max |query-attributed credits - reported credits| per report-period',
           0.0,
           (SELECT MAX(ABS(d.credits_direct - s.credits_clean))
            FROM STG.REPORT_TELEMETRY s
            JOIN MART.CREDITS_DIRECT d ON d.report_id = s.report_id AND d.period_seq = s.period_seq
            WHERE s.credits_clean IS NOT NULL),
           (SELECT reconciliation_tolerance FROM CONFIG.COST_PARAMS)

    UNION ALL
    -- R06  The query log rejects exactly the credits the telemetry quarantine rejected.
    SELECT 'R06',
           'Quarantine: rejected query credits = quarantined telemetry credits',
           (SELECT COALESCE(SUM(credits_raw), 0) FROM DQ.QUARANTINE),
           (SELECT COALESCE(SUM(credits_rejected), 0) FROM MART.CREDITS_DIRECT),
           (SELECT reconciliation_tolerance FROM CONFIG.COST_PARAMS)

    UNION ALL
    -- R07  Every attributed credit lands in exactly one bucket (reports + unattributed classes).
    SELECT 'R07',
           'Completeness: all query credits = report credits + rejected + unattributed',
           (SELECT SUM(credits_attributed_compute) FROM ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY),
           (SELECT SUM(COALESCE(credits_direct, 0) + COALESCE(credits_rejected, 0)) FROM MART.CREDITS_DIRECT)
             + (SELECT COALESCE(SUM(credits), 0) FROM MART.CREDITS_UNATTRIBUTED),
           (SELECT reconciliation_tolerance FROM CONFIG.COST_PARAMS)

    UNION ALL
    -- R08  Method B redistributes the metered bill without creating or losing credits.
    SELECT 'R08',
           'Method B: idle-loaded credits (all workloads) = metered compute credits',
           (SELECT SUM(credits_metered_compute) FROM STG.WAREHOUSE_PERIOD),
           (SELECT SUM(qa.credits_attributed_compute * wp.overhead_factor)
            FROM STG.QUERY_ATTRIBUTION qa
            JOIN STG.WAREHOUSE_PERIOD wp
              ON wp.period_seq = qa.period_seq AND wp.warehouse_id = qa.warehouse_id
            WHERE qa.is_credit_valid),
           (SELECT reconciliation_tolerance FROM CONFIG.COST_PARAMS)

    UNION ALL
    -- R09  Method C allocates every metered warehouse-hour in full.
    SELECT 'R09',
           'Method C: time-weighted credits (all workloads) = metered compute credits',
           (SELECT SUM(credits_used_compute) FROM ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY),
           (SELECT SUM(credits_time_weighted) FROM STG.QUERY_HOUR_ALLOCATION),
           (SELECT reconciliation_tolerance FROM CONFIG.COST_PARAMS)

    UNION ALL
    -- R10  A warehouse never bills less than its queries used: overhead factor >= 1 everywhere.
    SELECT 'R10',
           'Sanity: warehouse-periods where metered credits < attributed credits',
           0.0,
           CAST((SELECT COUNT(*) FROM STG.WAREHOUSE_PERIOD WHERE overhead_factor < 1) AS DOUBLE),
           0.0

    UNION ALL
    -- R11  Every report-period carries a cost estimate, including the quarantined ones.
    SELECT 'R11',
           'Coverage: report-periods without a fully loaded cost',
           0.0,
           CAST((SELECT COUNT(*) FROM MART.FCT_REPORT_PERIOD WHERE credits_fully_loaded IS NULL) AS DOUBLE),
           0.0

    UNION ALL
    -- R12  Quarantined rows are imputed and flagged, and only those rows.
    SELECT 'R12',
           'Imputation: rows flagged is_cost_imputed = rows quarantined',
           CAST((SELECT COUNT(*) FROM DQ.QUARANTINE) AS DOUBLE),
           CAST((SELECT COUNT(*) FROM MART.FCT_REPORT_PERIOD WHERE is_cost_imputed) AS DOUBLE),
           0.0

    UNION ALL
    -- R13  Zero views never produces a unit cost (no divide-by-zero, no infinity).
    SELECT 'R13',
           'Unit cost: zero-view rows with a non-NULL cost per view',
           0.0,
           CAST((SELECT COUNT(*) FROM MART.FCT_REPORT_PERIOD
                 WHERE is_zero_views
                   AND (snowflake_cost_per_view_usd IS NOT NULL OR total_cost_per_view_usd IS NOT NULL)) AS DOUBLE),
           0.0

    UNION ALL
    -- R14  Chargeback lines add back up to the fact table.
    SELECT 'R14',
           'Chargeback: sum of owner lines = total cost of all report-periods',
           (SELECT SUM(total_cost_usd) FROM MART.FCT_REPORT_PERIOD),
           (SELECT SUM(total_cost_usd) FROM MART.CHARGEBACK_OWNER),
           (SELECT reconciliation_tolerance FROM CONFIG.COST_PARAMS)

    UNION ALL
    -- R15  The simulated query log has the row count the scale parameter implies.
    SELECT 'R15',
           'Simulation: report-periods whose query rows <> GREATEST(1, ROUND(query_count / queries_per_row))',
           0.0,
           CAST((SELECT COUNT(*)
                 FROM STG.REPORT_TELEMETRY s
                 CROSS JOIN CONFIG.SIM_PARAMS sp
                 LEFT JOIN MART.CREDITS_DIRECT d
                   ON d.report_id = s.report_id AND d.period_seq = s.period_seq
                 WHERE COALESCE(d.query_rows, 0)
                       <> GREATEST(1, CAST(ROUND(s.query_count_last_30d / sp.queries_per_row) AS INTEGER))) AS DOUBLE),
           0.0

    UNION ALL
    -- R16  The catalogue has one current row per report.
    SELECT 'R16',
           'Catalogue: DIM_REPORT rows = distinct reports',
           CAST((SELECT COUNT(DISTINCT report_id) FROM STG.REPORT_TELEMETRY) AS DOUBLE),
           CAST((SELECT COUNT(*) FROM MART.DIM_REPORT) AS DOUBLE),
           0.0
)
SELECT
    check_id,
    description,
    expected_value,
    actual_value,
    actual_value - expected_value AS difference,
    tolerance,
    CASE
        WHEN actual_value IS NULL OR expected_value IS NULL       THEN 'FAIL'
        WHEN ABS(actual_value - expected_value) <= tolerance      THEN 'PASS'
        ELSE 'FAIL'
    END AS status
FROM checks;
