// The driver is installed on demand (`npm run sql:snowflake`), so it is declared loosely here
// to keep the main typecheck independent of it.
declare module 'snowflake-sdk';
