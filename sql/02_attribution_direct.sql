-- =============================================================================
-- 02_attribution_direct.sql — Method A: per-query attribution by QUERY_TAG
--
-- The portal runs every query as one service user, so USER_NAME cannot identify a
-- report. The only reliable handle is a structured QUERY_TAG that the portal sets
-- on its session before each statement, for example
--
--     {"app":"pure-insights","report_id":"RPT_203","component":"dashboard"}
--
-- QUERY_ATTRIBUTION_HISTORY then gives Snowflake's own compute credits per query
-- (warehouse idle time excluded). Summing by the tag's report_id is Method A.
--
-- Credits that cannot be pinned on a catalogued report are not dropped: they are
-- classified and reported as their own buckets, so the totals always reconcile.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STG.QUERY_CLASSIFIED — one row per query: tag parsed, period and class assigned.
-- Built from QUERY_HISTORY (the complete log) and shared by every attribution method,
-- so the classification rules exist in exactly one place.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE STG.QUERY_CLASSIFIED AS
WITH parsed AS (
    SELECT
        q.query_id,
        q.warehouse_id,
        q.warehouse_name,
        q.user_name,
        q.start_time,
        q.end_time,
        q.total_elapsed_time,
        q.query_tag,
        -- TRY_PARSE_JSON returns NULL for free-text tags instead of failing the statement.
        CAST(GET_PATH(TRY_PARSE_JSON(q.query_tag), 'app') AS VARCHAR)        AS tag_app,
        CAST(GET_PATH(TRY_PARSE_JSON(q.query_tag), 'report_id') AS VARCHAR)  AS tag_report_id,
        CAST(GET_PATH(TRY_PARSE_JSON(q.query_tag), 'component') AS VARCHAR)  AS tag_component,
        (TRY_PARSE_JSON(q.query_tag) IS NOT NULL)                            AS is_tag_json
    FROM ACCOUNT_USAGE.QUERY_HISTORY q
    WHERE q.warehouse_id IS NOT NULL
),
catalogue AS (
    SELECT DISTINCT report_id FROM STG.REPORT_TELEMETRY
)
SELECT
    p.query_id,
    p.warehouse_id,
    p.warehouse_name,
    p.user_name,
    p.start_time,
    p.end_time,
    p.total_elapsed_time,
    pc.period_seq,
    p.query_tag,
    p.tag_app,
    p.tag_report_id,
    p.tag_component,
    CASE
        WHEN p.query_tag IS NULL OR TRIM(p.query_tag) = ''             THEN 'UNTAGGED'
        WHEN NOT p.is_tag_json                                         THEN 'UNPARSEABLE_TAG'
        WHEN p.tag_app = 'pure-insights' AND c.report_id IS NOT NULL   THEN 'REPORT'
        WHEN p.tag_app = 'pure-insights'                               THEN 'UNKNOWN_REPORT'
        ELSE 'OTHER_WORKLOAD'
    END AS attribution_class,
    CASE WHEN p.tag_app = 'pure-insights' AND c.report_id IS NOT NULL THEN c.report_id END AS report_id
FROM parsed p
JOIN RAW.PERIOD_CALENDAR pc
  ON p.start_time >= pc.period_start AND p.start_time < pc.period_end
LEFT JOIN catalogue c
  ON c.report_id = p.tag_report_id;

-- -----------------------------------------------------------------------------
-- STG.QUERY_ATTRIBUTION — Snowflake's per-query compute credits, classified.
-- A negative attributed credit is invalid: kept for audit, excluded from sums.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE STG.QUERY_ATTRIBUTION AS
SELECT
    qc.query_id,
    qc.warehouse_id,
    qc.warehouse_name,
    qc.period_seq,
    qc.attribution_class,
    qc.report_id,
    qc.tag_app,
    qc.tag_report_id,
    qc.tag_component,
    qa.credits_attributed_compute,
    -- NULL (no figure at all) and negative are both unusable; the flag itself is never NULL.
    COALESCE(qa.credits_attributed_compute >= 0, FALSE) AS is_credit_valid
FROM ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY qa
JOIN STG.QUERY_CLASSIFIED qc ON qc.query_id = qa.query_id;

-- -----------------------------------------------------------------------------
-- MART.CREDITS_DIRECT — Method A result, one row per report per period.
-- credits_direct is NULL (not 0) when a report-period has no valid credit rows.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.CREDITS_DIRECT AS
SELECT
    report_id,
    period_seq,
    COUNT(*)                                                                             AS query_rows,
    SUM(CASE WHEN is_credit_valid THEN credits_attributed_compute END)                   AS credits_direct,
    SUM(CASE WHEN is_credit_valid AND tag_component = 'dashboard' THEN credits_attributed_compute END) AS credits_dashboard,
    SUM(CASE WHEN is_credit_valid AND tag_component = 'refresh'   THEN credits_attributed_compute END) AS credits_refresh,
    SUM(CASE WHEN NOT is_credit_valid THEN credits_attributed_compute END)               AS credits_rejected,
    SUM(CASE WHEN NOT is_credit_valid THEN 1 ELSE 0 END)                                 AS query_rows_rejected
FROM STG.QUERY_ATTRIBUTION
WHERE attribution_class = 'REPORT'
GROUP BY report_id, period_seq;

-- -----------------------------------------------------------------------------
-- MART.CREDITS_UNATTRIBUTED — everything Method A could not give to a report
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.CREDITS_UNATTRIBUTED AS
SELECT
    period_seq,
    attribution_class,
    COALESCE(tag_app, '(none)')                 AS tag_app,
    COALESCE(tag_report_id, '(none)')           AS tag_report_id,
    COUNT(*)                                    AS query_rows,
    SUM(credits_attributed_compute)             AS credits
FROM STG.QUERY_ATTRIBUTION
WHERE attribution_class <> 'REPORT'
GROUP BY period_seq, attribution_class, COALESCE(tag_app, '(none)'), COALESCE(tag_report_id, '(none)');
