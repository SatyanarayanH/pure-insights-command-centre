# Five-minute walkthrough

Start the app (`npm install && npm run dev`, then http://localhost:5173, or `docker compose up --build` and http://localhost:4000).

## 1. The dataset is not what it looks like (1 min)

Sign in as **Platform Admin**. Open **Data quality**.

- 2,000 rows, but 100 reports × 20 periods: say why de-duplicating or counting rows would both be wrong.
- "Defects listed in the brief" and, below it, "Defects found by profiling": five the brief does not mention.
- Click **DQ-02 negative credits**: each finding names the CSV line it came from.
- **Reconciliation: 16 / 16**. The app does not start if one fails.

## 2. Alerting that stays usable (1.5 min)

Open **Alerts**.

- Three quarters of observations exceed 15 seconds. One alert per report per rule, with a count, instead of one per observation.
- Point at severity tiers, **Escalated to admins** (the report has no owner to tell) and **Flapping**.

Now the live part. Open a **private window** (or a different browser), sign in as **Viewer**, and put the two side by side. Two ordinary windows of the same browser share one session, so the second sign-in would replace the first.

- In the admin window open **Reports → Analytics Dashboard 41** (`RPT_240`) and click **Recovery** twice, then **Latency spike**.
- The viewer window shows the alert within a second, without reloading.
- In the viewer window, every owner email reads `u***@company.com` and there is no cost anywhere.

Sign the second window in as **Report Owner → user_7@company.com** instead. Inject a spike on a report that is not theirs: nothing arrives. Inject one on `RPT_230`: it does.

## 3. Orphaned reports are a cost problem (1 min)

Open **Orphaned reports**.

- 14 reports, about $32,000 a month with nobody accountable, ranked by cost.
- Each has a suggested owner from its own history. Click **Assign**, confirm.
- The row leaves the queue, the report's alerts re-route to the new owner, and **Admin → Audit log** has the entry.

## 4. Cost attribution that adds up (1.5 min)

Open **Cost**.

- **Where the metered credits went**: every billed credit is in one of four lines.
- **Attribution methods**: direct, idle-loaded, time-weighted. Two independent methods agree to within 2%.
- The 24 negative credit figures summed to −161 credits. The queries behind them cost about $49,000. Filtering alone would have hidden that.
- **Usage against cost**: the orange dots are zombies. **Does cost follow usage?**: correlations near zero, which is the discrepancy the brief describes.

## If there is time

- `http://localhost:4000/docs`: the API explorer, generated from the code.
- **Admin → Access**: the permission matrix, read from the same table the server enforces.
- `npm test`: 150 tests in about 20 seconds, including every route against every role.
