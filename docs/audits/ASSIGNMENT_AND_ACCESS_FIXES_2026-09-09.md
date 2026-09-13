# Assignment & Access Fixes — Tashkheesa Portal — 2026-09-09

**Scope:** Part A (A1–A12) of the 2026-09-09 assignment-and-access brief — making
the launch operator workflow reliable (patient submits → pays by bank
transfer/InstaPay → admin mark-paid → broadcast/hand-assign → doctor accepts →
report) and keeping deactivated/reassigned users out.

**Baseline:** `main` @ `b6d6f89`, clean tree. Local Postgres is intentionally
unmigrated (migrations 043–045 unrun), so DB-integration tests skip; every guard
below is therefore **source-grep / pure-unit / mocked-DB** and runs in that same
environment. Evidence tier is **code-only (local-DB inferred)** throughout —
nothing here was verified against the production DB.

**House rules honoured:** full suite before and after; one commit per item; every
guard negative-tested (fix reverted → new test confirmed to fail → restored);
adversarial self-review of the diff; canonical status comparisons fold case; new
notification templates carry en + ar. Nothing pushed. No production writes.

---

## Suite counts

| | Passed | Failed | Skipped |
|---|---|---|---|
| Before (`b6d6f89`, clean) | 1296 | 6 | 52 |
| After (Part A committed) | 1388 | 6 | 52 |

The 6 failures are the pre-existing, separately-tracked baseline and **only**
these: `env-vars-validated-or-documented` (PRESCRIPTIONS_ENABLED),
`orders-table-readers-allowlist` (the same 3 reads — superadmin.js,
admin.js, addon_settlement.js), `payment-money-paths-wiring` ×3,
`theme9-video-flag-enforcement`. None were touched. The +92 passing tests are the
new guards.

---

## Items

### A1 — Hand-assigning from the manual queue must actually assign — DONE (`f132bd7`)

**Wrong.** `POST /superadmin/manual-queue/:id/approve` and `POST
/manual-queue/:id/approve`, when the operator picked a doctor, wrote
`orders.doctor_id` + `assignment_status='assigned'` and stopped. Status stayed
PAID, no `acceptance_deadline_at`, no `doctor_assignments` row, the doctor was
never notified. The row matched no worker (acceptance_watcher wants a non-NULL
deadline, fetchDoctorTimeouts wants an assignment row, the SLA sweep wants
IN_REVIEW) and never appeared in the doctor's queue — a paid case invisible to
everyone, in the exact workflow ops runs daily.

**Mechanism.** The api handler documented it: "picking a doctor here … does NOT
open a doctor_assignments row or start the acceptance handshake — this endpoint
only ROUTES."

**Changed.** New shared service `src/services/assign_case.js`:
`checkHandpickedDoctorEligibility` runs the same gate `POST /cases/:id/assign`
enforces (paid; doctor active, not paused, onboarding complete, specialty AND
service matched, under capacity — capacity/status from the shared
`routes/api/_assign_helpers`); `finalizeHandpickedAssignment` drives
`caseLifecycle.assignDoctor` (transition, acceptance window, doctor_assignments,
conversation, patient email) and queues the doctor's own notification, deduped
per doctor per case. Both handlers route the write through `effectiveDoctorId`
and finalize on an eligible pick; an ineligible pick is **not** a hard error —
the routing commits, the case falls back to `assignment_status='auto'` +
broadcast, and the operator is told which rule failed (web: a rendered banner on
the queue; API: 200 with `assignment:{ok:false,reason}`, never 500). A finalize
failure logs to error_logs + a `CASE_ROUTING_FAILED` event and returns the case
to the pool — guarded by `LOWER(status)='paid'` so a concurrent approve that DID
win is never undone.

**Guard.** `tests/core/manual-queue-assign-handshake.test.js` — unit-tests the
gate (one assertion per rule, incl. NULL is_active reads as active) and finalize
(assignDoctor called + doctor notification queued; a notify failure does not fail
a durable assignment), plus a structural check that both handlers route through
the service and fall back to 'auto'+broadcast. **Negative test:** removed the
is_paused gate and the assignDoctor call — each failed the matching assertion;
restored.

### A2 — A paid case must always have a durable path to a doctor — DONE (`9953242`)

**Wrong.** `markCasePaid` fires `broadcastOrderToSpecialty` fire-and-forget. If it
throws or the process restarts between the payment commit and the call, the case
sits PAID with `doctor_id IS NULL` and `acceptance_deadline_at IS NULL` — a shape
no worker scans for; auto_assign (the only other retry) is off at launch.

**Mechanism.** acceptance_watcher requires a non-NULL `acceptance_deadline_at`;
every other case_sla_worker fetcher wants IN_REVIEW/ASSIGNED.

**Changed.** A durable sweep in the 5-minute SLA tick. `fetchStrandedPaidCases`
selects `LOWER(status)='paid' AND doctor_id IS NULL AND acceptance_deadline_at IS
NULL AND assignment_status NOT IN ('manual_queue','manual_pending',
'manual_claimed')` older than 10 minutes; `handleStrandedPaidCase` re-runs the
broadcast, writes a `CASE_ROUTING_RETRIED` event each attempt, and after the
**second** failed retry raises an ops event through `pushOpsEvent` (persists to
the Activity feed), deduped per order. Idempotent: broadcast sets
`acceptance_deadline_at` under its own `doctor_id IS NULL` guard, so a placed case
drops out of the SELECT — that column is the "already broadcast" marker, which is
why re-running never double-broadcasts.

**Guard.** `tests/core/stranded-paid-case-rebroadcast.test.js` — unit-tests
`handleStrandedPaidCase` with injected deps (first failure re-broadcasts + logs
but stays quiet; second failure alerts ops once, deduped; a success counts as
placed and never alerts) + structural checks of the predicate and the tick
wiring. **Negative test:** relaxed `attempt >= 2` to `>= 1` — failed both the
"first failure stays quiet" unit assertion and the structural gate; restored.

### A3 — Broadcast must reach doctors by more than WhatsApp — DONE (`7bf743d`)

**Wrong.** `notify/broadcast.js` queued `channel:'whatsapp'` only, filtered on
`notify_whatsapp`. WhatsApp is not wired (OPENCLAW_* unset), so a new paid case
was announced to nobody; even once wired, 7 of 31 doctors have no
notify_whatsapp/phone.

**Changed.** Every eligible doctor is queued on email + the in-app bell via the
shared `queueMultiChannelNotification`; WhatsApp is sent **additionally**, per
doctor, to those who have it (keeping the tier-specific HSM templates). Same
dedupe key per doctor per case so the A2 retry can't double-send. Eligibility no
longer gates on notify_whatsapp/phone; it now also excludes paused (A5) and
onboarding-incomplete doctors. New `new_case_available` template registered
across every channel: bilingual title (notification_titles), bilingual bell body
(renderNotificationMessage — Egyptian register, phrased as an OPEN offer, not
"assigned to you"), `TEMPLATE_TO_EMAIL` mapping, and en + ar email hbs carrying
the doctor-queue deep link and the acceptance window.

**Guard.** `tests/core/broadcast-multichannel.test.js` — structural (excludes
paused/onboarding-incomplete, no notify_whatsapp/phone gate, internal+email via
the new template, WhatsApp kept per-doctor), registry (titled + mapped + both
hbs), behavioral (title interpolates; bell body renders distinct non-fallback
copy per language). **Negative test:** removed the is_paused filter and the
template — each failed the matching assertion; restored.

### A4 — Deactivated/rejected doctors must lose access now — DONE (`e7cacad`)

**Wrong.** `b6d6f89` gated login + refresh but left the 7-day cookie and
in-flight 15-minute access tokens untouched, so a doctor deactivated today kept
the full portal until their cookie died — up to a week. `is_paused` was checked
by no request path.

**Changed.** `users.tokens_valid_after` (migration 106, nullable, auto-applies on
boot). Any JWT whose `iat` predates the cut is refused. The cut is stamped
`NOW()` on every deactivate, reject, and password change across all six write
sites (superadmin deactivate + reject, admin_doctor_reject, api/auth,
routes/auth set+reset, api/profile) — **not** on pause. Enforcement goes through a
new per-instance, FAIL-OPEN cache `src/services/access_revocation.js` (same
60-second shape as the deleted_users tombstone). `requireJWT` and the
cookie-session `attachUser` both refuse a pre-cut token; the doctor `requireRole`
additionally blocks is_active=false/pending doctors per request via `login_gate`
(so pause stays non-blocking). The `iat` compare is **second-granularity**
(`iat < floor(cut/1000)`) — see Found in review.

**Guard.** `tests/core/session-revocation.test.js` — unit-tests the pure staleness
predicate (pre-cut stale; post-cut and same-second not; garbage fails open) +
structural (migration, three enforcement points, all six write sites carry the
cut, pause does NOT). **Negative test:** flipped the comparison and dropped a
write-site stamp — each failed the matching assertion; restored.

### A5 — Paused doctors excluded from broadcast and assignment everywhere — DONE (`066e5c4`)

**Wrong.** `broadcast.js` was the one assignment site not filtering `is_paused`
(fixed in the A3 commit). An audit of every other site — assign.js,
auto_assign.js, the shared `eligibleDoctorClause`, `buildAlternateDoctorQuery`,
`findNextAvailableDoctor`, `admin_bulk_assign` — found they all already filtered
it.

**Changed.** A cross-site regression lint pins the invariant at ALL of them so a
future edit can't silently drop it.

**Guard.** `tests/lint/paused-doctors-excluded-everywhere.test.js`. **Negative
test:** deleting the clause from `src/assign.js` fails its assertion.

### A6 — A reassigned doctor must lose the conversation — DONE (`07a5a10`)

**Wrong.** `reassignCase` never touched conversations, and `messaging.js` keyed
membership on `conversations.doctor_id` alone, so a reassigned (outgoing) doctor
kept reading new messages and downloading their attachments (the attachment
file_url rides in the message list) after the case moved.

**Changed.** Every membership read requires the doctor to be the case's CURRENT
`orders_active.doctor_id`: `getConversationForUser` (the gate behind message
view, poll, send, mark-read, attachment) joins orders_active; both sidebar list
queries and the total-unread counter carry the same predicate. No `/files/:id`
involvement (messaging attachments are reached through the message list this gate
protects).

**Guard.** `tests/core/reassigned-doctor-loses-conversation.test.js`. **Negative
test:** reverting the gate to the doctor-alone membership fails the gate
assertion.

### A7 — Accepting a case must be atomic — DONE (partial) (`cfd2d2e`)

**Wrong.** `assignDoctor` set `orders.doctor_id` through `transitionCase` with NO
predicate, so two doctors accepting the same PAID broadcast could both walk PAID
→ ASSIGNED and both fire `notifyCaseAssigned` — the patient got two "assigned to
Dr X" emails, the loser saw a bland bounce. The accept comment claimed a
"doctor_id != $5 check at line ~1895" guarded this; that check does not exist
(line 1895 is `deriveAlertSeverity`).

**Changed.** An optimistic claim in `assignDoctor`'s first-assignment path:
`UPDATE orders SET doctor_id = $1 WHERE id = $2 AND (doctor_id IS NULL OR
doctor_id = $1)`. A single guarded UPDATE is atomically serialized by Postgres,
so exactly one doctor's claim matches; the loser gets 0 rows and throws
`CASE_ALREADY_TAKEN` BEFORE any side effect — no wrapping txn, no deadlock. The
predicate deliberately also passes a hand-assign that pre-set doctor_id (A1) and
a same-doctor retry; and it's gated on `wasInitialAssignment`, so a REASSIGNED
hand-off is exempt. The accept handler turns `CASE_ALREADY_TAKEN` into a clear
bilingual "already taken" message (`?msg=already_taken`), not accept_failed.

**Guard.** `tests/core/accept-broadcast-race.test.js` — the guarded claim, the
0-row throw sits before the transition + email, REASSIGNED exempt, loser sees a
message not an error. **Negative test:** dropping the throw fails the assertion.
The three theme7 accept tests still pass.

See "Deliberately not done" for the txn-folding half.

### A8 — The three silent failures that lose money or access — DONE (partial) (`0c09263`)

**Wrong.** Each swallowed a failed write and redirected with a success code:
(a) additional-files approve (admin + superadmin) — a failed `uploads_locked=false`
leaves the patient permanently blocked and the SLA paused, yet "approved";
(b) refund mark-paid — the doctor-earnings clawback swallowed, so the refund is
paid but the doctor keeps 100%; (c) markCasePaid from the operator screen — the
case never entered assignment, yet `?payment=paid`.

**Changed.** Each sets a failure flag in the swallow and redirects with a code the
page RENDERS: (a) admin → `?files=unlock_failed` (through the existing FLASH_CODES
map, loop widened); superadmin → `?error=unlock_failed`; (b) →
`?flash=paid&error=clawback_failed` (a reconcile warning, not a rollback); (c) →
`?payment=paid_but_unrouted`. The superadmin order page had no error banner at
all — one was added, and the route passes the codes. Errors still land in
error_logs.

**Guard.** `tests/core/silent-failures-fail-loudly.test.js` — each of the four
sites sets a flag and guards its success redirect on it; the admin flash map/loop
carry the new code; the order page renders the honest codes. **Negative test:**
forcing the markCasePaid flag off fails the (c) assertion.

See "Deliberately not done" for the shared-helper + lint half.

### A9 — Paused SLA must not render as "Overdue" — DONE (`8137658`)

**Wrong.** `computeSla` had no `sla_paused_at` branch; pauseSla leaves a stale
past `deadline_at`, so every list view read it as a breach ("Overdue Nh") while
the doctor case page (its own pause check) showed it on hold.

**Changed.** `computeSla` carries the pause check itself, run BEFORE the deadline
branch: a case with `sla_paused_at` is isPaused, not isBreached, effectiveStatus
'paused', frozen remainder from `sla_remaining_seconds`. The 'paused'
pseudo-status gets a `CASE_STATUS_UI` entry so `getStatusUi` renders "Paused —
waiting for files" (per role, both languages).

**Guard.** `tests/core/sla-paused-not-overdue.test.js`. **Negative test:**
removing the pause branch makes the paused case read as breached again.

### A10 — Dashboard "Earnings this month" must agree with the earnings page — DONE (`4560f7c`)

**Wrong.** The tile summed `orders.doctor_fee` for completed cases — the full fee,
ignoring uplift share, add-ons and clawbacks — showing money the doctor won't be
paid (up to 5x reality), disagreeing with the earnings page.

**Changed.** The tile reads `earned_amount` from the SAME doctor_earnings +
addon_earnings source the earnings page uses, month by created_at, with the same
'Approved' (paid) / 'Not yet approved' (pending + reassigned) split. Arithmetic
not reimplemented — only aggregated. The sub-line shows that split in the earnings
page's exact wording; never "paid out" / "transferred".

**Guard.** `tests/core/dashboard-earnings-honest.test.js` (EJS comments stripped so
the warning-comment naming the banned words doesn't self-trip). **Negative test:**
reintroducing `SUM(doctor_fee) AS earnings_this_month` fails the assertion.

### A11 — Empty draft → wizard, not a 0 EGP pay page — ALREADY DONE (no commit)

Verified done by `8c01377`: drafts are intercepted at (1) `patient_cases.ejs`
(routes to `/patient/new-case?resume=`), (2) `GET /portal/patient/orders/:id`
(redirects to the wizard), and the pay page refuses an order without a resolved
price (`tests/core/pay-requires-payable-status.test.js`). No change made; noted
for completeness.

### A12 — Wizard dead ends, photo ownership, Arabic errors — DONE (partial) (`779809a`)

**(b) DONE.** `GET /portal/doctor/profile/photo/:id` had no ownership check — any
authenticated doctor could pull a signed URL for any other doctor's photo. Copied
the sibling signature route's `req.params.id !== req.user.id → 403` check.

**(a) DONE.** Wizard steps 4/5 redirect back with `?err=unsupported_currency` /
`submit_failed` but nothing built an error block, so the step bounced silently.
The view now maps those codes to the existing per-step error block, tied to the
right step, bilingually.

**Guard.** `tests/core/wizard-deadend-and-photo-ownership.test.js`. **Negative
test:** removing the photo ownership check fails its assertion.

**(c) NOT DONE** — see "Deliberately not done".

---

## Found in review (regressions caught in my own diff, before commit)

1. **A1 concurrent-approve reset could UNDO a won assignment.** The finalize-
   failure reset (doctor_id→NULL, assignment_status→'auto') would, in a rare
   two-operators-approve-the-same-case race, unwind an assignment another operator
   had just completed. Fixed by guarding the reset with `AND LOWER(status) =
   'paid'` — it only unwinds if the case is still in this handler's routing state,
   not already walked to ASSIGNED by the winner. (Also satisfies the fold-case
   lint.)

2. **A4 second-vs-millisecond `iat` bug.** JWT `iat` is whole seconds; my first
   cut of `isTokenStale` compared `iat*1000 < cut_ms`. A cookie re-issued in the
   SAME second a password reset stamps `tokens_valid_after` floors to just under
   the cut and would have been revoked ~60s later (when the cache picked it up) —
   i.e. a password reset would silently log the user out. Fixed to
   second-granularity `iat < floor(cut/1000)`, which keeps freshly-issued sessions
   valid and errs toward not locking anyone out. Locked in with a same-second
   test.

3. **A2 return-shape regression (caught by the suite, fixed pre-commit).** Adding
   `strandedRebroadcast` to `runCaseSlaSweep`'s return tripped
   `theme7-sla-breach-uses-canonical`, which pins the exact `{ preBreaches,
   breaches, timeouts }` shape. Reverted the return to exact; the stranded count
   is reported on the log line instead.

Read as an attacker and as a slow patient on 3G, the diffs also hold: the A2/A8
ops paths are all best-effort/fire-and-forget (never block a request), the A4
cache fails open (a DB blip cannot lock out the roster), and the A6 gate fails
closed only on the doctor side (a patient never loses their own history).

---

## Deliberately not done (in scope, consciously deferred — not half-done)

- **A7 — folding assignDoctor + the accept transition into ONE transaction.**
  `assignDoctor` takes its own pool connections, so a shared txn self-deadlocks
  (documented in the accept handler). Truly folding them needs a `client` threaded
  through assignDoctor and every helper it calls — a multi-caller refactor. The
  current split is already recoverable on retry, and the concrete harm
  (double-win + double-email) is closed by the optimistic claim. **Needs an eng
  decision** on whether the txn-fold is worth the blast radius.
- **A8 — the shared `flashError`/`flashSuccess` helper and the source-grep LINT**
  that would fail the build on any catch-then-success-redirect (with an audited
  allowlist). The prevention layer is a larger, allowlist-tuned change; the three
  concrete money/access leaks are fixed. Recommended as the next commit. Minor:
  the refund view renders the `clawback_failed` code as a raw `[clawback_failed]`
  slug (it satisfies "a code that renders", and the fuller sentence lives in the
  banner on the other three sites); a one-line friendly string for the refund
  queue is a cheap follow-up.
- **A12(c) — bilingual failure strings** (Forbidden, Forbidden (CSRF), File not
  found, PDF not available, Error loading report). Several sit inside the
  `/files/:id` authorization handler in server.js — a DO-NOT-TOUCH zone — and the
  rest are scattered across auth.js / middleware.js API responses. Left for a
  focused pass that can safely reach the patient-visible ones.
- **A6 — new-doctor message-history inheritance.** The security hole is closed
  either way. Whether the new doctor should INHERIT the patient's prior messages
  (swap the old conversation's doctor_id) or start a fresh thread is a product
  decision (see Needs Ziad).
- **A5 — collapsing every assignment site onto one shared predicate.** The sites
  use different matching models (broadcast/assign key on specialty; the shared
  clause keys on service_id); a single function would be a risky refactor with no
  safety upside now that the lint enforces the invariant.
- **Part B (the ~15 follow-on items)** — not started. Part B is explicitly the
  phase after Part A is committed and reported.

---

## Needs Ziad (product decisions or Render/DB changes)

1. **A4 migration 106 (`users.tokens_valid_after`) — confirmed deploy-safe, one
   consequence to know.** Ordering VERIFIED in code: `app.listen()` (server.js
   :1697) sits inside `_dbReady.then(...)` (:1415), and `_dbReady` is the IIFE
   that does `await migrate()` (:894) and `logFatal('refusing to start')` on
   failure — so the server does not serve a request until migrations have run,
   and a failed migrate refuses to boot. The advisory-lock fallback (db.js) still
   RUNS migrations unlocked (loudly) on lock contention; it does not skip them, so
   `ADD COLUMN IF NOT EXISTS` applies either way. Net: a normal Render deploy
   applies 106 before the first request with no manual step. **The consequence if
   it were ever absent** (boot migration disabled, or someone deploys the code to
   a service that skips migrate): the six write sites do `UPDATE users SET …
   tokens_valid_after = NOW()`, which throws 42703, so **password reset,
   deactivate and reject all 500**. The read path fails open; the write path does
   not. So the one thing to confirm post-deploy is simply that boot migration ran
   (the column exists) — after that, nothing.
2. **A4 self-service password change ends the current session too.** Setting
   `tokens_valid_after` on every password write is per the brief and is
   security-positive (a password change ends old sessions), but the mobile
   `POST /api/v1/.../password` (api/profile.js) does not re-issue tokens, so a user
   who changes their own password is logged out on their next call and must
   re-authenticate. **Confirm this is the intended UX**, or a follow-up should
   re-mint tokens for the current device after a self-service change. (The web
   set/reset flows re-issue a cookie after the write — second-granularity keeps
   that fresh cookie valid.)
3. **A6 conversation lifecycle on reassignment** — should the new doctor inherit
   the patient's prior message history (swap doctor_id) or start a fresh thread?
   Current behaviour: fresh thread; the old conversation becomes patient-only
   history and the outgoing doctor is locked out.
4. **A7 txn-fold** — eng decision on the accept-atomicity refactor (above).
5. **A3 email deep link** target — the "new case available" email links to
   `/portal/doctor/dashboard` (the doctor queue). Confirm that is the intended
   landing page (vs. a filtered `/portal/doctor/cases`).

---

## Needs a staging smoke pass (shape-verified ≠ behaviour-verified)

The local DB is unmigrated, so **none of this was executed end-to-end** — every
guard verifies code *shape* (source-grep / pure-unit / mocked-DB), not runtime
integration against a real schema. That is a deliberate, baseline-preserving
choice, but these paths deserve one live run on staging before launch, in
priority order:

1. **A4 — password reset must still SUCCEED** (most likely to be silently broken
   if 106 is missing or the `iat` compare is off): reset a password, then confirm
   the fresh session works AND the pre-reset token is refused. Then deactivate a
   doctor and confirm the next portal request is refused within ~60s; pause one
   and confirm it is NOT.
2. **A1 — hand-assign opens the handshake**: approve a manual-queue case with an
   eligible doctor → assert `doctor_assignments` row + `acceptance_deadline_at` +
   the doctor notification; approve with an ineligible doctor → assert fallback to
   `'auto'` + a broadcast, and the named-reason message.
3. **A3 — email/bell rows actually queue** for every eligible doctor on a new paid
   case (and WhatsApp only for those with it).

These are exactly the flows the unit/mocked guards cannot confirm integrate
correctly against the production schema.

---

## Commits (oldest first)

```
f132bd7 fix(manual-queue): a hand-assigned doctor never got the case                       [A1]
9953242 fix(routing): a paid case whose broadcast failed had no way to reach a doctor       [A2]
7bf743d fix(broadcast): a new paid case was announced to nobody                             [A3]
e7cacad fix(auth): a deactivated doctor kept the portal until their cookie expired          [A4]
066e5c4 test(assignment): pin "paused doctors excluded everywhere" across all sites         [A5]
07a5a10 fix(messaging): a reassigned doctor kept reading the patient's messages             [A6]
cfd2d2e fix(accept): two doctors could accept the same broadcast and both "win"             [A7]
8137658 fix(sla): a paused case showed "Overdue" in every list view                         [A9]
4560f7c fix(doctor dashboard): "Earnings this month" showed fees that won't be paid         [A10]
0c09263 fix(ops): three operator actions reported success after a failed write              [A8]
779809a fix(patient+doctor): a doctor photo leak and two silent wizard dead ends            [A12]
```

(A11 required no commit — already fixed in `8c01377`. A5 is test-only; its
functional half shipped with A3.)

---

## Part B

**Date:** 2026-09-13. **Baseline:** `main` @ `4ba9042` (Part A committed and
deployed), clean tree apart from an untracked `Claude outputs/` folder (left
alone). Same rules as Part A: full suite before and after; one commit per
item; every guard negative-tested (fix reverted → new test fails → restored);
adversarial self-review; canonical status comparisons fold case; new copy in
both languages. Nothing pushed. No production writes — production was read
(SELECT only, via the Supabase connector) to verify four shapes: no stored
http(s) file URL exists in `order_files.url`, `messages.file_url` or
`order_additional_files.file_url`; `orders.payment_status` is lowercase
`paid`/`unpaid`/`refunded` (38 of 41 orders unpaid); user `superadmin-1` does
not exist; `uniq_refunds_open_per_order` is live. The local DB is still
unmigrated, so every guard is source-grep / pure-unit / injected-deps and the
evidence tier remains **code-only (local-DB inferred)**.

### Suite counts

| | Passed | Failed | Skipped |
|---|---|---|---|
| Before (`4ba9042`, clean) | 1388 | 6 | 52 |
| After (Part B committed) | 1469 | 6 | 52 |

The 6 failures are the same baseline six and only those:
`env-vars-validated-or-documented` (1 var), `orders-table-readers-allowlist`
(the same 3 reads — superadmin.js:5071, admin.js:2079,
addon_settlement.js:234), `payment-money-paths-wiring` ×3,
`theme9-video-flag-enforcement`. None touched. The +81 passing tests are the
new guards (node:test files report asynchronously and are tallied by the
runner).

### Items

#### B1 — Patient push notifications — VERIFIED + one gap fixed (`585bbab`)

**Already in the tree** (d5f15a0, 2026-08-25; verified, not redone):
`pushForNotification` hooks `queueNotification`'s `internal` path on both the
insert and the re-arm branch; `GET /api/v1/notifications` filters
`channel='internal'` and no longer deletes `template`; the SLA and
payment-reminder dispatchers queue an `internal` row; all six pushes that
matter (report ready, payment confirmed — gateway + operator mark-paid, doctor
accepted, new message, more files requested, refund approved/denied/paid) are
in `PUSH_TEMPLATES`.

**Wrong.** The mobile message POST (`routes/api/conversations.js`) notified the
doctor with a raw `INSERT INTO notifications` — no channel, no template, no
dedupe key — so the row had `channel NULL` and matched no channel-filtered
reader, and nothing emailed the doctor. It also imported
`middleware/push.notifyNewMessage` and never called it.

**Changed.** Routed through the same `queueMultiChannelNotification` call
`routes/messaging.js` uses for the web send (template `new_message`, internal
+ email, the same 10-minute per-conversation dedupe key, `conversation_id` in
the payload); dead import removed.

**Guard.** `tests/core/mobile-message-notifies-doctor.test.js`. **Negative:**
restored the raw INSERT and the import — 4 assertions failed; restored, pass.

#### B2 — File-attach ownership + stored open redirect — DONE (`428ead0`)

**Wrong.** `POST /api/v1/cases` (`fileId`), the portal order upload
(`file_key`) and the message attach (`file_key`) checked only the SHAPE of an
R2 key, never that its `<patient id>` segment was the caller — naming another
patient's key attached their file to the caller's case. `uploadcareUuid` was
any string. Separately, `patient.js` accepted any `https?://` string as a
file URL (order upload, message attach, the two legacy wizard submits) and
`server.js /files/:id` 302'd to whatever was stored: a stored open redirect
on our domain, reachable by any patient.

**Changed.** The one-line owner check from `cases_draft.js` on all three
key paths; `uploadcareUuid` pinned to a UUID (ownership of a public CDN uuid
cannot be proven). New `services/file_url_allowlist.js` — https only, no
credentials in the authority, host ∈ {`ucarecdn.com`, the `R2_ENDPOINT`
host, `*.r2.dev`, `*.r2.cloudflarestorage.com`} — applied at every writer and
again at the sink (404 + log). Production holds no http(s) file URL today,
so the strict list breaks nothing.

**Guard.** `tests/core/file-attach-ownership-and-redirect.test.js` — unit
(accepts our hosts; refuses foreign hosts, http, `https://ucarecdn.com@evil/`,
lookalike domains) + pins on each writer and the sink. **Negative:** reverted
the four source files — 8 assertions failed; restored, pass. The five
theme13 file-path tests still pass.

#### B3 — The rest of the silent-failure family + the A8 lint — DONE (`7e1f394`)

**Wrong / changed** (each now carries a code the page renders; ops-facing
failures land in `case_events` under a `_FAILED` label the
`/ops/silent-failures` view lists):

- (a) manual SLA sweep — a failed sweep redirected `?sla_ran=1`, and nothing
  rendered either code → `?error=sla_sweep_failed`; `superadmin.ejs` renders
  both outcomes, bilingual.
- (b) new files uploaded — the doctor notification was fire-and-forget; a
  doctor never told left the case parked in REJECTED_FILES with a paused
  clock. The queue result is read; when neither the queue nor the direct
  email lands: `DOCTOR_FILES_NOTIFY_FAILED` case event + error_logs. The
  patient still sees `uploaded=1` — the upload is durable.
- (c) turnaround-save — the failure rode `?success=` into the GREEN card →
  `?error=turnaround_save_failed`, rendered in the error card.
- (d) reject-files — a failed status write or a failed SLA pause bounced with
  no code → `reject_files_failed` / `reject_files_sla_pause_failed` in
  `REPORT_SUBMIT_ERRORS` (en + ar).
- (e) refund opened / approved / denied — the patient notification sat
  unawaited in a swallowing catch, then `?flash=<ok>` → result read; a total
  failure is `REFUND_PATIENT_NOTIFY_FAILED` + error_logs and the queue page
  shows "saved, but the patient could NOT be notified".

**The lint** (`tests/lint/no-success-redirect-after-catch.test.js`, deferred
from A8): fails the build on (1) a success redirect inside a `catch`, and (2)
a swallowing catch followed within four lines by a success redirect with no
other `await` between them; promise `.catch(fn)` is not a catch block; a
`silent-failure-ok: <why>` comment within three lines exempts a site. Run
against the tree it flagged exactly the five sites above plus one legitimate
site (doctor profile update: the UPDATE committed; the swallow is the cookie
re-sign) — audited and allowlisted with the reason. Five self-test fixtures
pin the lint's own behaviour.

**Guard.** `tests/core/silent-failures-part-b.test.js` + the lint.
**Negative:** reverted all six source files — 11 assertions failed and the
lint reported the sites; restored, pass.

#### B4 — Add-on commissions on refund — DONE (`e8ffa49`)

**Wrong.** `video_consult.onRefund` / `prescription.onRefund` had zero
callers; a fully refunded case left its unfulfilled add-ons at `paid`, so a
doctor could fulfil one later and `onComplete` would pay commission on money
already returned.

**Changed.** `refund_closure.closeOrderIfFullyRefunded` runs
`refundUnfulfilledAddons` after the close UPDATE commits: every `paid`
order_addons row is flipped through its registry class's `onRefund`
(+ `ADDON_REFUNDED` event); a `fulfilled` add-on is kept — the doctor did the
work, the same rule `refund_eligibility` applies to a consumed video. Partial
refunds never reach it. Non-throwing; failures are `ADDON_REFUND_FAILED` +
error_logs. `earnings_writer.js` untouched.

**Guard.** `tests/core/refund-closure-refunds-addons.test.js` (injected deps
+ structural). **Negative:** reverted `refund_closure.js` — 6 failed;
restored, pass.

#### B5 — WhatsApp failure detector counted nothing — DONE (`a532bdc`)

**Wrong.** `NOT ((context::jsonb)->>'alertKey' = 'whatsapp_401_detected')` is
NULL for every row without an `alertKey` — every real send failure — so the
detector dropped exactly the rows it existed for.

**Changed.** `COALESCE((context::jsonb)->>'alertKey', '') <> '…'`.

**Guard.** `tests/core/theme9-whatsapp-health-cron.test.js` now requires the
NULL-safe form and rejects the bare `NOT (->> = …)`. **Negative:** reverted —
1 failed; restored, pass.

#### B6 — Acceptance-timeout admin alerts to a phantom user — DONE (`6c21bed`)

**Wrong.** `workers/acceptance_watcher.js` queued the alert to user id
`superadmin-1` (absent from production).

**Changed.** `notifyAdmins` (a bell row per active superadmin, same template
+ dedupe key) and `pushOpsEvent` (`acceptance_timeout_auto_assigned`, deduped
per case; persists to the Activity feed). Both awaited in their own
try/catch, logged on failure. No live `superadmin-1` reference remains in
`src/`.

**Guard.** `tests/core/acceptance-timeout-alert-reaches-admins.test.js`
(repo-wide grep + both sends). **Negative:** restored the old call — 4
failed; restored, pass.

#### B7 — Revenue reports counted uncollected money — DONE (`5f39539`)

**Wrong.** The owner cockpit's Finance tab (`superadmin_dashboard.js`: revenue
today/MTD, gross profit, average order, by country, by specialty, per doctor,
per referral code) and the orders CSV (`exports.js`) summed `orders.price`
with no payment filter; the Command app filters `payment_status IN
('paid','captured')`, so the two disagreed.

**Changed.** One `COLLECTED` predicate (`LOWER(COALESCE(payment_status,''))
IN ('paid','captured')`) inside every price aggregate on the tab — case
counts on the same tab unchanged. The CSV gains `payment_status` and
`collected_price`; `gp` is 0 on an uncollected order; `price` stays the list
price.

**Guard.** `tests/core/revenue-counts-collected-money-only.test.js`.
**Negative:** reverted both files — 3 failed; restored, pass.

#### B8 — A paid partial refund locked out the remainder — DONE (`309c22b`)

**Wrong.** Migration 083 let a PAID refund row hold the one-refund-per-order
slot forever. After a paid partial (SLA-breach uplift, goodwill) no second row
could be created on any of the six create paths.

**Changed.** Two invariants replace the one. Migration 107 recreates
`uniq_refunds_open_per_order` over OPEN statuses only
(`pending`/`auto_approved`/`approved`), with 083's pre-/post-flight shape;
every create path's blocking query and `admin_refund.BLOCKING_REFUND_STATUSES`
drop `paid`. New `refund_eligibility.remainingRefundableEgp(order)` =
`maxRefundableEgp` minus refunds already PAID (same COALESCE chain as
mark-paid/closure) is the ceiling and the pre-filled default at every create
path (patient request, superadmin form, superadmin cancel-with-refund,
Command-app cancel — capped, opens nothing at 0 — `admin_refund` create +
supersede, `sla_breach`), and `isEligibleForRefund` refuses a case with
nothing left (`already_refunded_in_full`), failing closed on a DB error. An
order with no establishable charge keeps its status verdict (the POST refuses
it as `amount_unavailable`, as before). Also fixed: patient.js's duplicate-race
regex matched the dropped index name.

**Guard.** `tests/core/refund-after-paid-partial.test.js` (unit with injected
exec + structural pins incl. a repo-wide check that the four-status list is
gone from `src/*.js`); `theme7b-eligibility-helper` injects "nothing paid
back yet". **Negative:** reverted `refund_eligibility.js` +
`admin_refund.js` — 10 failed; restored, pass. All refund neighbours (theme7b
×5, admin refund ×2, closure, KPI parity, money lints) pass.

#### B9 — Webhook amount gate never checked currency — DONE (`c800d86`)

One clause: `paidCurrency !== owedCurrency` (order default EGP; a missing
txn currency is a mismatch), both currencies recorded on the
`amount_mismatch` payment_event and order event. `owedCentsForOrder`
untouched. **Guard:** `tests/core/webhook-amount-gate-checks-currency.test.js`
(source pin; the webhook integration test needs a DB). **Negative:** dropped
the clause — 1 failed; restored, pass.

#### B10 — SLA reminders overstated remaining time — DONE (`f415bbc`)

**Wrong.** The tightest of 24h/6h/1h the remaining time was under, regardless
of the order's SLA: an urgent 4h case was told "about 6 hours" on its first
sweep; VIP 18h "about 24".

**Changed.** Pure `pickSlaReminderLevel(seconds, slaHours)`: keeps the
one-tightest-window rule, adds "only a window strictly shorter than the
order's SLA". 4h → only 1h; 18h → 6h + 1h; 48h/72h → all three; no
`sla_hours` → unchanged. Status→TTL table untouched.

**Guard.** `tests/core/sla-reminder-level-honours-sla-hours.test.js`.
**Negative:** reverted the dispatcher — 8 failed; restored, pass.

#### B11 — Six Arabic email templates dropped fields — DONE (`b5761e1`)

Diffed en vs ar field by field: `case-assigned` (urgency), `case-reassigned`
(previousDoctor), `payment-success` (paymentMethod), `sla-warning` and
`appointment-reminder` (specialty), `appointment-scheduled` (caseReference).
Rows added in the same position/style with Arabic labels; render-checked
with Handlebars. The parity lint now covers every en/ar pair (39 more), with
underscore layout partials excluded (the Arabic layout hardcodes
lang/dir/title by design). **Negative:** reverted two ar templates — 2 of 82
failed; restored, 82/82.

#### B12 — Pooler-mode session settings / advisory lock / pg-boss max — VERIFIED (`02d4ccf`, test only)

All three already fixed (AUDIT-2026-08-22): `pg.js` does NOT send startup
`options` by default (Supavisor consumes that parameter; the guarantee is
`ALTER ROLE … SET`, documented in render.yaml, with `PG_STARTUP_OPTIONS` as
an explicit opt-in); `worker_watchdog.js` uses `pg_try_advisory_xact_lock`
inside BEGIN/COMMIT on a pinned client; `job_queue.js` constructs pg-boss with
`max = PG_BOSS_POOL_MAX`. Pinned by
`tests/lint/pooler-safe-session-and-locks.test.js`. **Negative:** made
`_withStartupOptions` send options by default — 1 failed; restored, pass.

### Found in review (caught in my own diff before the relevant commit)

1. **B3 lint misread promise `.catch(fn)` as a catch block.** It flagged the
   doctor photo/signature *remove* handlers, whose only "catch" is
   `.deleteFile(k).catch(fn)`. Fixed with a `(?<!\.)` lookbehind, so those
   never needed an allowlist entry.
2. **B3 lint never saw a one-line `catch (_) { /* best-effort */ }`.** That
   is exactly the shape of the three refund sites — the very bugs the lint
   exists for would have passed. Fixed: a one-line catch is a swallow unless
   it returns/throws on that line.
3. **B3 lint false-positive on "swallow, then a later write, then success".**
   The photo *upload* handlers do a best-effort cleanup (swallowed), then the
   real UPDATE, then redirect. Rule (2) now requires no `await` between the
   swallow and the redirect — the redirect reports the later write, which
   throws into the outer catch.
4. **B3 (a) first cut used `?sla_error=1`**, outside the repo's `?error=`
   convention — the new lint itself flagged it. Now `?error=sla_sweep_failed`.
5. **B8 first cut of `isEligibleForRefund` reported `already_refunded_in_full`
   for an order with NO recorded charge** (ceiling 0 ⇒ remaining 0). Caught by
   the existing theme7b policy table (five cases went ineligible). Narrowed:
   the remaining-amount verdict applies only when a charge is establishable;
   a no-charge order keeps its status verdict and is refused downstream as
   `amount_unavailable` with a reconciliation log — the honest outcome.
6. **B2 allowlist vs. authority tricks.** `https://ucarecdn.com@evil.example/`
   parses with host `evil.example`; `https://ucarecdn.com.evil.example/` is a
   lookalike. Both are refused (credentials-in-authority is refused outright;
   host match is exact or a Cloudflare suffix) and pinned by the unit test.

Read as an attacker and as a slow patient on 3G: every new await on a
request path is a single indexed query (the refund remainder, the queue
result); every ops-side write is best-effort and non-throwing; the B2
allowlist fails closed at the sink for rows written before the writer-side
check; B8's narrowed index still serialises concurrent creates (one gets the
handled 23505); B9 fails closed into manual review, never into "paid".

One anomaly to record: mid-session `git status` showed a two-line
uncommitted change to `scripts/seed_demo_doctor.js` (demo email →
`demo.local`) that no step of mine made and no test writes; it was restored
with `git checkout` and did not recur after the final suite run. Worth a
glance at whatever else runs on this Mac mini.

### Deliberately not done

- **A12(c) bilingual failure strings** — still deferred from Part A (not in
  Part B's scope). The new B2 sink refusal reuses the sibling English
  `File not found` string for consistency until that pass happens.
- **A8 `flashError`/`flashSuccess` helper** — the lint is the guard; a helper
  would have touched ~40 redirect sites for no safety gain.
- **B1 dead helpers** — `middleware/push.notifyCaseUpdate` /
  `notifyPaymentConfirmed` remain as uncalled English-copy functions; the
  `notify.js` hook supersedes them. Removing them is cleanup, not a fix.
- **B2 `uploadcareUuid` ownership** — a public CDN uuid cannot be tied to an
  uploader; shape-validated only. The legacy mobile path is the only writer.
- **B4 fulfilled add-ons on a fully refunded case** keep their
  `addon_earnings` row (the doctor did the work). `order_addons.refund_pending`
  has no reader; the money moves via the case refund itself.
- **B7 Command-app display fields** `maxRefundable` (api/admin.js refund and
  case lists) still show the raw ceiling, not the remaining; display only —
  every create path enforces the remaining.
- **B11 `_layout-doctor-welcome.hbs`** excluded from parity by design.

### Needs Ziad

1. **Migration 107** (`refunds` unique index narrowed to open statuses) runs
   at boot like 106; the only post-deploy check is that it applied
   (`SELECT indexdef FROM pg_indexes WHERE indexname='uniq_refunds_open_per_order'`
   should read `… WHERE status IN ('pending','auto_approved','approved')`).
2. **B7 will visibly LOWER the Finance tab's revenue figures** (38 of 41
   production orders are unpaid) — that is the honest number; and the orders
   CSV has two new columns (`payment_status`, `collected_price`) before `gp`,
   so any spreadsheet keyed on column positions needs updating.
3. **B10 cadence is a product call:** an urgent 4h case now gets only the 1h
   reminder; VIP 18h gets 6h + 1h. If you want an earlier nudge on urgent
   cases, add a tier-specific window (e.g. 2h) — the helper takes a list.
4. **B8 product behaviour:** after a paid partial refund, the patient's own
   "Request refund" button reappears for the remainder (auto-approve still
   applies pre-doctor-accept). Confirm that is intended, or gate the
   patient path to operator-only for second refunds.
5. **B9 fail-closed on currency:** if a live Paymob callback ever omits
   `currency`, every payment goes to manual review rather than "paid". Watch
   the first live transaction; the fixtures and Paymob's documented payload
   both carry it.
6. **B6 ops event kind** `acceptance_timeout_auto_assigned` uses the default
   15-minute cooldown per case and the default kind budget (5 per 15 min);
   tune in `services/ops_push.js` if it turns noisy.
7. **Staging smoke pass** (shape-verified ≠ behaviour-verified), in order:
   B8 — pay a partial refund, then open a second refund on the same case from
   the operator form and confirm the pre-filled amount is the remainder and a
   full second refund is refused; B3(e) — approve a refund for a patient with
   no email and no bell delivery and confirm the warning renders; B2 — attach
   a file key from another patient's folder and confirm the 400 / invalid_file;
   B1 — send a message from the app and confirm the doctor's bell + email.

### Commits (oldest first)

```
585bbab fix(notifications): a message sent from the patient app never reached the doctor properly   [B1]
428ead0 fix(files): a patient could attach another patient's upload, or store a redirect to any site  [B2]
7e1f394 fix(ops): five more actions told the user it worked after the write failed, and a lint …     [B3 + A8 lint]
e8ffa49 fix(refunds): a full refund left the case's add-ons fulfillable and payable                    [B4]
a532bdc fix(whatsapp): the delivery-failure detector counted nothing                                    [B5]
6c21bed fix(alerts): acceptance-timeout admin alerts went to a user that does not exist                [B6]
5f39539 fix(finance): the owner cockpit and the CSV export counted uncollected money as revenue        [B7]
c800d86 fix(payments): the webhook amount gate never checked the currency                              [B9]
f415bbc fix(sla): reminders told an urgent doctor "about 6 hours" on a 4-hour case                     [B10]
b5761e1 fix(email): six Arabic templates dropped a field the English ones carry                        [B11]
02d4ccf test(infra): pin the three pooler-safety fixes (startup options, xact lock, pg-boss max)       [B12]
309c22b fix(refunds): a paid partial refund locked the remainder out forever                           [B8]
```
