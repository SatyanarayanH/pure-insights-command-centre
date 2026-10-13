-- =============================================================================
-- 01_staging_clean.sql — type, conform and quality-check the report telemetry
--
-- Principles
--   * Nothing is deleted. All 2,000 landed rows reach STG; defects become flags.
--   * Bad values are never "repaired" silently: a negative credit figure is not
--     ABS()-ed or zeroed, it is nulled in the clean column and written to quarantine
--     with a reason, so finance can see exactly what was excluded and why.
--   * Every rule has an id, and every finding points at a rule and a source row.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STG.REPORT_TELEMETRY — one row per report per period
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE STG.REPORT_TELEMETRY AS
WITH typed AS (
    SELECT
        row_seq,
        TRIM(report_id)                                     AS report_id,
        TRIM(report_name)                                   AS report_name,
        TRIM(owner_email)                                   AS owner_email_raw,
        UPPER(TRIM(last_refresh_status))                    AS refresh_status_raw,
        TRY_CAST(monthly_active_views AS INTEGER)           AS monthly_active_views,
        TRY_CAST(snowflake_credits_consumed AS DOUBLE)      AS credits_raw,
        TRY_CAST(avg_load_time_sec AS DOUBLE)               AS avg_load_time_sec,
        TRY_CAST(aws_hosting_cost_usd AS DOUBLE)            AS aws_hosting_cost_usd,
        TRY_CAST(query_count_last_30d AS INTEGER)           AS query_count_last_30d,
        TRY_CAST(concurrent_user_peak AS INTEGER)           AS concurrent_user_peak
    FROM RAW.REPORT_TELEMETRY
),
sequenced AS (
    -- The file repeats each report_id 20 times and carries no date. The nth occurrence of a
    -- report, in file order, is its nth reporting period. Derived per report rather than as
    -- FLOOR(row_seq / 100) so it does not depend on the block size.
    SELECT
        t.*,
        CAST(ROW_NUMBER() OVER (PARTITION BY t.report_id ORDER BY t.row_seq) - 1 AS INTEGER) AS period_seq
    FROM typed t
),
conformed AS (
    SELECT
        s.*,
        -- 'nan' is a pandas NaN that was stringified on export; 'ORPHANED_REPORT' is the
        -- portal's own sentinel. Two encodings, one meaning: nobody owns this report.
        CASE
            WHEN s.owner_email_raw IS NULL OR s.owner_email_raw = ''              THEN 'EMPTY'
            WHEN LOWER(s.owner_email_raw) IN ('nan', 'null', 'none', 'n/a')       THEN 'NAN_LITERAL'
            WHEN UPPER(s.owner_email_raw) = 'ORPHANED_REPORT'                     THEN 'SENTINEL'
        END AS orphan_encoding,
        CASE
            WHEN s.refresh_status_raw IN ('SUCCESS', 'FAILED', 'TIMED_OUT') THEN s.refresh_status_raw
            ELSE 'UNKNOWN'
        END AS refresh_status
    FROM sequenced s
)
SELECT
    c.row_seq,
    c.report_id,
    c.report_name,
    c.period_seq,
    pc.period_start,
    pc.period_end,

    -- ownership
    c.owner_email_raw,
    CASE WHEN c.orphan_encoding IS NULL THEN LOWER(c.owner_email_raw) END  AS owner_email,
    (c.orphan_encoding IS NOT NULL)                                        AS is_orphaned,
    c.orphan_encoding,

    -- refresh
    c.refresh_status,
    (c.refresh_status IN ('FAILED', 'TIMED_OUT'))                          AS is_refresh_failure,
    (c.refresh_status = 'UNKNOWN')                                         AS is_refresh_unknown,

    -- latency
    c.avg_load_time_sec,
    -- Flags are never NULL: a missing measurement is "not known to breach", and DQ-13 reports it.
    COALESCE(c.avg_load_time_sec > p.latency_warning_sec, FALSE)           AS is_latency_breach,
    CASE
        WHEN c.avg_load_time_sec > p.latency_critical_sec THEN 'CRITICAL'
        WHEN c.avg_load_time_sec > p.latency_high_sec     THEN 'HIGH'
        WHEN c.avg_load_time_sec > p.latency_warning_sec  THEN 'WARNING'
        ELSE 'OK'
    END                                                                    AS latency_severity,

    -- usage
    c.monthly_active_views,
    c.query_count_last_30d,
    c.concurrent_user_peak,
    COALESCE(c.monthly_active_views = 0, FALSE)                            AS is_zero_views,
    COALESCE(c.concurrent_user_peak > c.monthly_active_views, FALSE)       AS is_concurrency_gt_views,

    -- cost
    c.credits_raw,
    CASE WHEN c.credits_raw >= 0 THEN c.credits_raw END                    AS credits_clean,
    (c.credits_raw IS NULL OR c.credits_raw < 0)                           AS is_cost_quarantined,
    c.aws_hosting_cost_usd
FROM conformed c
JOIN RAW.PERIOD_CALENDAR pc ON pc.period_seq = c.period_seq
CROSS JOIN CONFIG.COST_PARAMS p;

-- -----------------------------------------------------------------------------
-- DQ.RULES — the rule registry. in_brief = listed in the case-study brief.
-- action: NORMALIZE (rewritten to a canonical form), QUARANTINE (excluded from
-- cost maths, kept for audit), FLAG (kept, surfaced), RESTRUCTURE (reshaped).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE DQ.RULES (
    rule_id      VARCHAR,
    rule_name    VARCHAR,
    category     VARCHAR,
    severity     VARCHAR,
    action       VARCHAR,
    in_brief     BOOLEAN,
    description  VARCHAR
);

INSERT INTO DQ.RULES VALUES
    ('DQ-01', 'ORPHANED_OWNER',            'Ownership',    'HIGH',   'NORMALIZE',   TRUE,
     'owner_email is a stringified NaN or the ORPHANED_REPORT sentinel. Both become a NULL owner with is_orphaned = TRUE.'),
    ('DQ-02', 'NEGATIVE_CREDITS',          'Cost',         'HIGH',   'QUARANTINE',  TRUE,
     'snowflake_credits_consumed is negative. Compute consumption cannot be negative, so the value is excluded from attribution and kept in quarantine.'),
    ('DQ-03', 'LATENCY_OVER_THRESHOLD',    'Performance',  'MEDIUM', 'FLAG',        TRUE,
     'avg_load_time_sec exceeds the alert threshold (15 s). Raises an operational alert with a severity tier.'),
    ('DQ-04', 'COST_PER_VIEW_OUTLIER',     'Cost',         'MEDIUM', 'FLAG',        TRUE,
     'AWS hosting cost per active view is a robust outlier (modified z-score on log scale): hosting spend is out of line with usage.'),
    ('DQ-05', 'REFRESH_STATUS_UNKNOWN',    'Refresh',      'MEDIUM', 'FLAG',        FALSE,
     'last_refresh_status is UNKNOWN, a value the brief does not mention. Treated as a telemetry gap: neither success nor failure.'),
    ('DQ-06', 'REPEATED_REPORT_ID',        'Structure',    'INFO',   'RESTRUCTURE', FALSE,
     'report_id is not unique: each report appears once per reporting period. Rows are keyed (report_id, period_seq), not de-duplicated.'),
    ('DQ-07', 'OWNER_REASSIGNED',          'Ownership',    'LOW',    'FLAG',        FALSE,
     'The named owner differs from the previous period''s named owner. Frequent changes mean ownership cannot be trusted from one snapshot.'),
    ('DQ-08', 'ZERO_VIEWS_WITH_COST',      'Cost',         'MEDIUM', 'FLAG',        FALSE,
     'monthly_active_views is 0 while cost is incurred. Unit cost per view is undefined (NULL), never a division error or infinity.'),
    ('DQ-09', 'CONCURRENCY_EXCEEDS_VIEWS', 'Usage',        'LOW',    'FLAG',        FALSE,
     'concurrent_user_peak is greater than monthly_active_views, which is not physically possible. Usage counters disagree.'),
    ('DQ-10', 'TYPE_CAST_FAILURE',         'Schema',       'HIGH',   'QUARANTINE',  FALSE,
     'A numeric column holds a value that does not cast to its type.'),
    ('DQ-11', 'REFRESH_FAILED',            'Refresh',      'HIGH',   'FLAG',        TRUE,
     'last_refresh_status is FAILED or TIMED_OUT. Raises an operational alert.'),
    ('DQ-12', 'INVALID_OWNER_EMAIL',       'Schema',       'LOW',    'FLAG',        FALSE,
     'owner_email is present but is not shaped like an email address.'),
    ('DQ-13', 'MISSING_VALUE',             'Schema',       'MEDIUM', 'FLAG',        FALSE,
     'A measurement or the refresh status is blank. The row is kept; anything derived from the blank is NULL, and blank credits are quarantined from cost.');

-- -----------------------------------------------------------------------------
-- DQ.FINDINGS — one row per (rule, source row) violation
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE DQ.FINDINGS AS
WITH cost_per_view AS (
    SELECT row_seq, LN(aws_hosting_cost_usd / monthly_active_views) AS log_cpv
    FROM STG.REPORT_TELEMETRY
    WHERE monthly_active_views > 0 AND aws_hosting_cost_usd > 0
),
cpv_median AS (
    SELECT MEDIAN(log_cpv) AS med FROM cost_per_view
),
cpv_mad AS (
    SELECT MEDIAN(ABS(c.log_cpv - m.med)) AS mad
    FROM cost_per_view c CROSS JOIN cpv_median m
),
cpv_scored AS (
    -- 0.6745 scales the median absolute deviation to a standard deviation for normal data.
    SELECT c.row_seq, 0.6745 * (c.log_cpv - m.med) / NULLIF(d.mad, 0) AS robust_z
    FROM cost_per_view c CROSS JOIN cpv_median m CROSS JOIN cpv_mad d
),
owner_changes AS (
    SELECT
        row_seq,
        owner_email,
        LAG(owner_email) OVER (PARTITION BY report_id ORDER BY period_seq) AS previous_owner
    FROM STG.REPORT_TELEMETRY
),
cast_failures AS (
    SELECT row_seq, 'monthly_active_views' AS column_name, monthly_active_views AS raw_value
    FROM RAW.REPORT_TELEMETRY
    WHERE TRIM(monthly_active_views) <> '' AND TRY_CAST(monthly_active_views AS INTEGER) IS NULL
    UNION ALL
    SELECT row_seq, 'snowflake_credits_consumed', snowflake_credits_consumed
    FROM RAW.REPORT_TELEMETRY
    WHERE TRIM(snowflake_credits_consumed) <> '' AND TRY_CAST(snowflake_credits_consumed AS DOUBLE) IS NULL
    UNION ALL
    SELECT row_seq, 'avg_load_time_sec', avg_load_time_sec
    FROM RAW.REPORT_TELEMETRY
    WHERE TRIM(avg_load_time_sec) <> '' AND TRY_CAST(avg_load_time_sec AS DOUBLE) IS NULL
    UNION ALL
    SELECT row_seq, 'aws_hosting_cost_usd', aws_hosting_cost_usd
    FROM RAW.REPORT_TELEMETRY
    WHERE TRIM(aws_hosting_cost_usd) <> '' AND TRY_CAST(aws_hosting_cost_usd AS DOUBLE) IS NULL
    UNION ALL
    SELECT row_seq, 'query_count_last_30d', query_count_last_30d
    FROM RAW.REPORT_TELEMETRY
    WHERE TRIM(query_count_last_30d) <> '' AND TRY_CAST(query_count_last_30d AS INTEGER) IS NULL
    UNION ALL
    SELECT row_seq, 'concurrent_user_peak', concurrent_user_peak
    FROM RAW.REPORT_TELEMETRY
    WHERE TRIM(concurrent_user_peak) <> '' AND TRY_CAST(concurrent_user_peak AS INTEGER) IS NULL
),
blanks AS (
    SELECT row_seq, 'monthly_active_views' AS column_name FROM RAW.REPORT_TELEMETRY
    WHERE COALESCE(TRIM(monthly_active_views), '') = ''
    UNION ALL
    SELECT row_seq, 'snowflake_credits_consumed' FROM RAW.REPORT_TELEMETRY
    WHERE COALESCE(TRIM(snowflake_credits_consumed), '') = ''
    UNION ALL
    SELECT row_seq, 'avg_load_time_sec' FROM RAW.REPORT_TELEMETRY
    WHERE COALESCE(TRIM(avg_load_time_sec), '') = ''
    UNION ALL
    SELECT row_seq, 'aws_hosting_cost_usd' FROM RAW.REPORT_TELEMETRY
    WHERE COALESCE(TRIM(aws_hosting_cost_usd), '') = ''
    UNION ALL
    SELECT row_seq, 'query_count_last_30d' FROM RAW.REPORT_TELEMETRY
    WHERE COALESCE(TRIM(query_count_last_30d), '') = ''
    UNION ALL
    SELECT row_seq, 'concurrent_user_peak' FROM RAW.REPORT_TELEMETRY
    WHERE COALESCE(TRIM(concurrent_user_peak), '') = ''
    UNION ALL
    SELECT row_seq, 'last_refresh_status' FROM RAW.REPORT_TELEMETRY
    WHERE COALESCE(TRIM(last_refresh_status), '') = ''
)
SELECT 'DQ-01' AS rule_id, s.row_seq, s.report_id, s.period_seq,
       s.owner_email_raw AS observed_value,
       'owner encoded as ' || s.orphan_encoding AS detail
FROM STG.REPORT_TELEMETRY s
WHERE s.is_orphaned

UNION ALL
SELECT 'DQ-02', s.row_seq, s.report_id, s.period_seq,
       -- The value exactly as it appears in the file. Casting the number back to text would
       -- print 40.0 on one engine and 40 on another.
       TRIM(r.snowflake_credits_consumed),
       'negative credits excluded from attribution'
FROM STG.REPORT_TELEMETRY s
JOIN RAW.REPORT_TELEMETRY r ON r.row_seq = s.row_seq
WHERE s.credits_raw < 0

UNION ALL
SELECT 'DQ-03', s.row_seq, s.report_id, s.period_seq,
       TRIM(r.avg_load_time_sec),
       'latency severity ' || s.latency_severity
FROM STG.REPORT_TELEMETRY s
JOIN RAW.REPORT_TELEMETRY r ON r.row_seq = s.row_seq
WHERE s.is_latency_breach

UNION ALL
SELECT 'DQ-04', s.row_seq, s.report_id, s.period_seq,
       -- Through a fixed-scale decimal, so both engines print the same two places.
       CAST(CAST(ROUND(s.aws_hosting_cost_usd / s.monthly_active_views, 2) AS DECIMAL(18, 2)) AS VARCHAR),
       'USD per view, robust z = ' || CAST(CAST(ROUND(z.robust_z, 2) AS DECIMAL(18, 2)) AS VARCHAR)
FROM STG.REPORT_TELEMETRY s
JOIN cpv_scored z ON z.row_seq = s.row_seq
CROSS JOIN CONFIG.COST_PARAMS p
WHERE ABS(z.robust_z) > p.outlier_robust_z

UNION ALL
SELECT 'DQ-05', s.row_seq, s.report_id, s.period_seq,
       s.refresh_status,
       'refresh outcome not reported'
FROM STG.REPORT_TELEMETRY s
WHERE s.is_refresh_unknown

UNION ALL
SELECT 'DQ-06', s.row_seq, s.report_id, s.period_seq,
       s.report_id,
       'occurrence ' || CAST(s.period_seq + 1 AS VARCHAR) || ' of this report_id'
FROM STG.REPORT_TELEMETRY s
WHERE s.period_seq > 0

UNION ALL
SELECT 'DQ-07', s.row_seq, s.report_id, s.period_seq,
       s.owner_email,
       'previous owner ' || o.previous_owner
FROM STG.REPORT_TELEMETRY s
JOIN owner_changes o ON o.row_seq = s.row_seq
WHERE o.owner_email IS NOT NULL
  AND o.previous_owner IS NOT NULL
  AND o.owner_email <> o.previous_owner

UNION ALL
SELECT 'DQ-08', s.row_seq, s.report_id, s.period_seq,
       CAST(s.monthly_active_views AS VARCHAR),
       'USD ' || TRIM(r.aws_hosting_cost_usd) || ' hosting cost with no views'
FROM STG.REPORT_TELEMETRY s
JOIN RAW.REPORT_TELEMETRY r ON r.row_seq = s.row_seq
WHERE s.is_zero_views

UNION ALL
SELECT 'DQ-09', s.row_seq, s.report_id, s.period_seq,
       CAST(s.concurrent_user_peak AS VARCHAR),
       'peak concurrency above ' || CAST(s.monthly_active_views AS VARCHAR) || ' monthly views'
FROM STG.REPORT_TELEMETRY s
WHERE s.is_concurrency_gt_views

UNION ALL
SELECT 'DQ-10', s.row_seq, s.report_id, s.period_seq,
       f.raw_value,
       'column ' || f.column_name || ' failed to cast'
FROM STG.REPORT_TELEMETRY s
JOIN cast_failures f ON f.row_seq = s.row_seq

UNION ALL
SELECT 'DQ-11', s.row_seq, s.report_id, s.period_seq,
       s.refresh_status,
       'automated refresh did not complete'
FROM STG.REPORT_TELEMETRY s
WHERE s.is_refresh_failure

UNION ALL
SELECT 'DQ-12', s.row_seq, s.report_id, s.period_seq,
       s.owner_email_raw,
       'owner present but not an email address'
FROM STG.REPORT_TELEMETRY s
WHERE NOT s.is_orphaned
  AND s.owner_email NOT LIKE '%_@_%._%'

UNION ALL
SELECT 'DQ-13', s.row_seq, s.report_id, s.period_seq,
       CAST(NULL AS VARCHAR),
       'blank: ' || b.column_name
FROM STG.REPORT_TELEMETRY s
JOIN blanks b ON b.row_seq = s.row_seq;

-- -----------------------------------------------------------------------------
-- DQ.QUARANTINE — report-periods excluded from cost attribution, with the reason.
-- The row itself stays in STG; only its credit figure is withheld.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE DQ.QUARANTINE AS
SELECT
    s.row_seq,
    s.report_id,
    s.period_seq,
    CASE
        WHEN s.credits_raw IS NOT NULL                                 THEN 'DQ-02'
        WHEN COALESCE(TRIM(r.snowflake_credits_consumed), '') = ''     THEN 'DQ-13'
        ELSE 'DQ-10'
    END AS rule_id,
    CASE
        WHEN s.credits_raw IS NOT NULL                                 THEN 'NEGATIVE_CREDITS'
        WHEN COALESCE(TRIM(r.snowflake_credits_consumed), '') = ''     THEN 'CREDITS_MISSING'
        ELSE 'CREDITS_NOT_NUMERIC'
    END AS reason_code,
    r.snowflake_credits_consumed                                    AS raw_value,
    s.credits_raw
FROM STG.REPORT_TELEMETRY s
JOIN RAW.REPORT_TELEMETRY r ON r.row_seq = s.row_seq
WHERE s.is_cost_quarantined;

-- -----------------------------------------------------------------------------
-- DQ.RULE_SUMMARY — what the data-quality report and the UI read
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE DQ.RULE_SUMMARY AS
WITH counts AS (
    SELECT
        rule_id,
        COUNT(*)                    AS rows_affected,
        COUNT(DISTINCT report_id)   AS reports_affected
    FROM DQ.FINDINGS
    GROUP BY rule_id
),
total AS (
    SELECT COUNT(*) AS total_rows FROM STG.REPORT_TELEMETRY
)
SELECT
    r.rule_id,
    r.rule_name,
    r.category,
    r.severity,
    r.action,
    r.in_brief,
    r.description,
    COALESCE(c.rows_affected, 0)                                     AS rows_affected,
    COALESCE(c.reports_affected, 0)                                  AS reports_affected,
    ROUND(100.0 * COALESCE(c.rows_affected, 0) / t.total_rows, 2)    AS pct_of_rows
FROM DQ.RULES r
LEFT JOIN counts c ON c.rule_id = r.rule_id
CROSS JOIN total t;
