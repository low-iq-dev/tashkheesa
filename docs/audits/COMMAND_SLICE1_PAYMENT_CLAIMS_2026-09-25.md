# Command API — Slice 1: transfer-claim verify/reject + launch-week guards (2026-09-25)

Branch `feat/command-payment-claims` from origin/main `5435141a9` (slice-0 HEAD).
Builds on `docs/audits/COMMAND_SLICE0_PRACTICE_EXCLUSION_2026-09-25.md` §Part B,
and closes its needs-Ziad items #2 (practice write policy), #3 option (b)
(admin logout + stale-row revocation), #5-adjacent nothing, #6 (refund cap) and
review findings #1 (sign-out revokes nothing), #5 (`countOpenCasesForDoctor`),
#10 (`maxRefundable` is the wrong number).

Envelope throughout: `res.ok(data)` → `{success:true, data}`;
`res.fail(msg, http, code)` → `{success:false, error:"…", code:"CODE"}`.
All new routes sit behind the router-level `requireJWT` +
`requireRole('superadmin')` gate.

---

## 1. Part A — how the web verify/reject actually work

### The exact service function the web verify path calls

There is **no single one**. The web verify is `POST /superadmin/orders/:id/mark-paid`
(routes/superadmin.js ~5117), an inline route whose payment semantics live in
two called functions plus one inline UPDATE:

1. an **inline** `UPDATE orders SET payment_status='paid', payment_method=$1,
   payment_reference=$2, paid_at=COALESCE(paid_at,$3), updated_at=$4` (with a
   schema-fallback minimal UPDATE in a catch);
2. **`caseLifecycle.markCasePaid(orderId)`** — the canonical payment boundary;
3. **`manualPayment.confirmPendingClaimForOrder(orderId, actorId)`** — closes
   the pending claim as confirmed, LAST, after every other write.

`manual_payment.js` deliberately contains no verify function: THE RULE (pinned
by tests/core/manual-payment-claims.test.js, source-grep + recording mock)
forbids that module from ever writing `payment_status` — which is also why
slice 1's verify service is a **new file**, `src/services/admin_verify_claim.js`,
not an addition to `manual_payment.js`.

### What it writes

- `orders`: `payment_status='paid'`, `payment_method` (form value ‖ existing ‖
  `'manual'`), `payment_reference` (form value ‖ `manual_<uuid>`),
  `paid_at = COALESCE(paid_at, now)`, `updated_at`.
- via `markCasePaid` (its own transaction): status → `PAID`, `sla_hours`
  locked, `paid_at` COALESCEd again, urgent-out-of-window deferral
  (`deadline_at`/`sla_deadline` anchored to next 07:00 Cairo),
  `case_events` `PAYMENT_CONFIRMED` + `CASE_READY_FOR_ASSIGNMENT`, the
  `payment_confirmation` notification queue row.
- claim: `status='confirmed'`, `resolved_at`, `resolved_by`, `updated_at`
  (`WHERE status='pending'`; never throws).
- audit: `order_events` `'Payment marked as paid (superadmin)'`
  (best-effort, try/catch) + an add-ons `'Add-ons awaiting settlement'` event
  when selected add-ons have no `order_addons` settlement row. **Add-ons are
  flagged, never settled** — mark-paid has no amount field, so it is evidence
  about the base fee only.

### What it fires afterwards

`markCasePaid`'s **post-commit** hook (only when `doctor_id` is null):
`enqueueAutoAssign(caseId)` + `broadcastOrderToSpecialty(caseId)` — the paid-case
broadcast and auto-assign, the same pipeline the Paymob webhook uses. Plus the
patient's `payment_marked_paid_patient` in-app notice (queueNotification,
channel `internal` only), PostHog `case_paid`, and the urgent-deferred patient
notice when applicable.

### The guards

- **Amount: there is NO amount guard.** The route comment says so explicitly
  ("This handler has no amount field anywhere in it"). The human compares the
  bank statement against the transfer amount shown beside the form
  (`transferAmountForOrder` = `owedCentsForOrder` over price + persisted
  add-ons — the same figure the card flow charges). Claims themselves carry no
  amount (migration 117 has no amount column), so "amount claimed vs owed"
  cannot exist as a check. `display_price`/`locked_price` play no part —
  `display_price` is the un-multiplied catalogue base and `locked_price` was
  dropped; the charge truth is `owedCentsForOrder`.
- **Already-decided claim**: web mark-paid is idempotent on
  `payment_status==='paid'` (early redirect, claim untouched); web reject
  guards `WHERE status='pending'` → `not_pending`.
- **Deleted order**: `loadOrderWithPatient` reads `orders_active` → redirect;
  `markCasePaid` re-filters `deleted_at IS NULL` ("payment after soft-delete is
  refunded, not applied").
- **Practice order: NO guard on any web or Command write path** (slice-0
  finding, needs-Ziad #2). That is what B5 adds Command-side.
- `markCasePaid` failure → benign-regex triage; non-benign → `error_logs` +
  `sendCriticalAlert` + `?payment=paid_but_unrouted` (money recorded, case NOT
  in the pipeline, operator told honestly).

### Transaction shape

**The web path is NOT one transaction.** The inline UPDATE, `markCasePaid`
(its own txn), the add-on flag, the audit, the patient notice and the claim
confirmation are consecutive autocommit steps. A crash between them leaves the
order paid with the claim still pending (self-heals: mark-paid is idempotent,
the pending-claims queue hides claims on paid orders). `rejectClaim` likewise:
one guarded UPDATE, then best-effort audit + patient notification (in-app +
email, bilingual `payment_claim_rejected_patient`).

The **slice-1 Command verify** tightens this: payment facts + claim
confirmation + BOTH audit rows are ONE transaction (the established Command
write pattern); only `markCasePaid` + the add-on flag + the patient notice run
post-commit, exactly where the web runs them. `markCasePaid` cannot be inside
the txn: it opens its own transaction on the same row (`withTransaction` +
`FOR UPDATE`) and would self-deadlock — the same reason `POST /cases/:id/assign`
drops its lock before `reassignCase`.

---

## 2. The contract (the app leg's input)

### B1 — `POST /api/v1/admin/payment-claims/:id/verify`

Body (all optional; defaults are the claim's own facts — what the operator
just matched on the statement): `{ "method"?: string ≤80, "reference"?: string ≤100 }`.

200 (fresh verify):

```json
{
  "success": true,
  "data": {
    "claim": {
      "id": "pc-…", "status": "confirmed", "method": "instapay",
      "reference": "TRX-123", "senderName": "Mona Ali",
      "submittedAt": "2026-09-25T07:30:00.000Z", "rejectionReason": null,
      "createdAt": "2026-09-25T07:00:00.000Z", "resolvedAt": "2026-09-25T09:00:00.000Z"
    },
    "order": {
      "id": "ord-…", "reference": "TSH-2026-000417", "paymentStatus": "paid",
      "paymentMethod": "instapay", "paymentReference": "TRX-123",
      "paidAt": "2026-09-25T09:00:00.000Z"
    },
    "alreadyVerified": false,
    "routed": true,
    "notifications": { "patient": "queued" }
  }
}
```

- `routed:false` (still HTTP 200) = the money is recorded but `markCasePaid`
  failed non-benignly: the case is **paid and NOT in the assignment pipeline**
  (`error_logs` + on-call alert already fired) — the API spelling of the web's
  `?payment=paid_but_unrouted`. The app must surface "re-route by hand", not
  treat it as success-and-done.
- `notifications.patient`: `queued | failed | skipped_no_patient`.
- Idempotent replay (double-tap): 200 with `alreadyVerified:true`,
  `routed:null`, `notifications.patient:"not_attempted"` — nothing written,
  nothing fired.

Errors: `400 BAD_REQUEST` (overlong body field) · `401/403` (gate) ·
`404 CLAIM_NOT_FOUND` · `404 ORDER_NOT_FOUND` (claim on a soft-deleted order) ·
`409 CLAIM_ALREADY_DECIDED` (claim was rejected) · `409 PRACTICE_CASE` ·
`409 ORDER_ALREADY_PAID` (card raced the transfer — see needs-Ziad #2) ·
`500 CLAIM_VERIFY_ERROR`.

### B2 — `POST /api/v1/admin/payment-claims/:id/reject`

Body: `{ "reason": string 1–500 }` — **required**; the patient reads it
verbatim (bilingual `payment_claim_rejected_patient`, in-app + email, queued by
the same `manual_payment.rejectClaim` the web calls).

200:

```json
{
  "success": true,
  "data": {
    "claim": {
      "id": "pc-…", "status": "rejected", "method": "instapay",
      "reference": "TRX-123", "senderName": "Mona Ali",
      "submittedAt": "2026-09-25T09:01:00.000Z",
      "rejectionReason": "No matching transfer on the statement",
      "createdAt": "2026-09-25T07:00:00.000Z", "resolvedAt": "2026-09-25T09:01:00.000Z"
    },
    "order": { "id": "ord-…", "reference": "TSH-2026-000417", "paymentStatus": "unpaid" },
    "alreadyRejected": false
  }
}
```

- The order is **never touched** (pinned in tests). The patient may submit a
  fresh claim afterwards (a new pending row; the rejected one stays history).
- Idempotent replay: rejecting an already-rejected claim returns 200 with
  `alreadyRejected:true` and the **stored** reason — nothing rewritten.

Errors: `400 REASON_REQUIRED` / `400 REASON_TOO_LONG` · `404 CLAIM_NOT_FOUND` ·
`409 PRACTICE_CASE` · `409 CLAIM_ALREADY_DECIDED` (claim was verified) ·
`500 CLAIM_REJECT_ERROR`.

### B3 — `GET /api/v1/admin/payment-claims?status=pending|confirmed|rejected`

Additive on every row (no existing field changed):

```json
{
  "tier": "standard | urgent | vip",
  "urgencyTier": "urgent",
  "patient": { "name": "…", "email": "…", "phone": "…", "age": 36 }
}
```

- `tier` is normalized exactly like `GET /cases` (`fast_track`→`vip`, default
  `standard`); `urgencyTier` is the raw column; `patient.age` whole years from
  `date_of_birth`, null when unknown.
- **What the brief asked for that does not exist in the platform** (nothing to
  ship, documented so the app doesn't wait for it):
  - *amount claimed*: `payment_claims` has **no amount column** — a claim is
    method + reference + sender name. `amount` + `currency` on the row already
    ARE the amount owed (`owedCentsForOrder`, the figure the card flow would
    charge and the one the web shows beside the mark-paid form).
  - *screenshot*: no transfer-screenshot upload exists anywhere in the claim
    flow (web or app), so there is no file id to serve via `/files/:fileId`.
- The list (shared with the web queue) now also carries the slice-0 practice
  predicate — a claim on a training case, should one ever exist, is not an
  operator work item.
- The queue continues to HIDE pending claims on orders that got paid some
  other way (moot rows) — which pairs with verify's `ORDER_ALREADY_PAID`.

### B7 — `POST /api/v1/admin/auth/logout`

Superadmin-gated (401 no token / 403 wrong role). Body: none.
Always `200 {"message":"Signed out"}` — including when the row is already
revoked (idempotent), when the store errors, and for a pre-C1 token with no
`sid` (deliberate NO-OP: the patient route's no-sid branch nulls
`users.push_token` for the whole account, which would silence the other live
Command devices).

With a `sid`: `sessionStore.revokeById(sid, userId)` — the caller's own row
only (the user_id clause makes cross-user revocation structurally impossible),
plus the existing mirror hygiene (`users.refresh_token` / `users.push_token`
cleared when attributable to this device) — then the revoked row's own
`push_token` is nulled. Access tokens still outlive revocation by ≤15 min
(`requireJWT` does not check sessions — pre-existing, unchanged).

**App leg**: `logout()` in `stores/authStore.ts` should call this BEFORE its
existing `POST /push-token {token:null}` + local wipe, and send a stable
`deviceId` on login so re-logins replace their row.

### B5 — practice guards (write paths)

`409 PRACTICE_CASE` (error text names it a doctor-training case) on:

- `POST /cases/:id/assign`
- `POST /cases/:id/sla-override`
- `POST /cases/:id/refund` (guard inside `issueRefund`, under the row lock —
  prod has 27 *paid* practice orders; refunding one would mint a real payout
  obligation)
- `POST /manual-queue/:id/approve`
- `POST /manual-queue/:id/unsuitable`

`POST /cases/bulk-auto-assign` **skips** practice rows instead:
`{ "caseId": "…", "reference": "…", "reason": "practice_case" }` — checked
first, before `already_assigned`/`payment_not_confirmed`/…, since being
practice trumps every other skip reason. dryRun reports the same plan.

`countOpenCasesForDoctor` (web reassign alternate picker) now carries
`realCaseSql('')`, closing slice-0 finding #5 (practice cases counted as load
there and nowhere else).

### B6 — the refund cap is the write's number

`GET /cases` rows and `GET /cases/:id → payment`:

- `maxRefundable` **keeps its name, fixes its value**: now
  `remainingRefundableEgp` = ceiling (`maxRefundableEgp`: charged − consumed
  video add-on) **minus refunds already PAID back** — precisely what
  `services/admin_refund.js` enforces (`AMOUNT_EXCEEDS_MAX` otherwise).
- `remainingRefundableEgp` rides alongside with the same value (the web's own
  name for the figure), additively.
- List rows compute it with ONE batched refunds query per page
  (`paidRefundedEgpByOrders`, same COALESCE chain) through the same cents
  arithmetic (`remainingFromCeilingEgp`) the write path runs — new helpers in
  `services/refund_eligibility.js`, so the two cannot drift.
- Fail-loud (`mustAll`): a failed refunds read is a 500, never a silently
  overstated cap.
- `grandTotal` is unchanged (still the full charge) — the app should CAP on
  `maxRefundable` and DISPLAY `grandTotal`.

---

## 3. B8 — prod dry-run: revoking the stale superadmin sessions

Read (Supabase MCP, read-only; no token values selected): the superadmin now
has **FOUR live `user_sessions` rows, not the three in the brief** — a fourth
sign-in happened today (the brief predates it):

| created_at (UTC) | id | client |
|---|---|---|
| 2026-09-22 08:36 | `sess-legacy-d1d04fb8-cc53-4928-b412-60f763546d09` | legacy |
| 2026-09-22 18:20 | `sess-66a0394d-eecb-4109-90e7-c75111d79cce` | command |
| 2026-09-24 08:26 | `sess-55d6a0eb-09be-453f-b752-5f50a711691a` | command |
| **2026-09-25 14:25** | `sess-d4b37d6f-b84e-4b1f-8709-51d6d6e262bb` | command — **the live one, kept** |

All four carry ONE distinct push token (one phone; `device_id` null on the
command rows because the app doesn't send `deviceId` yet — which is exactly why
they accumulate). "The two older rows" therefore became **three stale rows**;
the dry-run keeps only today's session.

Dry-run executed (BEGIN … ROLLBACK, Supabase MCP, 2026-09-25):

```
live_before_dryrun: 4
live_after_dryrun:  1
sole_surviving_session: sess-d4b37d6f-b84e-4b1f-8709-51d6d6e262bb
distinct_push_tokens: 1
post-ROLLBACK live count: 4  (prod untouched)
```

(The `sole_surviving_session` scalar subquery doubles as an assert — it would
error if more than one row survived.)

**COMMIT version — Ziad runs this himself, exact ids pinned, no ranking:**

```sql
UPDATE user_sessions
   SET revoked_at = NOW()
 WHERE id IN ('sess-legacy-d1d04fb8-cc53-4928-b412-60f763546d09',
              'sess-66a0394d-eecb-4109-90e7-c75111d79cce',
              'sess-55d6a0eb-09be-453f-b752-5f50a711691a')
   AND revoked_at IS NULL;
```

Caveats before running: (a) if the phone's CURRENT app install is still
refreshing on one of the three older tokens rather than today's row, that
device gets logged out at its next refresh (≤12 h) — one re-login fixes it;
(b) sign in again after running it and the count grows again until the app
calls B7's logout — the row hygiene is the app leg's job from then on.

---

## 4. Tests

New:

- `tests/admin/admin_verify_claim.test.js` — service suite on a REAL local
  Postgres (12 tests): happy (claim's method/reference become the payment
  facts, both audits, `resolved_by`), body overrides, `paid_at` COALESCE,
  idempotent replay writes nothing, all five rejections each asserting the
  order stays unpaid + claim undisturbed, **B4 atomicity by fault injection on
  EACH audit insert** (order stays unpaid, claim stays pending, zero audit
  rows; the retry after the fault is clean and complete), and the
  `issueRefund` PRACTICE_CASE guard (no refund row).
- `tests/admin/admin_payment_claim_actions.test.js` — hermetic route suite
  (25 tests): gates, body validation, post-commit orchestration order (one
  test drives the REAL service over a fake txn client and pins COMMIT →
  markCasePaid ordering), `routed:false` + critical alert on non-benign
  markCasePaid failure, benign re-entry, replay fires nothing, every error
  mapping, reject calls THE SAME `rejectClaim` with the claim's own order id,
  reject race resolution (replay vs 409), logout (sid / no-sid / idempotent /
  store-failure / role gate), B3 additive fields + practice predicate in the
  SQL, B5 409s on all four inline write routes (ROLLBACK + zero writes
  asserted), B6 detail + batched list caps, and two source pins
  (`countOpenCasesForDoctor`, bulk `practice_case` ordering).
- `tests/admin/admin_bulk_assign.test.js` — +1: a paid practice case with an
  eligible free doctor is skipped `practice_case`, writes nothing; the real
  case beside it still assigns.

Updated (they pinned the pre-fix behaviour):

- `tests/lint/admin-money-from-real-charge.test.js` — the two `maxRefundable`
  pins now demand the write-enforced remaining figure (and the batched
  derivation) instead of the bare ceiling that WAS slice-0 finding #10.
- `tests/core/refund-after-paid-partial.test.js` — the unsuitable-projection
  pin now includes `is_practice`.

Suite before/after on this Mac (worktree `~/tashkheesa-claims`):

| run | baseline (5435141a9) | after slice 1 |
|---|---|---|
| with local DB | 2726 / 37 / 11 | **2726 / 37 / 11 — failure set identical** (diff shows only two per-run fixture-id strings inside pre-existing failure messages) |
| without DB (`DATABASE_URL=`) | 2508 / 6 / 53 per the brief; this Mac's first run showed 11 (the 5 known `email-stub-mode` global-state flakes fired) | **2508 / 6 / 53 — exactly the brief's baseline**; the 6 are the same pre-existing lint failures |
| new node:test files (uncounted by run.js — P1-14) | — | **+38 ✔, 0 ✖** (12 + 25 + 1) |

`orders-table-readers-allowlist` still reports the same 3 pre-existing
unfiltered reads — every new `FROM orders` literal in this slice is filtered
or txn-locked with `deleted_at IS NULL`.

---

## 5. Found in review

1. **`ORDER_ALREADY_PAID` is a case the web never decided.** The web's
   idempotent early-return leaves a pending claim on a card-paid order pending
   forever (the queue hides it as moot). The Command endpoint refuses it
   loudly instead of silently confirming — confirming would record a second
   payment as verified when it is really a refund conversation. Deviation
   from the brief's error list; flagged under needs-Ziad.
2. **The web verify's audit trail never names the claim** —
   `confirmPendingClaimForOrder` writes no event and mark-paid's meta has no
   claim id. The Command verify's `order_events` meta carries `claim_id` +
   `via:'command_api_claim_verify'` (label kept VERBATIM
   `'Payment marked as paid (superadmin)'` so timeline consumers treat both
   surfaces as one action).
3. **Web reject leaves no per-claim 404/409 distinction** (`not_pending` for
   both); the Command reject pre-reads to answer 404 vs replay vs 409, and
   re-reads after a lost race so a reject-vs-reject race replays while a
   reject-vs-verify race 409s.
4. **`listClaims` practice filter also changes the web queue** (shared
   service) — deliberate: slice-0 doctrine for operator lists; prod currently
   has zero claims on practice orders so nothing visible changes today.
5. **Access tokens outlive logout by ≤15 min** (`requireJWT` never checks
   `user_sessions`) — pre-existing slice-0 note, unchanged by B7; the refresh
   token dies immediately.
6. **`supersedeBreachRefund` has no Command route** (unreachable from the
   app), so it did not get a practice guard; it also cannot fire on a practice
   case in practice (needs an existing `sla_breach` refund row).
7. **Reject on a claim whose order was soft-deleted is allowed** (web
   parity; bookkeeping, no money) — the LEFT JOIN keeps `is_practice` null →
   not treated as practice.
8. **The web mark-paid's schema-fallback minimal UPDATE was not carried over**
   into the atomic verify: a mid-transaction statement failure must abort the
   transaction, not degrade it; schema drift is a boot-blocking migration
   failure in this codebase anyway.

## 6. Deliberately not done

- No web-route changes for verify/reject (the web keeps its own working
  paths; the pinned mark-paid/reject regions are untouched).
- No amount field/guard invented for claims — the platform has no claimed
  amount; adding one is a product decision (patient-facing form change).
- No screenshot upload — same reason.
- Practice guards on **web** write paths (web mark-paid, web reassign, web
  order actions): out of the brief's list, and slice-0 left web writes as a
  policy question.
- `POST /push-token {token:null}` still nulls `users.push_token`
  unconditionally (slice-0 finding #2) — separate small fix, not in this
  brief.
- No app-side edits; `~/tashkheesa-command` was read only.
- No migrations. Prod: read-only SELECTs + one BEGIN…ROLLBACK dry-run via the
  Supabase MCP; nothing committed.

## 7. Needs Ziad

1. **B8 COMMIT go/no-go** (§3): three ids now, not two — confirm keeping only
   today's `sess-d4b37d6f…`, then run the COMMIT block yourself. Expect one
   possible re-login on the phone if its install is refreshing on an older
   row.
2. **`ORDER_ALREADY_PAID` semantics** (§5.1): agree the verify should refuse
   (409) a pending claim on an already-paid order rather than silently
   confirm. If you'd rather have it confirm-the-claim-only, say so and it's a
   ten-line change in the service.
3. **Merge + deploy go** for the branch; then the app leg (wire the queue's
   verify/reject buttons, `routed:false` handling, logout on sign-out,
   `deviceId` on login, cap refund sheets on the new `maxRefundable`).
4. **Web practice-write policy** (§6): should web mark-paid / reassign / order
   actions refuse `is_practice` too? Slice-0 needs-Ziad #2 asked the same for
   web; this slice answered it Command-side only.
5. Two hygiene follow-ups when convenient: the pending-claim-on-paid-order
   rows the queue hides (decide reject-them-in-bulk or leave), and slice-0
   finding #2 (`/push-token {token:null}` nulling the account-wide mirror).
