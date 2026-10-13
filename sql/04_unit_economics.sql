-- =============================================================================
-- 04_unit_economics.sql — cost per active view, and the marts the app reads
--
-- Two credit bases are kept apart on purpose:
--
--   credits_attributed    Method A. What Snowflake attributes to the report's own
--                         queries. NULL when the source figure was quarantined:
--                         no imputation, so it can be published without caveats.
--
--   credits_fully_loaded  Method B (idle-loaded), falling back to Method C
--                         (time-weighted) when Method A has nothing valid. This is
--                         the best estimate of what the report really cost on the
--                         bill; is_cost_imputed marks the fallback rows.
--
-- Unit cost per active view (the brief's headline metric) is published on both
-- bases. Every division goes through NULLIF so zero views yields NULL, not an error.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- MART.FCT_REPORT_PERIOD — one row per report per period (2,000 rows)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.FCT_REPORT_PERIOD AS
WITH costed AS (
    SELECT
        s.*,
        d.query_rows,
        d.credits_dashboard,
        d.credits_refresh,
        d.credits_direct                                                AS credits_attributed,
        ac.credits_idle_loaded,
        ac.credits_time_weighted,
        COALESCE(ac.credits_idle_loaded, ac.credits_time_weighted)      AS credits_fully_loaded,
        (ac.credits_idle_loaded IS NULL AND ac.credits_time_weighted IS NOT NULL) AS is_cost_imputed,
        p.credit_price_usd
    FROM STG.REPORT_TELEMETRY s
    LEFT JOIN MART.CREDITS_DIRECT d
      ON d.report_id = s.report_id AND d.period_seq = s.period_seq
    LEFT JOIN MART.ATTRIBUTION_COMPARISON ac
      ON ac.report_id = s.report_id AND ac.period_seq = s.period_seq
    CROSS JOIN CONFIG.COST_PARAMS p
)
SELECT
    report_id,
    report_name,
    period_seq,
    period_start,
    period_end,
    row_seq,

    owner_email,
    is_orphaned,
    orphan_encoding,

    refresh_status,
    is_refresh_failure,
    is_refresh_unknown,

    avg_load_time_sec,
    is_latency_breach,
    latency_severity,

    monthly_active_views,
    query_count_last_30d,
    concurrent_user_peak,
    is_zero_views,
    is_concurrency_gt_views,

    -- credits
    credits_raw                                                     AS credits_reported,
    is_cost_quarantined,
    credits_attributed,
    credits_dashboard,
    credits_refresh,
    credits_idle_loaded,
    credits_time_weighted,
    credits_fully_loaded,
    is_cost_imputed,

    -- dollars
    credits_attributed * credit_price_usd                           AS snowflake_cost_usd,
    credits_fully_loaded * credit_price_usd                         AS snowflake_cost_loaded_usd,
    aws_hosting_cost_usd,
    credits_fully_loaded * credit_price_usd + aws_hosting_cost_usd  AS total_cost_usd,

    -- unit economics
    credits_attributed / NULLIF(monthly_active_views, 0)                            AS credits_per_view,
    credits_attributed * credit_price_usd / NULLIF(monthly_active_views, 0)         AS snowflake_cost_per_view_usd,
    aws_hosting_cost_usd / NULLIF(monthly_active_views, 0)                          AS aws_cost_per_view_usd,
    (credits_fully_loaded * credit_price_usd + aws_hosting_cost_usd)
        / NULLIF(monthly_active_views, 0)                                           AS total_cost_per_view_usd,
    credits_attributed * credit_price_usd / NULLIF(query_count_last_30d, 0)         AS snowflake_cost_per_query_usd,
    (credits_fully_loaded * credit_price_usd + aws_hosting_cost_usd)
        / NULLIF(concurrent_user_peak, 0)                                           AS total_cost_per_peak_user_usd
FROM costed;

-- -----------------------------------------------------------------------------
-- MART.OWNERSHIP_HISTORY — who owned each report in each period, and what changed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.OWNERSHIP_HISTORY AS
WITH lagged AS (
    SELECT
        report_id,
        period_seq,
        owner_email,
        is_orphaned,
        LAG(owner_email) OVER (PARTITION BY report_id ORDER BY period_seq) AS previous_owner
    FROM STG.REPORT_TELEMETRY
)
SELECT
    report_id,
    period_seq,
    owner_email,
    previous_owner,
    is_orphaned,
    CASE
        WHEN period_seq = 0 AND owner_email IS NULL                    THEN 'INITIAL_ORPHANED'
        WHEN period_seq = 0                                            THEN 'INITIAL'
        WHEN owner_email IS NULL AND previous_owner IS NULL            THEN 'STILL_ORPHANED'
        WHEN owner_email IS NULL                                       THEN 'ORPHANED'
        WHEN previous_owner IS NULL                                    THEN 'CLAIMED'
        WHEN owner_email <> previous_owner                             THEN 'REASSIGNED'
        ELSE 'UNCHANGED'
    END AS change_type
FROM lagged;

-- -----------------------------------------------------------------------------
-- MART.DIM_REPORT — current state of each report (latest period) plus its history
-- rolled up. This is the report catalogue the dashboard lists.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.DIM_REPORT AS
WITH latest AS (
    SELECT *
    FROM MART.FCT_REPORT_PERIOD
    QUALIFY ROW_NUMBER() OVER (PARTITION BY report_id ORDER BY period_seq DESC) = 1
),
history AS (
    SELECT
        report_id,
        COUNT(*)                                                        AS periods_observed,
        SUM(CASE WHEN is_orphaned THEN 1 ELSE 0 END)                    AS periods_orphaned,
        COUNT(DISTINCT owner_email)                                     AS distinct_owners,
        SUM(CASE WHEN is_refresh_failure THEN 1 ELSE 0 END)             AS refresh_failures_total,
        SUM(CASE WHEN is_refresh_unknown THEN 1 ELSE 0 END)             AS refresh_unknown_total,
        SUM(CASE WHEN is_latency_breach THEN 1 ELSE 0 END)              AS latency_breaches_total,
        MEDIAN(avg_load_time_sec)                                       AS median_load_time_sec,
        MAX(avg_load_time_sec)                                          AS max_load_time_sec,
        AVG(monthly_active_views)                                       AS avg_monthly_views,
        SUM(monthly_active_views)                                       AS lifetime_views,
        SUM(credits_attributed)                                         AS lifetime_credits_attributed,
        SUM(credits_fully_loaded)                                       AS lifetime_credits_fully_loaded,
        SUM(total_cost_usd)                                             AS lifetime_total_cost_usd,
        SUM(total_cost_usd) / NULLIF(SUM(monthly_active_views), 0)      AS lifetime_cost_per_view_usd,
        SUM(CASE WHEN is_cost_quarantined THEN 1 ELSE 0 END)            AS periods_cost_quarantined,
        -- Consecutive failed refreshes ending at the latest period.
        MAX(period_seq) - COALESCE(MAX(CASE WHEN NOT is_refresh_failure THEN period_seq END), -1) AS refresh_failure_streak
    FROM MART.FCT_REPORT_PERIOD
    GROUP BY report_id
),
changes AS (
    SELECT
        report_id,
        SUM(CASE WHEN change_type IN ('REASSIGNED', 'ORPHANED', 'CLAIMED') THEN 1 ELSE 0 END) AS ownership_changes
    FROM MART.OWNERSHIP_HISTORY
    GROUP BY report_id
),
last_owner AS (
    -- Most recent named owner. For a report that is orphaned now, this is the person to ask.
    SELECT report_id, owner_email AS last_known_owner, period_seq AS last_known_owner_period
    FROM STG.REPORT_TELEMETRY
    WHERE owner_email IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY report_id ORDER BY period_seq DESC) = 1
),
owner_counts AS (
    SELECT report_id, owner_email, COUNT(*) AS periods_owned, MAX(period_seq) AS last_period
    FROM STG.REPORT_TELEMETRY
    WHERE owner_email IS NOT NULL
    GROUP BY report_id, owner_email
),
frequent_owner AS (
    SELECT report_id, owner_email AS most_frequent_owner, periods_owned AS most_frequent_owner_periods
    FROM owner_counts
    QUALIFY ROW_NUMBER() OVER (PARTITION BY report_id ORDER BY periods_owned DESC, last_period DESC) = 1
)
SELECT
    l.report_id,
    l.report_name,
    l.period_seq                        AS latest_period_seq,
    l.period_start                      AS latest_period_start,
    l.period_end                        AS latest_period_end,

    l.owner_email,
    l.is_orphaned,
    l.orphan_encoding,
    lo.last_known_owner,
    lo.last_known_owner_period,
    fo.most_frequent_owner,
    fo.most_frequent_owner_periods,
    h.distinct_owners,
    c.ownership_changes,
    h.periods_orphaned,

    l.refresh_status,
    l.is_refresh_failure,
    l.is_refresh_unknown,
    h.refresh_failure_streak,
    h.refresh_failures_total,
    h.refresh_unknown_total,

    l.avg_load_time_sec,
    l.is_latency_breach,
    l.latency_severity,
    h.median_load_time_sec,
    h.max_load_time_sec,
    h.latency_breaches_total,

    l.monthly_active_views,
    l.query_count_last_30d,
    l.concurrent_user_peak,
    h.avg_monthly_views,
    h.lifetime_views,

    l.credits_reported,
    l.is_cost_quarantined,
    l.is_cost_imputed,
    l.credits_attributed,
    l.credits_fully_loaded,
    l.snowflake_cost_usd,
    l.snowflake_cost_loaded_usd,
    l.aws_hosting_cost_usd,
    l.total_cost_usd,
    l.snowflake_cost_per_view_usd,
    l.total_cost_per_view_usd,
    h.lifetime_credits_attributed,
    h.lifetime_credits_fully_loaded,
    h.lifetime_total_cost_usd,
    h.lifetime_cost_per_view_usd,
    h.periods_cost_quarantined,
    h.periods_observed
FROM latest l
JOIN history h              ON h.report_id = l.report_id
JOIN changes c              ON c.report_id = l.report_id
LEFT JOIN last_owner lo     ON lo.report_id = l.report_id
LEFT JOIN frequent_owner fo ON fo.report_id = l.report_id;

-- -----------------------------------------------------------------------------
-- MART.PERIOD_SUMMARY — platform totals per period, including the credits that
-- never reach a report (idle time, untagged and unknown workloads)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.PERIOD_SUMMARY AS
WITH reports AS (
    SELECT
        period_seq,
        MIN(period_start)                                               AS period_start,
        MIN(period_end)                                                 AS period_end,
        COUNT(*)                                                        AS reports,
        SUM(CASE WHEN is_orphaned THEN 1 ELSE 0 END)                    AS reports_orphaned,
        SUM(CASE WHEN refresh_status = 'FAILED' THEN 1 ELSE 0 END)      AS refresh_failed,
        SUM(CASE WHEN refresh_status = 'TIMED_OUT' THEN 1 ELSE 0 END)   AS refresh_timed_out,
        SUM(CASE WHEN refresh_status = 'UNKNOWN' THEN 1 ELSE 0 END)     AS refresh_unknown,
        SUM(CASE WHEN is_latency_breach THEN 1 ELSE 0 END)              AS latency_breaches,
        SUM(CASE WHEN latency_severity = 'CRITICAL' THEN 1 ELSE 0 END)  AS latency_critical,
        SUM(CASE WHEN is_cost_quarantined THEN 1 ELSE 0 END)            AS reports_cost_quarantined,
        MEDIAN(avg_load_time_sec)                                       AS median_load_time_sec,
        SUM(monthly_active_views)                                       AS views,
        SUM(query_count_last_30d)                                       AS queries,
        SUM(credits_attributed)                                         AS credits_attributed_reports,
        SUM(credits_fully_loaded)                                       AS credits_fully_loaded_reports,
        SUM(CASE WHEN is_orphaned THEN credits_fully_loaded END)        AS credits_fully_loaded_orphaned,
        SUM(snowflake_cost_loaded_usd)                                  AS snowflake_cost_loaded_usd,
        SUM(aws_hosting_cost_usd)                                       AS aws_hosting_cost_usd,
        SUM(total_cost_usd)                                             AS total_cost_usd,
        SUM(CASE WHEN is_orphaned THEN total_cost_usd END)              AS total_cost_orphaned_usd,
        SUM(total_cost_usd) / NULLIF(SUM(monthly_active_views), 0)      AS total_cost_per_view_usd
    FROM MART.FCT_REPORT_PERIOD
    GROUP BY period_seq
),
warehouses AS (
    SELECT
        period_seq,
        SUM(credits_metered_compute)    AS credits_metered_compute,
        SUM(credits_cloud_services)     AS credits_cloud_services,
        SUM(credits_idle)               AS credits_idle
    FROM STG.WAREHOUSE_PERIOD
    GROUP BY period_seq
),
unattributed AS (
    SELECT period_seq, SUM(credits) AS credits_unattributed
    FROM MART.CREDITS_UNATTRIBUTED
    GROUP BY period_seq
)
SELECT
    r.*,
    w.credits_metered_compute,
    w.credits_cloud_services,
    w.credits_idle,
    COALESCE(u.credits_unattributed, 0)                             AS credits_unattributed,
    w.credits_idle / NULLIF(w.credits_metered_compute, 0)           AS idle_share_of_metered,
    r.credits_attributed_reports / NULLIF(w.credits_metered_compute, 0) AS attributed_share_of_metered
FROM reports r
LEFT JOIN warehouses w   ON w.period_seq = r.period_seq
LEFT JOIN unattributed u ON u.period_seq = r.period_seq;
