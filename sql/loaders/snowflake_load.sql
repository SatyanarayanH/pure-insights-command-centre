-- =============================================================================
-- loaders/snowflake_load.sql — Snowflake only. Stage, upload and COPY the files.
-- ${RAW_CSV} and ${DATA_DIR} are substituted by tools/snowflake/run.mjs.
-- PUT needs a client that supports it (the Node driver, SnowSQL or the Snowflake CLI);
-- it does not run in a Snowsight worksheet.
-- =============================================================================

CREATE OR REPLACE FILE FORMAT RAW.CSV_WITH_HEADER
    TYPE = CSV
    SKIP_HEADER = 1
    FIELD_OPTIONALLY_ENCLOSED_BY = '"'
    EMPTY_FIELD_AS_NULL = TRUE
    TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF3'
    COMPRESSION = AUTO;

CREATE OR REPLACE STAGE RAW.LANDING FILE_FORMAT = RAW.CSV_WITH_HEADER;

PUT 'file://${RAW_CSV}' @RAW.LANDING/telemetry AUTO_COMPRESS = TRUE OVERWRITE = TRUE;
PUT 'file://${DATA_DIR}/period_calendar.csv' @RAW.LANDING/calendar AUTO_COMPRESS = TRUE OVERWRITE = TRUE;
PUT 'file://${DATA_DIR}/sim_params.csv' @RAW.LANDING/sim_params AUTO_COMPRESS = TRUE OVERWRITE = TRUE;
PUT 'file://${DATA_DIR}/query_history.csv.gz' @RAW.LANDING/query_history AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
PUT 'file://${DATA_DIR}/query_attribution_history.csv.gz' @RAW.LANDING/query_attribution AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
PUT 'file://${DATA_DIR}/warehouse_metering_history.csv.gz' @RAW.LANDING/warehouse_metering AUTO_COMPRESS = FALSE OVERWRITE = TRUE;

-- METADATA$FILE_ROW_NUMBER is how source line order survives a COPY. The dataset has no
-- timestamp, so without it the period structure would be unrecoverable.
COPY INTO RAW.REPORT_TELEMETRY
FROM (
    SELECT METADATA$FILE_ROW_NUMBER, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
    FROM @RAW.LANDING/telemetry
);

COPY INTO RAW.PERIOD_CALENDAR FROM @RAW.LANDING/calendar;
COPY INTO CONFIG.SIM_PARAMS FROM @RAW.LANDING/sim_params;
COPY INTO ACCOUNT_USAGE.QUERY_HISTORY FROM @RAW.LANDING/query_history;
COPY INTO ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY FROM @RAW.LANDING/query_attribution;
COPY INTO ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY FROM @RAW.LANDING/warehouse_metering;
