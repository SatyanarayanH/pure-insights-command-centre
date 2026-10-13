-- =============================================================================
-- 05_chargeback.sql — who pays, and what nobody is paying for
--
-- Showback by owner on the fully loaded basis, so the owner lines add up to the
-- metered bill for report workloads. Reports with no owner are not hidden inside
-- an average: they form their own "(unowned)" line, which is the number that makes
-- orphaned reports a budget problem rather than a tidiness problem.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- MART.CHARGEBACK_OWNER_PERIOD — cost per owner per period
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.CHARGEBACK_OWNER_PERIOD AS
WITH by_owner AS (
    SELECT
        period_seq,
        COALESCE(owner_email, '(unowned)')          AS owner_key,
        MAX(CASE WHEN is_orphaned THEN 1 ELSE 0 END) = 1 AS is_unowned,
        COUNT(*)                                    AS reports,
        SUM(monthly_active_views)                   AS views,
        SUM(credits_attributed)                     AS credits_attributed,
        SUM(credits_fully_loaded)                   AS credits_fully_loaded,
        SUM(snowflake_cost_loaded_usd)              AS snowflake_cost_loaded_usd,
        SUM(aws_hosting_cost_usd)                   AS aws_hosting_cost_usd,
        SUM(total_cost_usd)                         AS total_cost_usd
    FROM MART.FCT_REPORT_PERIOD
    GROUP BY period_seq, COALESCE(owner_email, '(unowned)')
)
SELECT
    b.*,
    b.total_cost_usd / NULLIF(b.views, 0)                                       AS total_cost_per_view_usd,
    b.total_cost_usd / NULLIF(SUM(b.total_cost_usd) OVER (PARTITION BY b.period_seq), 0) AS share_of_period_cost
FROM by_owner b;

-- -----------------------------------------------------------------------------
-- MART.CHARGEBACK_OWNER — the same, rolled up over all periods
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.CHARGEBACK_OWNER AS
WITH rolled AS (
    SELECT
        owner_key,
        is_unowned,
        COUNT(DISTINCT period_seq)          AS periods,
        SUM(reports)                        AS report_periods,
        SUM(views)                          AS views,
        SUM(credits_attributed)             AS credits_attributed,
        SUM(credits_fully_loaded)           AS credits_fully_loaded,
        SUM(snowflake_cost_loaded_usd)      AS snowflake_cost_loaded_usd,
        SUM(aws_hosting_cost_usd)           AS aws_hosting_cost_usd,
        SUM(total_cost_usd)                 AS total_cost_usd
    FROM MART.CHARGEBACK_OWNER_PERIOD
    GROUP BY owner_key, is_unowned
)
SELECT
    r.*,
    r.total_cost_usd / NULLIF(r.views, 0)                       AS total_cost_per_view_usd,
    r.total_cost_usd / NULLIF(SUM(r.total_cost_usd) OVER (), 0) AS share_of_total_cost
FROM rolled r;

-- -----------------------------------------------------------------------------
-- MART.ORPHAN_QUEUE — reports with no owner right now, worst first
--
-- cost_at_risk is the run-rate (average of the last run_rate_periods) rather than
-- one period, so a single quiet month does not push an expensive report down the
-- list. suggested_owner is the last person who was named owner: the dataset's own
-- history is the best lead on who to ask.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.ORPHAN_QUEUE AS
WITH run_rate AS (
    SELECT
        f.report_id,
        AVG(f.total_cost_usd)           AS run_rate_total_cost_usd,
        AVG(f.credits_fully_loaded)     AS run_rate_credits_fully_loaded,
        AVG(f.monthly_active_views)     AS run_rate_views
    FROM MART.FCT_REPORT_PERIOD f
    JOIN MART.DIM_REPORT d ON d.report_id = f.report_id
    CROSS JOIN CONFIG.COST_PARAMS p
    WHERE f.period_seq > d.latest_period_seq - p.run_rate_periods
    GROUP BY f.report_id
),
orphaned_spend AS (
    SELECT report_id, SUM(total_cost_usd) AS lifetime_cost_while_orphaned_usd
    FROM MART.FCT_REPORT_PERIOD
    WHERE is_orphaned
    GROUP BY report_id
)
SELECT
    ROW_NUMBER() OVER (ORDER BY rr.run_rate_total_cost_usd DESC, d.report_id) AS priority_rank,
    d.report_id,
    d.report_name,
    d.orphan_encoding,
    d.latest_period_seq - COALESCE(d.last_known_owner_period, -1)   AS periods_since_owned,
    d.last_known_owner                                              AS suggested_owner,
    CASE WHEN d.last_known_owner IS NOT NULL THEN 'LAST_KNOWN_OWNER' END AS suggestion_basis,
    d.most_frequent_owner,
    d.most_frequent_owner_periods,
    d.refresh_status,
    d.latency_severity,
    d.monthly_active_views,
    d.total_cost_usd                                                AS latest_total_cost_usd,
    rr.run_rate_total_cost_usd                                      AS cost_at_risk_usd,
    rr.run_rate_credits_fully_loaded,
    rr.run_rate_views,
    os.lifetime_cost_while_orphaned_usd
FROM MART.DIM_REPORT d
JOIN run_rate rr            ON rr.report_id = d.report_id
LEFT JOIN orphaned_spend os ON os.report_id = d.report_id
WHERE d.is_orphaned;
