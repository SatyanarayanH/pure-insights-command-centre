-- =============================================================================
-- loaders/duckdb_load.sql — DuckDB only. Compatibility shims + file loads.
-- ${RAW_CSV} and ${DATA_DIR} are substituted by the runner.
-- =============================================================================

-- The only two Snowflake functions the suite uses that DuckDB lacks.
CREATE OR REPLACE MACRO TRY_PARSE_JSON(x) AS CASE WHEN json_valid(x) THEN CAST(x AS JSON) END;
CREATE OR REPLACE MACRO GET_PATH(v, p) AS json_extract_string(v, '$.' || p);

-- read_csv preserves file order, so row_number() reproduces the source line order.
INSERT INTO RAW.REPORT_TELEMETRY
SELECT
    CAST(ROW_NUMBER() OVER () AS INTEGER) AS row_seq,
    report_id, report_name, owner_email, last_refresh_status, monthly_active_views,
    snowflake_credits_consumed, avg_load_time_sec, aws_hosting_cost_usd,
    query_count_last_30d, concurrent_user_peak
FROM read_csv('${RAW_CSV}', header = true, all_varchar = true, parallel = false);

INSERT INTO RAW.PERIOD_CALENDAR
SELECT * FROM read_csv('${DATA_DIR}/period_calendar.csv', header = true,
    columns = {'period_seq': 'INTEGER', 'period_start': 'TIMESTAMP', 'period_end': 'TIMESTAMP'});

INSERT INTO CONFIG.SIM_PARAMS
SELECT * FROM read_csv('${DATA_DIR}/sim_params.csv', header = true,
    columns = {'queries_per_row': 'INTEGER', 'period_days': 'INTEGER', 'seed': 'VARCHAR', 'simulator_version': 'INTEGER'});

INSERT INTO ACCOUNT_USAGE.QUERY_HISTORY
SELECT * FROM read_csv('${DATA_DIR}/query_history.csv.gz', header = true, columns = {
    'query_id': 'VARCHAR', 'query_type': 'VARCHAR', 'user_name': 'VARCHAR', 'role_name': 'VARCHAR',
    'warehouse_id': 'INTEGER', 'warehouse_name': 'VARCHAR', 'warehouse_size': 'VARCHAR',
    'query_tag': 'VARCHAR', 'execution_status': 'VARCHAR', 'start_time': 'TIMESTAMP',
    'end_time': 'TIMESTAMP', 'total_elapsed_time': 'BIGINT', 'execution_time': 'BIGINT',
    'compilation_time': 'BIGINT', 'bytes_scanned': 'BIGINT'});

INSERT INTO ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY
SELECT * FROM read_csv('${DATA_DIR}/query_attribution_history.csv.gz', header = true, columns = {
    'query_id': 'VARCHAR', 'warehouse_id': 'INTEGER', 'warehouse_name': 'VARCHAR',
    'query_tag': 'VARCHAR', 'user_name': 'VARCHAR', 'start_time': 'TIMESTAMP',
    'end_time': 'TIMESTAMP', 'credits_attributed_compute': 'DOUBLE',
    'credits_used_query_acceleration': 'DOUBLE'});

INSERT INTO ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
SELECT * FROM read_csv('${DATA_DIR}/warehouse_metering_history.csv.gz', header = true, columns = {
    'start_time': 'TIMESTAMP', 'end_time': 'TIMESTAMP', 'warehouse_id': 'INTEGER',
    'warehouse_name': 'VARCHAR', 'credits_used': 'DOUBLE', 'credits_used_compute': 'DOUBLE',
    'credits_used_cloud_services': 'DOUBLE', 'credits_attributed_compute_queries': 'DOUBLE'});
