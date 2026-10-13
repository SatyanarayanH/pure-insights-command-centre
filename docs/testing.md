# How it was tested, and what that found

Passing tests show that the code does what its author expected. This page is about the other kind of testing: trying to break the system on purpose, in every area, and writing down what broke.

## The checks

| Area | Method | Where |
| --- | --- | --- |
| Cost model | 16 reconciliation checks run inside the SQL suite on every start | `sql/07_reconciliation_tests.sql` |
| Two engines | The same SQL on DuckDB and on Snowflake, every result table compared row by row | `tools/snowflake/run.ts`, `docs/evidence/snowflake-run.md` |
| Other input files | The whole pipeline on dirtier, flat, single-row and incomplete files | `apps/api/test/data-variants.test.ts` |
| Alert lifecycle | 23 scripted cases, then 6,000 random observations checked against an independent reference model | `apps/api/test/alert-engine.test.ts` |
| Access control | Every route called as every role and anonymously, generated from the route registry | `apps/api/test/rbac.test.ts` |
| Real-time | WebSocket and SSE: delivery, per-recipient filtering, resume, restart, flood, origin | `apps/api/test/realtime.test.ts` |
| Hostile input | Malformed upgrade requests, bad timestamps, replayed tokens, forged tickets | `apps/api/test/hardening.test.ts` |
| Persistence | Restart on the same database; upgrade of a database written by an older build | `apps/api/test/hardening.test.ts` |
| Contract | Every response validated against its schema; committed OpenAPI and AsyncAPI compared with the code | `apps/api/test/docs.test.ts` |
| Browser | Per-role journeys, and a sweep of every page for console errors, failed requests, broken values, sideways scroll and WCAG 2 AA violations, in light and dark | `e2e/` |

## What the bug hunt found

All of these were real, all are fixed, and each has a regression test.

### Could take the service down

| Defect | Cause | Fix |
| --- | --- | --- |
| A single malformed request could crash the server. `GET //` with an `Upgrade` header threw `Invalid URL` in the WebSocket upgrade handler, which runs outside Express and so outside its error handling. | Unchecked URL parsing in an event handler | Parse inside a guard and drop the socket; process-level handlers log anything else instead of dying. |

### Wrong or misleading behaviour

| Defect | Cause | Fix |
| --- | --- | --- |
| After a server restart, connected browsers silently ignored every live event. | Event ids restart from 1; the client compared them with the id it remembered from the old process and discarded them as duplicates. | Each run of the stream has a `streamId`. A resume from another stream replays nothing and tells the client to start again. |
| In the Docker image the app never used WebSocket; it fell back to SSE without saying why. | The production origin check refused the app's own page. | Same-origin is always accepted. |
| A snoozed alert stayed snoozed for ever. | The expiry time was stored but never compared with the clock. | An expired snooze is reported as no snooze. |
| Disabling an alert rule left its alerts firing permanently. | A disabled rule is never evaluated, so nothing could clear them. | Disabling a rule resolves its open alerts, on the record. |
| An alert was labelled "flapping" long after it had settled into firing steadily. | The reopen count never decayed. | The flap count resets after four breaches in a row. |
| A late telemetry event overwrote a report's current state with stale values. | Emitter timestamps were accepted without any check; `"banana"` was accepted too. | Strict ISO-8601; reject future timestamps and anything older than what is held. |
| The "Firing" card showed a severity breakdown that added up to a different number. | The breakdown counted open alerts, the headline counted firing ones. | The card now counts what its breakdown describes. |
| A healthy report could show a firing alert with no explanation. | Correct behaviour (two healthy readings are needed to clear) with nothing on screen to say so. | Alerts in that state are labelled "Recovering 1/2". |
| On a first start, the sign-in page showed no personas and never recovered. | The page asked the API for sign-in options once, while the API was still building the warehouse, and took the failure as "there are none". | It keeps asking, and says the system is starting. |

### Privacy and security

| Defect | Cause | Fix |
| --- | --- | --- |
| Masked emails were not masked. `u****7@company.com` kept the last character and the length, giving 14 distinct values for 14 owners. | A mask designed to stay "recognisable" | First character and domain only, fixed width: every owner reads `u***@company.com`. |
| A viewer could find out who owns a report anyway. | `GET /reports?owner=` filtered on the real address. | The filter requires `pii:read`. |
| Sign-in response time revealed which emails have accounts (about 60 ms against 3 ms). | The password hash was only computed when the account existed. | Unknown accounts are checked against a real hash. |
| Anyone could reset their own rate limit. | `X-Forwarded-For` was trusted with no proxy in front. | Trust is opt-in through `TRUST_PROXY`. |
| The content security policy allowed inline scripts. | Left over from wiring up the API explorer, which does not need it. | Removed; a test loads the explorer under the stricter policy. |
| A client could send unlimited WebSocket messages. | No limit on the client-to-server channel. | 60 messages per 10 seconds, then disconnect. |

### Robustness to other data

| Defect | Cause | Fix |
| --- | --- | --- |
| A blank or non-numeric credit value crashed the whole build. | `Number("abc")` is `NaN`, which reached timestamp arithmetic in the simulator. | Blank and non-numeric values are "no figure": quarantined, and costed by the time-weighted method. |
| A blank measurement produced NULL where the API promises true or false, which fails response validation. | SQL comparisons with NULL are NULL. | Flags are coalesced; blanks are reported by a new rule, DQ-13. |
| A file with one report missing from one period refused to load at all. | The panel-completeness check was blocking. | It is advisory: it warns. |
| An existing database from an earlier build would have broken on the first schema change. | No schema versioning. | Versioned migrations, applied in place on start. |

### Interface

| Defect | Cause | Fix |
| --- | --- | --- |
| Every first visit logged a red 401 in the browser console. | The page always tried to restore a session. | It only tries when the server has said one may exist. |
| Viewers and owners triggered a 403 on the Alerts page. | The page requested alert rules regardless of role. | The request is only made when the role allows it. |
| Muted text failed WCAG AA contrast in light mode (3.5:1) and on selected rows in dark mode. | Colour chosen by eye | Recomputed for at least 4.5:1 on every surface, both modes; a test now enforces it on every page. |
| Scrollable panels could not be reached by keyboard. | No tab stop on scroll containers | Regions that actually overflow become named, focusable regions. |
| Most pages scrolled sideways on phones and tablets. | Grid tracks sized to their widest content; visually hidden text escaping a scroll container | Explicit track sizing; scroll containers are positioned. |
| Several labels hard-coded "20 periods" and "2,000". | Written against one file | Counts come from the data. |

## What is still not covered

- Load: nothing here measures behaviour under thousands of connections or events per second.
- Several server processes: the event bus and ticket store are in memory (see `production-path.md`).
- Real `SNOWFLAKE.ACCOUNT_USAGE`: the SQL ran on Snowflake, against simulated usage tables.
- Browsers other than Chromium.
