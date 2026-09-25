# Command API — Slice 0: practice-case exclusion + contract audit (2026-09-25)

Branch `fix/admin-api-practice-exclusion`, based on **`origin/main` @ 8161661ac**. It is not based on local `main` @ c8a8f5356, for two reasons:
- Local `main` is 46 commits behind `origin/main`.
- Local `main` carries 5 unpushed doctor-api commits (Batch C part 2) that must not ride along on this branch.

Nothing is merged or pushed, and no prod data was changed. Prod reads were read-only SELECTs through the Supabase MCP (project `wvmhliweujmhlzknmuzh`), never through a connection string. The local `.env` `DATABASE_URL` points at localhost, not prod.

## 0. Already upstream

`221d0689d fix(practice): keep training cases out of every sweep, capacity and SLA number` (on `origin/main`, 2026-09-24) had already done part of this slice:
- It guarded `activeCaseSql` and `slaCountableCompletionSql` in `_assign_helpers.js`, so `breachedCaseSql`, `unassignedCaseSql` and `doctorLoadSql` inherit the guard.
- It guarded the five SLA-worker fetchers.

So on origin/main the Pulse **active / pending / breached** tiles, doctor load and candidates already excluded practice cases. These did not: awaiting review, revenue, the case list, the manual queue, the breach-cost denominator, the activity feed, and the whole web dashboard. This slice finishes that work and moves the predicate into one shared module.

## 1. The predicate and where it lives

`src/practice_cases.js`:

```js
realCaseSql(p)       // `NOT COALESCE(${p}is_practice, false)` — NULL (unmatched LEFT JOIN) counts as real
REAL_ORDERS_ACTIVE   // `(SELECT * FROM orders_active WHERE NOT COALESCE(is_practice, false))`
```

- `_assign_helpers.js` `activeCaseSql` / `slaCountableCompletionSql` now call `realCaseSql` instead of their own copy (same SQL). `breachedCaseSql`, `unassignedCaseSql`, `doctorLoadSql` and `slaHitRatioSql` inherit it.
- Hand-written dashboard queries swap `FROM orders_active` for `FROM ${REAL_ORDERS_ACTIVE} orders_active` (or `… o`), so the rest of each query is untouched.
- `buildFilters` (superadmin.js) now starts with the predicate. Everything built on it inherits:
  - `/superadmin/orders` (list, KPIs, recent events)
  - the CSV export
  - `routes/admin.js`'s two list views
- **The `orders_active` view is unchanged**, because the doctor queue needs practice rows. A test asserts that no later migration filters `is_practice` in the view.
- By-id reads, write paths, and refund- and gateway-driven reads carry a `practice-ok:` marker explaining why they may see a practice case.

## 2. A1 — classification

Classes:
- **(a)** A metric or list an operator sees. Must exclude practice cases.
- **(b)** A fetch by id. Must keep working.
- **(c)** Doctor load, capacity or assignment eligibility.
- **(r)** Driven by refunds or gateway events. Practice cases have none in prod (0 refunds, 0 earnings, 0 payment_events).

Line numbers are post-change on the branch.

### src/routes/api/admin.js (Command API)

| line | endpoint / fn | class | change |
|---|---|---|---|
| 475 | withRefundExtras | b (by refund id) | marker |
| 796 | /pulse aggregate | a | active/pending/breached/no-timer already guarded via 221d0689d; **awaiting_review** had its own tuple → now `AND realCaseSql` |
| 808 | /pulse needs-action breached rows | a | already guarded (breachedCaseSql) |
| 822 | /pulse pending-assignment rows | a | already guarded (unassignedCaseSql) |
| 839 | /pulse recent activity (order_events ⟕ orders) | a | **`WHERE realCaseSql('o.')`**. An event with no order stays |
| 941 | /refunds queue rows (ROW) | r | marker. Refund-driven, 0 on practice |
| 1006 | /refunds collected today / MTD tile | a | **guarded** |
| 1122 | /revenue list | a | **guarded** |
| 1310 | /cases list + total (`fromJoins` + `${where}`) | a | **`cond[0] = realCaseSql('o.')`**, applied under every filter. No escape hatch |
| 1347 | /cases facets | a | **`WHERE realCaseSql('o.')`** |
| 1438 | /cases/:id detail | b | selects `o.is_practice`, **adds `isPractice`** (additive) |
| 1479/1482 | /cases/:id doctor load + SLA% | c | already guarded (doctorLoadSql, slaHitRatioSql) |
| 1485 | /cases/:id inner doctor lookup | b | marker |
| 1620 | /cases/:id/candidates case fetch | b | marker |
| 1634 | /cases/:id/candidates doctor load | c | already guarded (doctorLoadSql) |
| 1710/1713 | /doctors load + SLA% | c | already guarded |
| 1835 | POST /cases/:id/assign FOR UPDATE | b/c write | marker. **Report:** an operator can still (re)assign a practice case by id |
| 1872 | POST /cases/:id/assign capacity gate | c | already guarded (doctorLoadSql) |
| 2043 | assign notification addressing | b | marker |
| 2213 | POST /cases/:id/sla-override | b write | marker |
| 2622/2695/2796 | refund approve/deny/mark-paid patient lookup | r/b | marker |
| 2856 | /payment-events (⟕ orders) | r | marker. Gateway-driven, 0 on practice |
| 3165/3184/3204 | /breach-cost by specialty / doctor / tier | r | marker. Refund-driven. Query (1) has no orders join, so filtering these alone would break "the parts sum to the total" |
| 3218 | /breach-cost refund-rate denominator (collected) | a | **guarded** |
| 3426/3447/3449 | /manual-queue list + total + paid | a | **`QUEUE_WHERE` gains the predicate** (prod: 0 practice rows in manual states) |
| 3588/3963 | manual-queue approve / unsuitable | b write | marker |
| — | /events (ops_push_log), /errors (error_logs), /payouts (earnings_reader), /payment-claims | — | no orders read, unchanged. Practice cases have 0 earnings rows. `ops_push_log` holds 2 historical pushes about practice cases (from before 221d0689d); it is a delivery log and stays unfiltered |

### src/services/superadmin_dashboard.js (web GET /superadmin): all 22 reads are class (a)

| lines | function | change |
|---|---|---|
| 121 | getStatusPills SLA on-time % | REAL_ORDERS_ACTIVE |
| 212, 221, 247, 259 | getAttentionItems (breached, urgent unassigned, manual queue, transfer claims) | REAL_ORDERS_ACTIVE |
| 286, 313, 330 | getSidebarBadges | REAL_ORDERS_ACTIVE |
| 369, 381, 403, 422, 437 | getOperationsTabData (KPIs, SLA buckets, live table, doctor presence, sparkline) | REAL_ORDERS_ACTIVE |
| 556, 565, 576, 631 | getFinanceTabData (revenue, tiers, FX zone, by specialty) | REAL_ORDERS_ACTIVE |
| 732 | getDoctorsTabData leaderboard | REAL_ORDERS_ACTIVE |
| 894, 897 | getPatientsTabData repeat patients | REAL_ORDERS_ACTIVE |
| 975, 994 | getMarketingTabData referrals | REAL_ORDERS_ACTIVE |

### src/routes/superadmin.js (web)

| line | route / fn | class | change |
|---|---|---|---|
| 668 | /superadmin/settings awaiting_manual | a | **guarded** |
| 1520 | buildFilters | a | **predicate first.** Covers /superadmin/orders (2248 list, 1797 KPIs, 2261 events), exports.js:43, routes/admin.js lists |
| 1560 | selectSlaRelevantOrders | c | **dead code** (no caller). Unchanged, reported |
| 1584 | countOpenCasesForDoctor (web reassign alternate-doctor picker) | c | **Report:** its own status list, counts practice cases as load. Not the shared helper, so not changed (no routing redesign in this slice) |
| 1671 | loadOrderWithPatient | b | unchanged |
| 2000 | getPendingAdditionalFilesRequests | — | **dead code** here (routes/admin.js has its own live copy). Unchanged |
| 2588 | /superadmin/orders/trash | b (recovery tool) | unchanged. Hiding deleted practice rows would make them unrestorable |
| 2634 | /superadmin/manual-queue list | a | **guarded** |
| 2699, 2808, 3139, 3253, 3318, 3438, 3470, 5101, 5266, 5395, 5453, 5590, 5713, 5774, 5800 | order page + all order write actions | b | unchanged (by id) |
| 6052 | /superadmin/events | a | **`where.push(realCaseSql('o.'))`**. An event with no live order stays |
| ~6177–6310 | /superadmin/analytics (18 reads: KPIs, previous period, attention, revenue trend, by service, by status, top doctors, SLA trend, TAT, payment methods, workload) | a | **all REAL_ORDERS_ACTIVE** |
| 6573 | /superadmin/refunds list | r | unchanged |
| 6607, 6663, 6744, 6969, 7037 | refund create / approve by order id | b | unchanged |

### Other files named in the brief

| file:line | class | change |
|---|---|---|
| src/routes/exports.js:43 | a | inherits buildFilters |
| src/routes/api/_assign_helpers.js | shared | threads `realCaseSql` (no SQL change) |
| src/services/admin_bulk_assign.js:88 | b/c write (ids from the app's selection, which no longer lists practice) | unchanged, reported |
| src/services/admin_bulk_assign.js:137 | c | already guarded (doctorLoadSql) |
| src/services/site_stats.js | — | reads no orders. Nothing to do |

## 3. Tests — before / after

New file: `tests/auth/practice-cases-operator-views.test.js`, 18 checks.

- **A0:** the predicate, and that every shared helper carries it.
- **A:** a small JS lexer finds every string literal that reads `orders`/`orders_active` in `api/admin.js` and `superadmin_dashboard.js`. Each one must carry the guard, a helper built on it, or a `practice-ok:` marker. It also pins `QUEUE_WHERE`, `cond[0]`, the collected tile, /revenue and the breach-cost denominator.
- **B:** `buildFilters` output, analytics (no raw orders read left), events, manual queue, settings, and that the view is untouched.
- **C (hermetic):**
  - `/cases` guards list, total and facets under 5 filter combinations.
  - `/cases/:id` returns `isPractice: true` for a practice row (and `false` for a real one).
- **D (local-DB fixture, own pg pool):** inserts 1 practice + 1 real paid order. `/pulse` active and pending move by exactly +1, `/cases?q=` returns exactly the real one, `/revenue?scope=mtd` gains exactly 1 order / EGP 500, and the practice case still opens by id with `isPractice`. Rows are deleted afterwards.
- **Mutation check:** restoring the old `api/admin.js` makes 9 checks fail (A×4, C×2, D×3).

Full suite (`node tests/run.js`) on this machine:

| run | before (origin/main) | after (branch) | failure set |
|---|---|---|---|
| local DB | 2708 pass / 37 fail / 11 skip | 2726 / 37 / 11 | identical |
| no-DB (`env DATABASE_URL=`) | 2496 / 6 / 52 | 2508 / 6 / 53 | identical |

Notes:
- These totals differ from the brief's "1735 / 61 / 37" because `origin/main` has grown since that figure was taken.
- The 6 no-DB failures are pre-existing (env-var docs, orders-readers allowlist ×1 set, payment-money wiring ×3, theme9 video gate).
- The only textual diff between the two DB failure lists is a random fixture id inside a pre-existing failure message.

## 4. A5 — prod before/after (read-only, Supabase MCP, 2026-09-25)

The same SQL the endpoints run, generated from the branch's own helpers. "Before" is the same SQL with the predicate replaced by `TRUE`, i.e. the pre-221d0689d state. On current `origin/main`, active / pending / breached are already the "after" values if 221d0689d is deployed; everything else is still "before".

| Pulse / Payments figure | before (practice counted) | after (this branch) |
|---|---|---|
| Active cases | 16 | **0** |
| Awaiting review | 16 | **0** |
| Pending assignment | 0 | **0** |
| SLA breached | 1 | **0** |
| Collected MTD (EGP) | 4,000.00 (27 orders) | **0** (0 orders) |
| `/cases` default list total | 31 | **4** |
| Doctors owed (/payouts) | unchanged: practice cases have 0 `doctor_earnings` rows | same |

Prod practice inventory today: 27 orders, all `payment_status='paid'`: 11 completed, 12 assigned, 4 in_review. The one real paid order was paid before September, so MTD revenue is honestly 0.

## 5. Part B — Command app contract diff

Baseline for "changed since the app was built":
- Portal: `e4962ebf0` (`git rev-list -1 --before=2026-08-31`, 2026-08-30 14:24).
- App: HEAD `185c84d` (2026-08-30 14:25).
- Envelope unchanged: `{success, data}` / `res.fail(msg, http, code)`.

### GET /payouts

The app's `PayoutDoctor` / `totals` (`lib/types.ts:779-803`) is **missing** the following, both per-doctor and in totals:
- `owedSettleableEgp`: delivered pending, i.e. what mark-paid can stamp. This is the number to transfer from.
- `owedInFlightEgp`: accepted but undelivered (owed minus settleable).
- `owedCasesEgp` / `owedAddonsEgp`: these existed at base and were never typed.

The headline "Owed to doctors" (`payouts.tsx:83`) and each doctor row (`:175`) show `owedEgp`, which **includes in-flight work**.

The meaning of `paid` changed. It is now stamped by `markMonthEndPaid` when the month-end payout runs (`basis.paid`, admin.js ~:4325), and reassigned rows earn zero. The app's copy still describes the old meaning:
- The caveat at **`app/(tabs)/more/payouts.tsx:116-118`**, verbatim:
  > Not settled cash. &quot;Paid&quot; on an earnings row means the CASE COMPLETED and the earning crystallised — it is not a bank transfer. There is no InstaPay settlement ledger in the platform, so nothing here can tell you whether the money actually left the account.
- Also stale: `:102` eyebrow "CRYSTALLISED THIS MONTH"; `:108` "case(s) completed"; `:255` empty state "Every completed case has been crystallised."; header comments `payouts.tsx:23-33` and `types.ts:768-777` ("set … at CASE COMPLETION by markCaseEarningsPaid").

`oldestUnpaidAt` is labelled "earliest pending earning". It is actually the acceptance date and includes in-flight rows.

### POST /payouts/mark-paid (new since base; the app has no type and no button)

`admin.js` ~:4347 calls `earnings_writer.markMonthEndPaid` (~:1043).

- **Guard:** router-level `requireJWT` + `requireRole('superadmin')`. No confirm token or dry-run.
- **Body:**
  - `month`: required, `'YYYY-MM'`. Otherwise **400 `BAD_REQUEST`**. A future month gives **400 `MONTH_IN_FUTURE`**. The current Cairo month is allowed.
  - `doctorId`: optional string. It is **not checked to exist**; an unknown id stamps 0 rows and returns 200.
  - **Omitting `doctorId` settles every doctor.**
- **Stamps:**
  - pending `doctor_earnings` rows (excluding `earn-reassign-%`) whose main case is **completed**, with a Cairo completion month equal to `month`. In-flight rows are never stamped.
  - pending `addon_earnings` rows with a Cairo `created_at` month equal to `month`.
  - Sets `status='paid', paid_at=NOW()`.
- **Idempotent:** a repeat call returns 200 with zeros, via `WHERE status='pending'`.
- **Not one transaction:** the two UPDATEs are separate. A failure between them leaves cases stamped and add-ons not; a re-run fixes it.
- Writes a best-effort `error_logs` audit row.
- **Response:** `{ month, doctorId|null, stamped: { caseRows, caseEgp, addonRows, addonEgp, totalEgp } }`.
- **Errors:** 400 `BAD_REQUEST`, 400 `MONTH_IN_FUTURE`, 500 `PAYOUTS_MARK_PAID_ERROR`.
- **Scope mismatch:** the screen's `owedSettleableEgp` covers **all months**, but mark-paid settles **one month per call**.

### GET /refunds and the refund actions

**Queue rows** gain the 13 Sep parity fields (`refundApiExtras`, admin.js ~:451). The app's `RefundQueueItem` (`types.ts:440-458`) lacks all of them:
- `eligibleEgp`: ceiling minus refunds already paid
- `alreadyRefundedEgp`
- `remainderEgp`: for an open row, eligible minus this refund; for paid/denied rows, equal to eligible
- `instapayMasked` (`+20******5678`)
- `instapayLast4`
- `paidToMasked`
- `paidBy`
- `patientReason`: the patient's free text. It is separate from `reason`, which is the reason code.
- Also untyped: `settledAmount` (pre-base), `kpis.refundsOwed.{unsettledCount,unsettledTotal,statuses}` and `counts.pendingRefundRequests`.
- The raw `instapayHandle` is **still shipped unmasked** alongside the masked fields.

**Actions.** The app sends the correct request keys (`payments/index.tsx:217-248`) but has no response types.

- **`POST /refunds/:id/approve`**
  - Body: `{approved_amount (required, finite), notes? ≤1000}`
  - Errors: 400 `AMOUNT_REQUIRED` / `INVALID_AMOUNT`, 404 `REFUND_NOT_FOUND`, 409 `NOT_APPROVABLE` / `AMOUNT_EXCEEDS_REQUESTED`
  - Response: `{refund:{…, parity fields}, notification}`
- **`POST /refunds/:id/deny`**
  - Body: `{denial_reason 1-1000}`
  - Errors: 400 `DENIAL_REASON_REQUIRED`, 404, 409 `NOT_DENIABLE`
  - Response: `{refund:{id,status,denialReason,reviewedAt,orderId,…parity}, notification}`
- **`POST /refunds/:id/mark-paid`**
  - Body: `{instapay_reference 1-100}`
  - Errors: 400 `INSTAPAY_REFERENCE_REQUIRED`, 404, 409 `NOT_PAYABLE` / `NO_AMOUNT`
  - Response: `{refund:{…, finalAmount, reason, orderPaymentStatusFlipped, orderPaymentStatusReason, …parity}, notification, clawback:'applied'|'skipped'|'failed'}`
  - The patient notice now also goes by WhatsApp.
- **`POST /cases/:id/refund`**
  - Its shape still matches `RefundResult` (`types.ts:365`).
  - **Changed since base:** a paid refund no longer blocks a new one, and the cap is now `remainingRefundableEgp` (charged minus paid refunds).
- **Portal-side bug (confirmed):** `GET /cases` (admin.js:1400) and `GET /cases/:id` (:1545) still ship `maxRefundable: maxRefundableEgp(...)`, the full ceiling. After any paid partial refund, the app's refund sheet (`components/refund.tsx:69`) offers amounts the write rejects with **409 `AMOUNT_EXCEEDS_MAX`**. The case-detail `refund` also shows only the latest row (`LIMIT 1`), though several can now exist.

### Auth, push-token, sign-out (Batch C)

- **`POST /auth/login`**
  - Body: `{email, password, deviceId?, deviceName?}` (both new, optional, ≤128).
  - Inserts a `user_sessions` row with `client:'command'`. With `deviceId`, earlier live rows for the same (user, device) are revoked.
  - Response unchanged: `{user, accessToken, refreshToken}`. Both JWTs now carry `sid`. Refresh TTL is 12h.
- **`POST /auth/refresh`**
  - Body unchanged: `{refreshToken}`.
  - Looks up the session row by token. If there is none, it falls back to `users.refresh_token` and adopts that token as a `legacy` session.
  - Errors: 401 `NO_REFRESH_TOKEN` / `INVALID_REFRESH` / `REFRESH_REVOKED`, 500 `REFRESH_UNAVAILABLE`.
  - Response unchanged.
- **`POST /push-token`**
  - Body unchanged: `{token: string|null}`.
  - With a `sid`, the token is stored on that session row; otherwise on `users.push_token`.
  - `null` clears the session's token **and unconditionally `users.push_token`**.
- **Old app builds keep working.** The app sends none of the new fields. The cost is that with no `deviceId`, every sign-in adds a row and nothing ever revokes one.
- **Does `notifySuperadmins` fan out to every live session?**
  - **Yes.** It selects the UNION of `users.push_token` and every non-revoked `user_sessions.push_token` for role superadmin, deduped per (user, token), and sends to each (`middleware/push.js:161`).
  - Prod today: 3 live superadmin sessions (2 `command`, 1 `legacy`) all hold the **same** Expo token, so the UNION resolves to 1 row / 1 push.
  - **No fix needed.**
- **Does sign-out revoke only its own row?**
  - **The Command app's sign-out revokes nothing.** `/api/v1/admin` has no logout route. `logout()` (`stores/authStore.ts:157`) only POSTs `/push-token {token:null}` and clears local storage.
  - The session row and its refresh token stay redeemable until expiry, which is why one phone has 3 live rows.
  - `POST /api/v1/auth/logout` (`routes/api/auth.js:742`, JWT-only, no role gate) *would* revoke only its own row (`revokeById(sid, userId)`, scoped `AND user_id=$2`). But the app does not call it, and it is a patient-router endpoint.
  - Access tokens outlive revocation by up to 15 minutes (`requireJWT` does not check sessions).
  - This is not a `notifySuperadmins` problem, so it was reported rather than fixed.

### GET /pulse, GET /cases, GET /cases/:id (vs base)

- **/pulse and /cases:** no fields added or renamed. Values change: practice cases are excluded, and on this branch that includes `awaitingReview`, the activity feed, the case list and facets.
- **/cases/:id:** gains **`isPractice: boolean`** (this branch only). `CaseDetail` (`types.ts:209`) lacks it. `CaseRefund` (`types.ts:193-198`) also lacks `payment.refund.requestedAmount` (pre-base).
- **Stale comments:** `types.ts:138` and `:480` still say `grandTotal = COALESCE(total_price_with_addons, price)`. The server has used `chargedEgpForOrder` since 2026-08-29.

### Summary for the app-side session

- **Payouts:** type `owedSettleableEgp` / `owedInFlightEgp` / `owedCasesEgp` / `owedAddonsEgp`. Make **settleable** the "pay this" figure and show in-flight separately. Rewrite `payouts.tsx:102,108,116-118,255` plus the header comments: paid now means the month-end payout ran, and reassigned earns zero.
- **Mark-paid button, if built:**
  - send `{month:'YYYY-MM', doctorId?}`, with a confirm step, because no `doctorId` means all doctors
  - handle 400 `BAD_REQUEST` / `MONTH_IN_FUTURE`
  - show `stamped.*`
  - it settles one month per call; a repeat returns zeros
- **Refunds:**
  - Type the 8 parity fields plus `settledAmount`, `refundsOwed.unsettled*` / `statuses` and `counts.pendingRefundRequests`.
  - Show the masked InstaPay fields.
  - Type the three action responses, including `clawback` and `orderPaymentStatus*`.
- **Refund sheet:** expect 409 `AMOUNT_EXCEEDS_MAX` after a partial refund until the portal ships `remainingRefundableEgp` as `maxRefundable`.
- **Auth:** send a stable `deviceId` and `deviceName` on login. Call a logout endpoint on sign-out, once the portal has an admin one.
- **Cases:** add `isPractice` to `CaseDetail` and badge practice cases; add `requestedAmount` to `CaseRefund`; fix the stale `grandTotal` comments.


## 6. Found in review

1. **Command sign-out never revokes its session.**
   - The app's `logout()` (`tashkheesa-command/stores/authStore.ts:157`) only POSTs `/push-token {token:null}` and clears local tokens.
   - `/api/v1/admin` has no logout route. `POST /api/v1/auth/logout` exists, revokes only its own `sid` row, and would accept a superadmin JWT, but the app never calls it.
   - Prod: 3 live superadmin sessions (2 `command`, 1 `legacy`), all holding the **same** Expo token, i.e. one phone signed in three times.
   - Each refresh token stays valid server-side until expiry.
2. **`POST /push-token {token:null}` also nulls `users.push_token` for the whole user**, not just this device. That is harmless today (the mirror = the same one token) but would silence a second, pre-C1 device.
3. **`notifySuperadmins` fan-out is correct:** it sends to the UNION of `users.push_token` and every non-revoked session token, deduped per (user, token). Prod resolves to 1 row / 1 distinct token. No fix needed.
4. `routes/admin.js` (admin-role console) has its own revenue and count tiles outside `buildFilters` (e.g. ~:879, :891). Those still count practice cases. They are outside this slice's file list.
5. `countOpenCasesForDoctor` (web reassign alternate picker) counts practice cases as load, disagreeing with `doctorLoadSql`.
6. Dead code: `selectSlaRelevantOrders` and superadmin.js's `getPendingAdditionalFilesRequests`.
7. Pre-existing, unrelated to this slice: analytics' payment-method revenue still sums `total_price_with_addons`, a column nothing writes.
8. **Migration number collision waiting on local `main`:** local `main` has `117_doctor_push_prefs_and_arabic_report.sql`, while `origin/main` already owns 117 (`payment_claims`, commit e684a6a56). The doctor-api commits need a renumber before they are pushed.
10. **Refund cap mismatch (portal bug, not fixed here):** `maxRefundable` on `/cases` and `/cases/:id` is the full ceiling (`maxRefundableEgp`), while `POST /cases/:id/refund` caps at `remainingRefundableEgp`. After a partial refund, the app offers amounts the server 409s.
9. Prod has 1 additional-files event on a practice order. The live admin inbox (`routes/admin.js` getPendingAdditionalFilesRequests) will show a practice-case file request. It was left visible on purpose: hiding it could stall the doctor's training flow.

## 7. Deliberately not done

- The `orders_active` view: not touched.
- No escape hatch (e.g. `?includePractice=1`) on any list.
- Write paths (assign, bulk-auto-assign, SLA override, manual-queue actions, web order actions) still act on a practice case given its id. Blocking them is a routing/policy decision, not a read fix.
- `countOpenCasesForDoctor` and web reassign: not changed (not the shared helper).
- Refund-, gateway- and earnings-driven reads: not filtered. They carry markers, and prod has 0 practice rows in each.
- `/events` (`ops_push_log`): not filtered. It is a delivery log.
- No app-side edits; the app repo was read only.
- No migrations, no prod DML. Prod reads went through the Supabase MCP only.

## 8. Needs Ziad

1. **Merge + deploy go.** The branch is on origin/main. After the Render deploy, Pulse should read 0/0/0/0 and MTD EGP 0 (§4).
2. **Practice-case write policy.** Should `POST /cases/:id/assign` / reassign / SLA-override refuse `is_practice` orders (e.g. 409 `PRACTICE_CASE`)? Same question for the web reassign picker's load count (`countOpenCasesForDoctor`).
3. **Command sign-out.** Two options:
   - (a) The app calls `POST /api/v1/auth/logout` before clearing tokens (app-side change), or
   - (b) add `POST /api/v1/admin/auth/logout` mirroring it (portal change).
   Also, whether to revoke the 2 stale rows for the one phone now.
4. **`routes/admin.js` admin-console tiles** (§6.4): include in a follow-up slice?
5. **Migration 117 collision** on local `main`'s unpushed doctor-api work (§6.8).
6. **Refund cap fix** (§6.10): ship `remainingRefundableEgp` as `maxRefundable` on `/cases` + `/cases/:id` in its own small PR?
7. **Practice file request** in the admin inbox (§6.9): keep visible, or route elsewhere?
