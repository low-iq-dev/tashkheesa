# Batch A2 — Adversarial Review

Commit under review: `345239d5c` — "fix(routing): broadcast, pool queue and the reassign
picker judge doctors by the same rule accept does (A2)", branch `fix/routing-eligibility-a2`.

Method: full diff read, surrounding source read (broadcast, auto_assign, _assign_helpers,
doctor_eligibility, doctor_case_access, doctor.js accept path, video.js, the templates the
redacted rows reach, migrations 001/010/016/033/045/069/086/089); every new SQL shape
**executed against a local scratch Postgres** with the repo's own helpers supplying the
fragments (so the SQL under test is the real text, not a paraphrase); module load order
executed both ways; the exposure test run standalone; the full suite run.

Suite state on this HEAD: `env DATABASE_URL= node tests/run.js` → **1926 passed / 6 failed /
52 skipped** — exactly the claim, the 6 are the known baseline set.

---

## Findings

### X1 — minor — the pool's read-error fallback fails OPEN for a doctor who turned Standard off

`src/routes/doctor.js:5202-5213` (`readDoctorSlaTiersRaw`) returns `null` when the users
read throws, and `allowedOrderTierValues(null)` is `['standard']`. The comment above it
claims "the pool under-shows rather than inviting a doctor to a case the gates will
refuse." That is true only for doctors whose switches include Standard.

Concrete failure: a doctor with `sla_tiers_supported = ["vip","urgent"]` (Standard
deliberately off — a configuration the doctor app sells). The dashboard handler's
`readDoctorSlaTiersRaw` read hits a transient connection error; the pool query itself
succeeds. The pool now lists **standard** cases — tiers this doctor turned off — and
tapping accept bounces with `?msg=tier_not_supported` (Guardrail 3d reads the live row,
which is fine). That is the exact invite-then-refuse defect A2-2 exists to close,
resurfacing on the error path. NULL-column semantics (`standard-only`) are the right
default for a NULL *column*; they are the wrong default for a row that could not be
*read*. Fail-closed here is `[]` (empty pool for the request), not `['standard']`.

Severity minor: transient-error-only, no data exposure, self-heals on the next request.
But the comment's safety claim is wrong as written and should not be trusted by the next
editor.

### X2 — major (latent, pre-existing surface) — a fourth appointments side path is not covered, and A2-4's "all side paths" claim is false

A2-4 redacts three side paths (case-page `pendingVideoAppt`, `/portal/video/appointment/:id`,
`/portal/doctor/appointments`). There is a **fourth**: `GET /portal/video/appointments`,
doctor branch, `src/routes/video.js:2110-2215`. It selects `a.*, u.name AS other_name`
from appointments for `a.doctor_id = me` with **no acceptance check and no redaction of
any kind**, and the `mode:'list'` template (`src/views/video_appointment.ejs:54,87,110`)
renders `a.other_name` — the **patient's name** — on `pending_doctor` rows, i.e. exactly
the assigned-but-not-accepted state A4 established must not carry the patient. The row
payload also carries `slot_notes` (it is `a.*`).

Why this is not a live leak today, verified by reading the code:
1. The query interpolates `${joinCol}` and `${col}` (`video.js:2137-2138`) and **neither
   identifier is defined anywhere in the file** — the query builder throws a
   `ReferenceError`, the enclosing `try { … } catch (e) {}` swallows it, and
   `appointments` stays `[]`. The page always renders empty. (This also means the route
   is silently broken for patients.)
2. The whole load is additionally gated behind `isVideoEnabled()`.

So the leak is doubly inert — but it arms the moment anyone fixes the obviously broken
query (which looks like a five-minute fix to whoever next touches this route), and the
commit's claim that slot_notes is now "stripped at all three" side paths is an incomplete
sweep of precisely the class it names. Wants a follow-up ticket: either redact this branch
with the same `redactWithheldUntilAccept(redactPatientIdentity(a))` chain the board uses,
or delete the dead doctor branch and route doctors to `/portal/doctor/appointments`.

Not introduced by this commit; filed because the commit's stated coverage is what a
reviewer would otherwise rely on.

### X3 — note — broadcast's tier predicate is byte-sensitive where the JS gates are not

The jsonb `?|` operator compares raw key strings. `sla_tiers_supported = ["VIP"]` (or
`[" vip "]`): broadcast (`src/notify/broadcast.js:236`) and auto_assign never match it,
while `doctorSupportsTier` lowercases, so the pool arms **show** VIP cases and the accept
gate **allows** them — a doctor who sees and may take VIP work but is never notified of
it. Inherited verbatim from auto_assign (adopting that predicate is the point of A2-2),
and unreachable through the live writers (`validators/doctor_signup.js` allowlists
lowercase values; migration 086 normalised the column; 089 wrote lowercase). Recorded so
that the first non-lowercase writer knows what it breaks. No action needed in this batch.

### X4 — minor — cap = 0 / NULL semantics silently inverted in broadcast

Old broadcast: `load < COALESCE(cap, 5)` — a NULL cap defaulted to 5/8, and an explicit
**0 meant "never broadcast to this doctor"** (`load < 0` is always false). New broadcast:
`capFor` returns 0 for NULL/0/junk and `cap === 0 || load < cap` reads that as
**uncapped** — always broadcast. So any row where an operator zeroed `max_active_cases`
as an off-switch flips from silenced to unlimited fan-out.

Judged against the code and migrations rather than prod (per ground rules): both columns
were added with `DEFAULT 5` / `DEFAULT 8` (migrations 010 and 033), `ADD COLUMN … DEFAULT`
backfills existing rows, and **no application code writes either column** (grep: only
readers), so NULL/0 rows can exist only via manual SQL. The flip is also genuine parity —
the accept gate would let a 0-cap doctor accept, so the old broadcast was refusing to
invite someone accept permits. The commit message discloses the direction change. Flag to
Ziad only if anyone remembers zeroing a cap by hand; otherwise correct.

### X5 — clean/ordered — the load-count change broadens fan-out, in the accept gate's direction

Broadcast's load moved from `LOWER(status) NOT IN ('completed','cancelled')` to
`doctorLoadSql` (inclusion list + `completed_at IS NULL`). Statuses that stop counting
against the cap: refunded, cancelled-adjacent spellings, draft/DRAFT, pending_payment,
expired_unpaid, and any row with `completed_at` set under a non-terminal status. Effect:
a doctor previously (wrongly) at-cap can now be under-cap → **more** doctors invited,
never fewer for real work. This is exactly the number the accept gate enforces
(`countActiveCasesForDoctor` interpolates the same `doctorLoadSql`), so invite == accept
by construction. Defensible; no action.

### X6 — minor — the picker is now stricter than broadcast on three axes; stranding characterized

`findNextAvailableDoctor` → `eligibleDoctorsFor` differs from the broadcast pool:

| predicate            | broadcast                          | picker (eligibleDoctorsFor)          |
|----------------------|------------------------------------|--------------------------------------|
| specialty            | `specialty_id = $1` **OR** `doctor_specialties` EXISTS | `specialty_id = $1` only |
| pending_approval     | not checked (pre-existing hole)    | refused                              |
| is_available         | required                           | **not checked**                      |
| doctor_services      | not required                       | required **when order.service_id set** (+ onboarding) |

Consequences, concretely:
* A case with a `service_id` in a specialty whose doctors lack `doctor_services` rows, or
  a doctor whose specialty lives only in `doctor_specialties` (the 18-of-31 population
  migration 091 backfilled — the OR-clause exists in broadcast precisely because the next
  writer may forget the mirror): broadcast fans out to many, the overflow picker finds
  **nobody**, the accept bounces `?msg=capacity` and the case keeps its holder. That is
  the caller's documented else-branch (`doctor.js:3745-3746`), the brief's accepted
  no-target behavior, and strictly safer than the old picker's habit of handing cases to
  doctors every other gate refuses. But operators should know `?msg=capacity` will now
  fire in specialties where it never used to.
* The picker can still select an `is_available = false` doctor (the old picker had the
  same hole; broadcast excludes them). Not a regression — recorded as the remaining
  asymmetry between "who gets invited" and "who gets handed overflow".
* The picker is also stricter than the **accept gate itself** (accept requires neither
  onboarding_complete nor a doctor_services row): a doctor who could voluntarily accept
  the case will never be *picked*. Deliberate direction (routing is choosier than
  self-service), noted for completeness.

### X7 — minor (test quality) — the paused-doctors lint for doctor.js is satisfiable by a comment

`tests/lint/paused-doctors-excluded-everywhere.test.js:60-63` accepts
`/eligibleDoctorsFor\s*\(/` **anywhere in the file** for the doctor.js site
(`allowClause:false`). The comment at `src/routes/doctor.js:154` —
"auto_assign.eligibleDoctorsFor (account flags," — already matches that regex. Delete the
actual call from `findNextAvailableDoctor` and keep the comment, and this lint still
passes. The invariant survives only because `tests/lint/batch-a2-routing-pins.test.js:88`
independently requires `eligibleDoctorsFor({` **inside the brace-sliced function**. So the
system of tests holds, but the paused lint on its own proves nothing for this site;
tightening it to the sliced-function scope (the pins test already ships `sliceFunction`)
would restore its standalone meaning.

### X8 — note — capFor does not trim the tier, so a whitespace-damaged 'URGENT ' order caps on the wrong column

`capFor` (`doctor_eligibility.js:157`) tests `String(orderTier||'').toLowerCase() ===
'urgent'` with no trim, while `tierSpellings` trims. An order carrying `urgency_tier =
'URGENT '` (the exact historical corruption `determineTier`'s header documents) makes the
picker and accept gate select urgent-supporting doctors but cap them on
`max_active_cases` instead of `max_active_cases_urgent`. Pre-existing helper quirk, and
the picker, the accept gate and the view rule all pass the same raw string — so parity
(the batch's subject) holds; only the cap-column choice is off, on rows whose tier data
is already broken. Not this batch's defect.

---

## Attack angles that came up clean

* **Require cycles**: broadcast → auto_assign → {pg, notify, audit, logger}; broadcast →
  _assign_helpers → {acceptance_window (zero requires), doctor_eligibility (leaf)}. Nothing
  in those chains requires broadcast at module init (notify.js and case_lifecycle.js reach
  it only lazily, inside functions; superadmin.js:38 / admin.js:16 / api/admin.js:515 /
  case_sla_worker.js:839 are consumers, not participants). Executed both load orders
  (broadcast-first and superadmin-routes-first): `tierSpellings` and `doctorLoadSql` are
  concrete functions at call time in both.
* **SQL validity — proven by execution on Postgres, not by reasoning**: the unified
  broadcast query (verbatim clauses, `GROUP BY u.id` with `u.name/phone/notify_whatsapp/
  max_active_cases/max_active_cases_urgent` in the projection, the correlated
  `doctorLoadSql` subquery, `ORDER BY active_load`) runs; `users.id` is `TEXT PRIMARY KEY`
  (migration 001) so PK functional dependency legalises the ungrouped columns; duplicate
  `doctor_specialties` rows dedupe to one candidate row; ordering by load ASC confirmed.
* **`?| $2` binding**: node-pg string[] against `jsonb ?| text[]` works bare — and it is
  byte-identical to the auto_assign precedent (`?| $2`, no cast), so broadcast adopted the
  predicate exactly, cast and all.
* **`= ANY($n::text[])`** (pool arms) and **`id = ANY($1)`** (picker re-select, text ids,
  no cast) both execute correctly with JS array params.
* **orders columns**: `urgency_tier` (016) and `tier` (010) exist on `orders`, and
  `orders_active` is `SELECT *` re-expanded by migration 069 with a full-parity guard that
  aborts boot if any orders column is missing from the view — the pool predicate cannot
  hit a missing column.
* **orderTierSql ⇄ JS gate parity on the nasty edges**, confirmed on Postgres:
  `(urgency_tier=' ', tier='vip')` reads **'standard' on both sides** (SQL: `NULLIF(' ','')`
  keeps the space, TRIM then empties it, outer COALESCE lands 'standard'; JS: `' '` is
  truthy, `doctorSupportsTier` trims it to '' → 'standard'). `'URGENT '` normalises to
  urgent; `'fast_track'` legacy rows reach std+vip doctors; junk tiers hide from everyone
  who didn't opt into the same junk — matching accept in every case. The parity test's JS
  mirror of the SQL is faithful.
* **Signature changes contained**: the four pool functions and `findNextAvailableDoctor`
  have no callers outside `src/routes/doctor.js`; every internal call site passes the new
  argument in the right position (checked all 6).
* **Assigned arms**: the dashboard's assigned-pending arm and the queue's
  `doctor_id = me AND accepted_at empty` arm carry no tier clause, matching the view
  rule's conjunct-7 pool-only scope and Guardrail 3d — no double filtering, no
  assigned-case disappearance.
* **A2-4 template safety**: `portal_doctor_case.ejs` never references `pendingVideoAppt`
  or `slot_notes` (the case-page redaction is pure defense-in-depth);
  `video_appointment.ejs`'s detail mode renders only `id/status/price/order_id/
  scheduled_at(_formatted)/rescheduled_from(_formatted)/doctor_proposed_time_formatted/
  slot_notes` — every key except `slot_notes` survives the redaction, and the formatted
  fields are written **before** the clone (route order checked). The propose-slot form's
  `slot_notes` input was never prefilled, so nothing regresses there. The appointments
  board's derived flags (canJoin/canReschedule/…) are computed from `status`/
  `scheduled_at`, both survivors; `a.patient_email` / `a.patient_name` render as EJS
  empty-string on deleted keys with a 'Patient' fallback.
* **Post-accept**: the :id page and the board hand the untouched row to the accepted
  doctor and to the patient — `slot_notes` still reaches them.
* **`redactWithheldUntilAccept`** is a clone (original untouched — the pendingVideoAppt
  reassignment doesn't mutate a row anything else holds), and `redactPreAcceptOrderRow`
  is keep-list-based, so adding `slot_notes` to WITHHELD cannot subtract anything from
  orders payloads.
* **Exposure guard**: `tests/core/doctor-pre-accept-exposure.test.js` passes standalone
  (all sections incl. the appointments board and :id page assertions) and in-suite; the
  pendingVideoAppt change strips keys the leak filter would flag, it cannot add any.
* **Test harness**: both new files use `global._testRunner` and live under `tests/core` /
  `tests/lint`, which `tests/run.js` walks recursively — the +12 delta (1914 → 1926) is
  real, counted by the gating runner.
* **Pins test mechanics**: `sliceFunction`'s brace counter survives this function body
  (template literals are brace-balanced, no regex literals), and its banned-shape
  regexes don't false-positive on the explanatory comments (checked each).
* **Broadcast fan-out loop**: still consumes only `id/name/phone/notify_whatsapp`, all
  projected; `active_load` arrives as a bigint string and is `Number()`ed before the
  comparison; `tier` is `determineTier`'s normalized output, so the `tier === 'urgent'`
  uncapped branch and `tierSpellings(tier)` agree.
* **Urgent fan-out now tier-filtered** (a doctor with `["standard","vip"]` no longer gets
  urgent WhatsApps — verified on the scratch DB): this is a behavior change, but it is
  the ordered A2-2 change, and migration 089 put every active doctor on all three tiers,
  so the population it can shrink is doctors who deliberately switched urgent off —
  which is the feature working.

---

## Verdict

**SHIP.** No blockers. The one major (X2) is a latent, doubly-inert pre-existing surface
that contradicts the commit's "all side paths" claim rather than a defect this commit
introduces — it needs a follow-up ticket (redact or delete the dead
`/portal/video/appointments` doctor branch, and note its query has been silently broken
by undefined `joinCol`/`col` for both roles). X1's comment should be corrected — or the
fallback changed to `[]` — before anyone builds on its fail-closed claim; X7's lint
tightening is a five-line improvement. X3/X4/X8 are recorded asymmetries, not work.
