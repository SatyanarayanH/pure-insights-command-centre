-- =============================================================================
-- 03_attribution_time_weighted.sql — Methods B and C: getting from "query credits"
-- to "what the warehouse actually billed"
--
-- Method A ignores idle time, so its total is always below the metered bill. Two
-- standard ways to close that gap:
--
--   Method B  idle-loaded     Scale each query's attributed credits by
--                             metered / attributed for its warehouse and period.
--                             Keeps Snowflake's own per-query split; spreads overhead
--                             in proportion to use.
--
--   Method C  time-weighted   Ignore QUERY_ATTRIBUTION_HISTORY. Split every metered
--                             warehouse-hour across the queries running in it, in
--                             proportion to the milliseconds each one overlapped it.
--                             Works on accounts without attribution history, and gives
--                             an independent estimate for rows whose attributed
--                             credits were quarantined.
--
-- All three are kept side by side in MART.ATTRIBUTION_COMPARISON.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STG.WAREHOUSE_PERIOD — metered vs attributed credits per warehouse per period
-- overhead_factor > 1: the metered bill carries idle time on top of query credits.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE STG.WAREHOUSE_PERIOD AS
WITH metered AS (
    SELECT
        pc.period_seq,
        m.warehouse_id,
        m.warehouse_name,
        SUM(m.credits_used_compute)                 AS credits_metered_compute,
        SUM(m.credits_used_cloud_services)          AS credits_cloud_services,
        SUM(m.credits_attributed_compute_queries)   AS credits_metered_query_share,
        COUNT(*)                                    AS active_hours
    FROM ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY m
    JOIN RAW.PERIOD_CALENDAR pc
      ON m.start_time >= pc.period_start AND m.start_time < pc.period_end
    GROUP BY pc.period_seq, m.warehouse_id, m.warehouse_name
),
attributed AS (
    SELECT
        period_seq,
        warehouse_id,
        SUM(CASE WHEN is_credit_valid THEN credits_attributed_compute END) AS credits_attributed_valid
    FROM STG.QUERY_ATTRIBUTION
    GROUP BY period_seq, warehouse_id
)
SELECT
    m.period_seq,
    m.warehouse_id,
    m.warehouse_name,
    m.active_hours,
    m.credits_metered_compute,
    m.credits_cloud_services,
    m.credits_metered_query_share,
    a.credits_attributed_valid,
    m.credits_metered_compute - m.credits_metered_query_share       AS credits_idle,
    m.credits_metered_compute / NULLIF(a.credits_attributed_valid, 0) AS overhead_factor
FROM metered m
LEFT JOIN attributed a
  ON a.period_seq = m.period_seq AND a.warehouse_id = m.warehouse_id;

-- -----------------------------------------------------------------------------
-- Method B — idle-loaded credits per report per period
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.CREDITS_IDLE_LOADED AS
SELECT
    qa.report_id,
    qa.period_seq,
    SUM(qa.credits_attributed_compute * wp.overhead_factor) AS credits_idle_loaded
FROM STG.QUERY_ATTRIBUTION qa
JOIN STG.WAREHOUSE_PERIOD wp
  ON wp.period_seq = qa.period_seq AND wp.warehouse_id = qa.warehouse_id
WHERE qa.attribution_class = 'REPORT'
  AND qa.is_credit_valid
GROUP BY qa.report_id, qa.period_seq;

-- -----------------------------------------------------------------------------
-- Method C — time-weighted allocation of each metered warehouse-hour
--
-- A query that runs 14:50 -> 15:20 overlaps two metered hours: 10 minutes of the
-- 14:00 hour and 20 minutes of the 15:00 hour. Its share of each hour's credits is
-- its overlap divided by the total overlap of all queries in that warehouse-hour.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE STG.QUERY_HOUR_ALLOCATION AS
WITH metered_hours AS (
    SELECT
        warehouse_id,
        start_time,
        end_time,
        credits_used_compute,
        DATE_TRUNC('day', start_time) AS usage_day
    FROM ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
),
usage_days AS (
    SELECT DISTINCT usage_day FROM metered_hours
),
-- Performance: "which hours does this query overlap" is a range join, and with only a
-- handful of warehouses the warehouse_id equality barely narrows it. Expanding each query
-- to the calendar days it touches first turns the expensive part into an equi-join on
-- (warehouse_id, usage_day); the range predicate then only compares within one day.
query_days AS (
    SELECT query_id, warehouse_id, start_time, end_time,
           DATE_TRUNC('day', start_time) AS usage_day
    FROM STG.QUERY_CLASSIFIED
    UNION ALL
    -- Queries that run past midnight also touch every later day up to their end.
    SELECT q.query_id, q.warehouse_id, q.start_time, q.end_time, d.usage_day
    FROM STG.QUERY_CLASSIFIED q
    JOIN usage_days d
      ON d.usage_day >  DATE_TRUNC('day', q.start_time)
     AND d.usage_day <= DATE_TRUNC('day', q.end_time)
    WHERE DATE_TRUNC('day', q.end_time) > DATE_TRUNC('day', q.start_time)
),
overlap AS (
    SELECT
        q.query_id,
        m.warehouse_id,
        m.start_time            AS hour_start,
        m.credits_used_compute,
        DATEDIFF('millisecond',
                 GREATEST(q.start_time, m.start_time),
                 LEAST(q.end_time, m.end_time)) AS overlap_ms
    FROM query_days q
    JOIN metered_hours m
      ON m.warehouse_id = q.warehouse_id
     AND m.usage_day = q.usage_day
     AND m.start_time < q.end_time
     AND m.end_time > q.start_time
)
SELECT
    query_id,
    warehouse_id,
    hour_start,
    overlap_ms,
    credits_used_compute * overlap_ms
        / SUM(overlap_ms) OVER (PARTITION BY warehouse_id, hour_start) AS credits_time_weighted
FROM overlap
WHERE overlap_ms > 0;

CREATE OR REPLACE TABLE STG.QUERY_TIME_WEIGHTED AS
SELECT
    qc.query_id,
    qc.warehouse_id,
    qc.period_seq,
    qc.attribution_class,
    qc.report_id,
    SUM(a.credits_time_weighted) AS credits_time_weighted
FROM STG.QUERY_HOUR_ALLOCATION a
JOIN STG.QUERY_CLASSIFIED qc ON qc.query_id = a.query_id
GROUP BY qc.query_id, qc.warehouse_id, qc.period_seq, qc.attribution_class, qc.report_id;

CREATE OR REPLACE TABLE MART.CREDITS_TIME_WEIGHTED AS
SELECT
    report_id,
    period_seq,
    SUM(credits_time_weighted) AS credits_time_weighted
FROM STG.QUERY_TIME_WEIGHTED
WHERE attribution_class = 'REPORT'
GROUP BY report_id, period_seq;

-- -----------------------------------------------------------------------------
-- MART.ATTRIBUTION_COMPARISON — the three methods per report per period
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE MART.ATTRIBUTION_COMPARISON AS
SELECT
    s.report_id,
    s.period_seq,
    s.credits_raw                                                   AS credits_reported,
    d.credits_direct,
    l.credits_idle_loaded,
    t.credits_time_weighted,
    l.credits_idle_loaded - d.credits_direct                        AS credits_overhead_share,
    (t.credits_time_weighted - l.credits_idle_loaded)
        / NULLIF(l.credits_idle_loaded, 0)                          AS time_weighted_vs_idle_loaded_pct
FROM STG.REPORT_TELEMETRY s
LEFT JOIN MART.CREDITS_DIRECT d
  ON d.report_id = s.report_id AND d.period_seq = s.period_seq
LEFT JOIN MART.CREDITS_IDLE_LOADED l
  ON l.report_id = s.report_id AND l.period_seq = s.period_seq
LEFT JOIN MART.CREDITS_TIME_WEIGHTED t
  ON t.report_id = s.report_id AND t.period_seq = s.period_seq;
