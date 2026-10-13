-- =============================================================================
-- 06_cost_anomalies.sql — where cost and usage disagree
--
-- The brief lists "discrepancies between active user counts and AWS hosting
-- compute costs" as a defect. It is quantified three ways:
--   1. dataset level  correlation between usage and cost measures
--   2. report level   efficiency quadrant on current run-rate (zombie candidates)
--   3. row level      a single list of actionable anomalies with a dollar impact
-- =============================================================================

-- -----------------------------------------------------------------------------
-- MART.USAGE_COST_CORRELATION — do the cost measures move with usage at all?
-- Hosting cost that tracked usage would correlate strongly. Near zero means cost
-- is being incurred independently of who is looking at the report.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.USAGE_COST_CORRELATION AS
SELECT 'monthly_active_views' AS usage_measure, 'aws_hosting_cost_usd' AS cost_measure,
       CORR(monthly_active_views, aws_hosting_cost_usd) AS pearson_r, COUNT(*) AS observations
FROM MART.FCT_REPORT_PERIOD
UNION ALL
SELECT 'concurrent_user_peak', 'aws_hosting_cost_usd',
       CORR(concurrent_user_peak, aws_hosting_cost_usd), COUNT(*)
FROM MART.FCT_REPORT_PERIOD
UNION ALL
SELECT 'monthly_active_views', 'credits_attributed',
       CORR(monthly_active_views, credits_attributed), COUNT(credits_attributed)
FROM MART.FCT_REPORT_PERIOD
UNION ALL
SELECT 'query_count_last_30d', 'credits_attributed',
       CORR(query_count_last_30d, credits_attributed), COUNT(credits_attributed)
FROM MART.FCT_REPORT_PERIOD
UNION ALL
SELECT 'monthly_active_views', 'query_count_last_30d',
       CORR(monthly_active_views, query_count_last_30d), COUNT(*)
FROM MART.FCT_REPORT_PERIOD;

-- -----------------------------------------------------------------------------
-- MART.REPORT_EFFICIENCY — usage vs cost quadrant on current run-rate
--
--   ZOMBIE      bottom quartile of views AND top quartile of cost: retire or fix
--   COSTLY      below-median views, above-median cost
--   WORKHORSE   above-median views, above-median cost
--   EFFICIENT   above-median views, below-median cost
--   NICHE       below-median views, below-median cost
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.REPORT_EFFICIENCY AS
WITH run_rate AS (
    SELECT
        f.report_id,
        AVG(f.monthly_active_views)                                     AS run_rate_views,
        AVG(f.total_cost_usd)                                           AS run_rate_total_cost_usd,
        AVG(f.snowflake_cost_loaded_usd)                                AS run_rate_snowflake_cost_usd,
        AVG(f.aws_hosting_cost_usd)                                     AS run_rate_aws_cost_usd,
        SUM(f.total_cost_usd) / NULLIF(SUM(f.monthly_active_views), 0)  AS run_rate_cost_per_view_usd
    FROM MART.FCT_REPORT_PERIOD f
    JOIN MART.DIM_REPORT d ON d.report_id = f.report_id
    CROSS JOIN CONFIG.COST_PARAMS p
    WHERE f.period_seq > d.latest_period_seq - p.run_rate_periods
    GROUP BY f.report_id
),
ranked AS (
    SELECT
        r.*,
        PERCENT_RANK() OVER (ORDER BY r.run_rate_views)           AS views_pctile,
        PERCENT_RANK() OVER (ORDER BY r.run_rate_total_cost_usd)  AS cost_pctile
    FROM run_rate r
)
SELECT
    k.report_id,
    k.run_rate_views,
    k.run_rate_total_cost_usd,
    k.run_rate_snowflake_cost_usd,
    k.run_rate_aws_cost_usd,
    k.run_rate_cost_per_view_usd,
    k.views_pctile,
    k.cost_pctile,
    CASE
        WHEN k.views_pctile <= p.zombie_max_views_pctile
         AND k.cost_pctile  >= p.zombie_min_cost_pctile     THEN 'ZOMBIE'
        WHEN k.views_pctile <  0.5 AND k.cost_pctile >= 0.5 THEN 'COSTLY'
        WHEN k.views_pctile >= 0.5 AND k.cost_pctile >= 0.5 THEN 'WORKHORSE'
        WHEN k.views_pctile >= 0.5                          THEN 'EFFICIENT'
        ELSE 'NICHE'
    END AS efficiency_quadrant
FROM ranked k
CROSS JOIN CONFIG.COST_PARAMS p;

-- -----------------------------------------------------------------------------
-- MART.COST_ANOMALIES — one actionable list, each line with a monthly dollar figure
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.COST_ANOMALIES AS
WITH latest AS (
    SELECT MAX(period_seq) AS latest_period_seq FROM MART.FCT_REPORT_PERIOD
)
-- Zombie reports: spend that buys almost no usage.
SELECT
    'ZOMBIE_REPORT'                         AS anomaly_type,
    e.report_id,
    CAST(NULL AS INTEGER)                   AS period_seq,
    e.run_rate_cost_per_view_usd            AS metric_value,
    'USD per view (run-rate)'               AS metric_unit,
    e.run_rate_total_cost_usd               AS est_monthly_impact_usd,
    'Bottom-quartile usage with top-quartile cost. Candidate to retire, consolidate or cache.' AS detail
FROM MART.REPORT_EFFICIENCY e
WHERE e.efficiency_quadrant = 'ZOMBIE'

UNION ALL
-- Orphaned reports: spend with nobody accountable for it.
SELECT
    'ORPHANED_SPEND',
    q.report_id,
    CAST(NULL AS INTEGER),
    CAST(q.periods_since_owned AS DOUBLE),
    'periods without an owner',
    q.cost_at_risk_usd,
    'No accountable owner. Suggested owner: ' || COALESCE(q.suggested_owner, 'none on record') || '.'
FROM MART.ORPHAN_QUEUE q

UNION ALL
-- Hosting cost per view far outside the norm (rule DQ-04), latest period only.
SELECT
    'COST_PER_VIEW_OUTLIER',
    f.report_id,
    f.period_seq,
    f.aws_cost_per_view_usd,
    'AWS USD per view',
    f.aws_hosting_cost_usd,
    'Hosting cost out of line with usage: ' || g.detail || '.'
FROM DQ.FINDINGS g
JOIN MART.FCT_REPORT_PERIOD f ON f.row_seq = g.row_seq
CROSS JOIN latest l
WHERE g.rule_id = 'DQ-04' AND f.period_seq = l.latest_period_seq

UNION ALL
-- Cost with no views at all (rule DQ-08), any period.
SELECT
    'ZERO_VIEW_SPEND',
    f.report_id,
    f.period_seq,
    f.total_cost_usd,
    'USD spent with 0 views',
    f.total_cost_usd,
    'Report was refreshed and hosted for a full period that nobody viewed.'
FROM MART.FCT_REPORT_PERIOD f
WHERE f.is_zero_views

UNION ALL
-- Quarantined credit figures: the cost is real, the reported number is not.
SELECT
    'QUARANTINED_CREDITS',
    f.report_id,
    f.period_seq,
    f.credits_reported,
    'credits as reported',
    f.snowflake_cost_loaded_usd,
    'Reported credits are negative. Cost imputed from execution time (Method C): '
        || CAST(CAST(ROUND(f.credits_fully_loaded, 2) AS DECIMAL(18, 2)) AS VARCHAR) || ' credits.'
FROM MART.FCT_REPORT_PERIOD f
WHERE f.is_cost_quarantined;
