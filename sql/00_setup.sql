-- =============================================================================
-- 00_setup.sql — schemas, parameters and landing tables
-- Pure Insights Command Centre · Snowflake cost allocation suite
--
-- Dialect: Snowflake. The suite deliberately stays inside the subset that DuckDB also
-- executes (see sql/README.md), so the identical files run locally and in CI.
--
-- Layout
--   RAW            landed files, untouched, every column VARCHAR
--   ACCOUNT_USAGE  simulated copies of SNOWFLAKE.ACCOUNT_USAGE views
--   CONFIG         tunable parameters (no constants are buried in queries)
--   STG            typed, cleaned, conformed
--   DQ             data-quality rules, findings, quarantine, reconciliation
--   MART           what the application and analysts read
--
-- To run against a real account, point the ACCOUNT_USAGE references at
-- SNOWFLAKE.ACCOUNT_USAGE; the column names match the real views.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS RAW;
CREATE SCHEMA IF NOT EXISTS ACCOUNT_USAGE;
CREATE SCHEMA IF NOT EXISTS CONFIG;
CREATE SCHEMA IF NOT EXISTS STG;
CREATE SCHEMA IF NOT EXISTS DQ;
CREATE SCHEMA IF NOT EXISTS MART;

-- -----------------------------------------------------------------------------
-- Parameters. One row; every script CROSS JOINs it instead of hard-coding values.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE CONFIG.COST_PARAMS (
    credit_price_usd            DOUBLE,   -- contract price of one Snowflake credit
    latency_warning_sec         DOUBLE,   -- the brief's alert threshold
    latency_high_sec            DOUBLE,
    latency_critical_sec        DOUBLE,
    outlier_robust_z            DOUBLE,   -- Iglewicz-Hoaglin modified z-score cut-off
    zombie_max_views_pctile     DOUBLE,   -- "low usage" = at or below this percentile of views
    zombie_min_cost_pctile      DOUBLE,   -- "high cost" = at or above this percentile of cost
    run_rate_periods            INTEGER,  -- trailing periods averaged for "current run-rate"
    reconciliation_tolerance    DOUBLE    -- absolute credits tolerance for exact checks
);

INSERT INTO CONFIG.COST_PARAMS VALUES (3.00, 15, 30, 45, 3.5, 0.25, 0.75, 3, 0.01);

-- -----------------------------------------------------------------------------
-- RAW: the portal's report telemetry export, landed as text.
-- row_seq preserves file order, which is the only carrier of time in this dataset.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE RAW.REPORT_TELEMETRY (
    row_seq                     INTEGER,
    report_id                   VARCHAR,
    report_name                 VARCHAR,
    owner_email                 VARCHAR,
    last_refresh_status         VARCHAR,
    monthly_active_views        VARCHAR,
    snowflake_credits_consumed  VARCHAR,
    avg_load_time_sec           VARCHAR,
    aws_hosting_cost_usd        VARCHAR,
    query_count_last_30d        VARCHAR,
    concurrent_user_peak        VARCHAR
);

-- One row per reporting period. The dataset has no dates, so the calendar is an
-- explicit, replaceable assumption rather than arithmetic hidden in queries.
CREATE OR REPLACE TABLE RAW.PERIOD_CALENDAR (
    period_seq                  INTEGER,
    period_start                TIMESTAMP,
    period_end                  TIMESTAMP   -- exclusive
);

CREATE OR REPLACE TABLE CONFIG.SIM_PARAMS (
    queries_per_row             INTEGER,    -- real queries represented by one simulated row
    period_days                 INTEGER,
    seed                        VARCHAR,
    simulator_version           INTEGER
);

-- -----------------------------------------------------------------------------
-- ACCOUNT_USAGE: same column names as the real views (subset actually used).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ACCOUNT_USAGE.QUERY_HISTORY (
    query_id                    VARCHAR,
    query_type                  VARCHAR,
    user_name                   VARCHAR,
    role_name                   VARCHAR,
    warehouse_id                INTEGER,
    warehouse_name              VARCHAR,
    warehouse_size              VARCHAR,
    query_tag                   VARCHAR,
    execution_status            VARCHAR,
    start_time                  TIMESTAMP,
    end_time                    TIMESTAMP,
    total_elapsed_time          BIGINT,     -- milliseconds
    execution_time              BIGINT,     -- milliseconds
    compilation_time            BIGINT,     -- milliseconds
    bytes_scanned               BIGINT
);

CREATE OR REPLACE TABLE ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY (
    query_id                        VARCHAR,
    warehouse_id                    INTEGER,
    warehouse_name                  VARCHAR,
    query_tag                       VARCHAR,
    user_name                       VARCHAR,
    start_time                      TIMESTAMP,
    end_time                        TIMESTAMP,
    credits_attributed_compute      DOUBLE,  -- excludes warehouse idle time
    credits_used_query_acceleration DOUBLE
);

CREATE OR REPLACE TABLE ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY (
    start_time                          TIMESTAMP,  -- hour start
    end_time                            TIMESTAMP,
    warehouse_id                        INTEGER,
    warehouse_name                      VARCHAR,
    credits_used                        DOUBLE,
    credits_used_compute                DOUBLE,     -- includes idle time
    credits_used_cloud_services         DOUBLE,
    credits_attributed_compute_queries  DOUBLE
);
