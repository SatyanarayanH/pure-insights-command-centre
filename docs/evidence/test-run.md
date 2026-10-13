# Test run

`npm test` on v23.11.0, 2026-10-13T16:55Z.

```

> pure-insights-command-centre@1.0.0 test

▶ rule evaluation
  ✔ treats "exceeds 15 seconds" as strictly greater than
  ✔ tiers latency severity at 15 / 30 / 45 seconds
  ✔ has no opinion when the observation lacks the metric
  ✔ treats FAILED and TIMED_OUT as failures, and UNKNOWN as neither failure nor success
  ✔ flags negative credits
✔ rule evaluation
▶ alert lifecycle
  ✔ opens one alert on the first breach
  ✔ does not alert on a healthy observation
  ✔ folds repeated breaches into the same alert instead of opening new ones
  ✔ emits an event for every breaching observation, as the brief requires
  ✔ escalates and de-escalates with the observed value
  ✔ resolves only after resolveAfter consecutive healthy observations
  ✔ resets the healthy streak when a breach interrupts it
  ✔ reopens the same alert when the breach returns soon after resolving
  ✔ opens a new alert when the report stayed healthy long enough
  ✔ marks an alert that keeps reopening as flapping
  ✔ stops calling an alert flapping once it has fired steadily
  ✔ tracks rules independently on the same report
  ✔ escalates a refresh failure to critical on the third consecutive failure
  ✔ resolves a refresh failure on the first success
  ✔ does not let an UNKNOWN refresh resolve or extend a refresh-failure alert
  ✔ skips disabled rules
  ✔ applies changed thresholds to the next observation
  ✔ keeps an acknowledgement when further breaches arrive
✔ alert lifecycle
▶ lifecycle invariants under random telemetry
  ✔ holds after 6,000 random observations across 25 reports
✔ lifecycle invariants under random telemetry
▶ authentication
  ✔ signs in with the demo password and returns role and permissions
  ✔ gives the same answer for a wrong password and an unknown account
  ✔ sets the refresh token as an httpOnly, SameSite=Strict cookie scoped to the auth path
  ✔ rotates the refresh token, and revokes the session when an old token is replayed
  ✔ ends the session on logout
  ✔ rejects a tampered or expired access token
  ✔ refuses demo sign-in when demo mode is off
✔ authentication
▶ error contract
  ✔ returns RFC 9457 problem details with field-level errors and a request id
  ✔ answers unknown API paths and malformed JSON in the same shape
  ✔ echoes a caller-supplied request id
✔ error contract
▶ reports
  ✔ lists all 100 reports with filtering, sorting and paging
  ✔ returns a report with its 20-period history and ownership trail
  ✔ summarises health for the overview
✔ reports
▶ orphan remediation
  ✔ ranks orphans by cost at risk and suggests an owner from history
  ✔ assigns an owner: queue shrinks, alerts re-route, the change is audited, the owner gains access
  ✔ refuses an assignee who is not a Report Owner, and a no-op reassignment
✔ orphan remediation
▶ telemetry and alerting through the API
  ✔ accepts a batch, processes the valid events and reports the rejected ones
  ✔ opens a latency alert above 15 s, not at exactly 15 s
  ✔ keeps a latency alert open, marked as recovering, after a single healthy reading
  ✔ opens a refresh alert on failure and escalates it on the third in a row
  ✔ injects incidents through the same pipeline and recovers from them
  ✔ lets an admin change a threshold, audits it, and rejects inconsistent tiers
✔ telemetry and alerting through the API
▶ alert history from the dataset
  ✔ starts with the alerts the engine derived from 20 periods of telemetry
✔ alert history from the dataset
▶ cost and data quality
  ✔ reconciles the platform bill: metered = report credits + idle + unattributed + quarantined
  ✔ prices each report per active view and leaves zero-view periods undefined
  ✔ charges back to owners with the unowned pool as its own line
  ✔ lists anomalies with a dollar figure
  ✔ exposes data-quality rules, findings traceable to a source line, and the quarantine
✔ cost and data quality
▶ a dirtier file than the one provided
  ✔ builds, and every reconciliation check that guards the arithmetic still passes
  ✔ recognises every spelling of "no owner" and normalises a messy address
  ✔ normalises status case and treats a blank status as unknown
  ✔ quarantines credits that are not numbers or are missing, and still costs those rows
  ✔ never produces a NULL where the application expects a yes or no
  ✔ serves every page of the application from it
✔ a dirtier file than the one provided
▶ a file with a different shape
  ✔ one period only: 120 distinct reports, each seen once
  ✔ a single report in a single period
  ✔ an incomplete panel: one report is missing its last period
✔ a file with a different shape
▶ OpenAPI document
  ✔ has exactly one operation per mounted route, with its permission
  ✔ has no dangling references and documents every path parameter
  ✔ is served by the running application and matches the committed file
✔ OpenAPI document
▶ AsyncAPI document
  ✔ describes every server event and client message, with no dangling references
  ✔ matches the committed file
✔ AsyncAPI document
▶ generated markdown
  ✔ keeps the committed API reference and data-quality report in step with the code
✔ generated markdown
▶ hostile and malformed network input
  ✔ survives upgrade requests whose target is not a parseable URL
  ✔ disconnects a WebSocket client that floods the server with messages
  ✔ does not believe X-Forwarded-For unless told there is a proxy
  ✔ serves no inline-script allowance in its content security policy
✔ hostile and malformed network input
▶ resuming an event stream across a server restart
  ✔ tells a client whose event id is from before the restart to start again
  ✔ does not trust an old id just because it happens to be in range
  ✔ still resumes normally within the same stream
✔ resuming an event stream across a server restart
▶ alert state that must not get stuck
  ✔ ends a snooze when its time is up
  ✔ closes the open alerts of a rule when the rule is disabled, and starts fresh when re-enabled
  ✔ refuses a rule change that changes nothing
✔ alert state that must not get stuck
▶ telemetry timestamps
  ✔ rejects a timestamp that is not a timestamp
  ✔ rejects a timestamp in the future, allowing for clock skew
  ✔ rejects an event older than what is already held, so stale data cannot overwrite current state
  ✔ applies ordering within one batch as well
✔ telemetry timestamps
▶ sign-in
  ✔ spends the same effort on an unknown account as on a wrong password
  ✔ records failed sign-ins in the audit log
  ✔ sets a script-readable hint cookie that carries no secret, and clears it on sign-out
✔ sign-in
▶ restarts and upgrades of the operational database
  ✔ keeps alerts, acknowledgements and the audit trail across a restart, and does not replay history twice
  ✔ upgrades a database written by an earlier build instead of failing on a missing column
✔ restarts and upgrades of the operational database
▶ SQL suite
  ✔ is idempotent: running it twice on the same database gives the same answer
✔ SQL suite
▶ role definitions
  ✔ gives the admin every permission and nobody else all of them
  ✔ keeps cost and unmasked email away from viewers, and writes away from finops
  ✔ scopes report owners to their own reports
  ✔ masks email addresses so that different owners cannot be told apart
✔ role definitions
▶ access matrix: every route x every role
  ✔ rejects anonymous calls to every protected route with 401
  ✔ admin: allowed exactly where the role holds the route's permission
  ✔ finops: allowed exactly where the role holds the route's permission
  ✔ owner: allowed exactly where the role holds the route's permission
  ✔ viewer: allowed exactly where the role holds the route's permission
✔ access matrix: every route x every role
▶ row-level security (Report Owner)
  ✔ lists only the reports the owner owns
  ✔ answers 404 for a report it does not own, exactly as for one that does not exist
  ✔ scopes alerts, overview and cost to the same reports
  ✔ cannot read or acknowledge an alert on someone else's report
✔ row-level security (Report Owner)
▶ field-level security (Viewer)
  ✔ receives no cost block and no efficiency label on any report
  ✔ receives masked owner emails everywhere, never the real address
  ✔ cannot use the owner filter to work out who owns what
  ✔ cannot sort its way to cost information
✔ field-level security (Viewer)
▶ machine identity (telemetry emitter)
  ✔ may push telemetry with the API key and nothing else
✔ machine identity (telemetry emitter)
▶ event bus
  ✔ numbers events monotonically and replays everything after a given id
  ✔ reports a gap when the requested events have left the buffer
  ✔ keeps delivering when one listener throws
✔ event bus
▶ tickets
  ✔ are single-use and expire after 30 seconds
  ✔ cannot be minted without a session
✔ tickets
▶ WebSocket stream
  ✔ greets with connection.ready describing the caller and the stream
  ✔ closes with 4401 for a missing, forged or reused ticket
  ✔ pushes alert.fired the moment latency exceeds the threshold, then alert.resolved
  ✔ pushes alert.fired when an automated refresh fails
  ✔ sends alert.updated, not a second alert.fired, for a repeat breach
  ✔ broadcasts an acknowledgement to other connected users
  ✔ applies row-level security: an owner only receives events for reports they own
  ✔ applies field-level security: a viewer receives masked owner emails
  ✔ routes an alert on an orphaned report to admins and re-routes it when an owner is assigned
  ✔ resumes after a disconnect: events missed while away are replayed in order
  ✔ answers ping with pong and honours subscribe / unsubscribe
  ✔ reports malformed client messages without dropping the connection
  ✔ counts live connections in system status
✔ WebSocket stream
▶ Server-Sent Events stream
  ✔ delivers the same events in the same envelope as the WebSocket
  ✔ resumes from Last-Event-ID
  ✔ refuses a missing or reused ticket with 401 problem details
✔ Server-Sent Events stream
▶ WebSocket origin check (production)
  ✔ accepts the page the API itself serves (same origin), which is how the Docker image runs
  ✔ accepts an allow-listed origin and refuses any other
✔ WebSocket origin check (production)
▶ csv
  ✔ reads quoted fields, escaped quotes and embedded commas
  ✔ reads the dataset as 2,000 rows with the ten documented columns
✔ csv
▶ prng
  ✔ is deterministic per key and differs across keys
✔ prng
▶ splitStatements
  ✔ ignores semicolons in strings, quoted identifiers and comments
  ✔ drops comment-only fragments
✔ splitStatements
▶ ACCOUNT_USAGE simulator
  ✔ finds the panel structure: 100 reports x 20 periods
  ✔ is deterministic: the same input and parameters give byte-identical files
  ✔ is a pure disaggregation: query credits sum back to the dataset for every report-period
  ✔ never meters less than the queries used, and keeps negative values out of the meter
✔ ACCOUNT_USAGE simulator
▶ SQL suite on DuckDB
  ✔ passes every reconciliation check
  ✔ reports the defect counts found by profiling the dataset
  ✔ keeps every landed row and quarantines without deleting
  ✔ never divides by zero views
  ✔ agrees across attribution methods
  ✔ classifies credits that belong to no catalogued report instead of dropping them
  ✔ finds 14 reports orphaned in the latest period and suggests an owner for each
✔ SQL suite on DuckDB
▶ request schemas
  ✔ normalises email addresses before they reach a handler
  ✔ applies list defaults and bounds the page size
  ✔ requires a telemetry event to carry at least one measurement
  ✔ accepts negative credits so they can be flagged rather than silently refused
  ✔ rejects alert thresholds that do not increase
  ✔ only admits known WebSocket client messages
✔ request schemas
ℹ tests 150
ℹ suites 38
ℹ pass 150
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19261.209416
```
