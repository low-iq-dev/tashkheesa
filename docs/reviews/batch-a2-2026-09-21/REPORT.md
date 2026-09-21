# Batch A2 — routing and eligibility: batch report for Ziad

Branch `fix/routing-eligibility-a2`, cut from origin/main after Batch A merged
(cf1f72616). Two commits: the implementation and the fix round. **Nothing
pushed, nothing merged** — per the ground rules this branch waits for your
approval.

Process: implementer → spec review (SPEC-REVIEW.md: all five items MEET SPEC,
no blockers/majors) → adversarial review (ADVERSARIAL-REVIEW.md: SHIP, no
blockers) → fix round (FIX-ROUND.md: every finding dispositioned).

## What changed

- **A2-1 (X4)** — broadcast's VIP capacity now comes from `capFor` (VIP caps
  on `max_active_cases`, like every other gate) over a `doctorLoadSql` load
  count. The local column-picking (VIP on the urgent column, private 5/8
  defaults, exclusion-list load) is deleted, and the two fan-out queries are
  one. Urgent fan-out is still uncapped — your question below.
- **A2-2 (X5)** — the doctor's tier switches now gate everything that shows
  or announces a pool case: broadcast carries auto_assign's exact predicate
  (`?| tierSpellings`, NULL = standard-only), and the four pool arms
  (dashboard build/count, queue build/count) filter on
  `orderTierSql = ANY(allowedOrderTierValues(...))` — both helpers are
  derivations of `doctorSupportsTier`, proven equivalent to the accept gate
  across the full doctor-config × order-tier matrix. Assigned-to-me rows are
  deliberately NOT filtered (same pool-only scope as Guardrail 3d and the
  view rule). The switches are read live per request.
- **A2-3 (X8)** — `findNextAvailableDoctor` is now `eligibleDoctorsFor`
  (account flags + specialty + tier + onboarding/doctor_services when the
  order has a service_id) + `capFor` + `countActiveCasesForDoctor`, keeping
  its oldest-account-first ordering. The literal cap of 4 and the hand-typed
  five-status load count are gone and banned by lint.
- **A2-4 (A4/S5)** — `appointments.slot_notes` (patient free text) joined
  `WITHHELD_UNTIL_ACCEPT` and is stripped pre-accept at three side paths:
  the case page's `pendingVideoAppt`, `/portal/video/appointment/:id` (which
  actually renders it), and the doctor appointments board. Scheduling facts
  (status, times) stay.
- **A2-5 (A6/S3)** — verified, per your keep-it-refused decision: the
  lifecycle allowlist refuses completed/cancelled/refunded, the operator
  gets the explicit "cannot be moved" banner (not a silent no-op), and both
  are now pinned by tests. Nothing was built; no override path exists.

## Tests

- Baseline before: **1914 passed / 6 failed / 52 skipped** (no-DB run).
- After: **1927 passed / 6 failed / 52 skipped** — the same six known
  baseline failures (env-vars, orders-readers allowlist, payment-wiring ×3,
  video-flag), zero new. +13: 12 new A2 checks (parity + source pins) and
  one from splitting the paused-doctors lint into function-scoped halves.
- SQL shapes additionally proven by execution on the local schema clone
  (EXPLAIN + value checks), and the adversarial reviewer independently
  executed every new query shape, both module load orders, and the
  whitespace/legacy/junk tier edges against a scratch Postgres.

## The eligibility matrix (the batch's subject)

Tier decision — one helper, four derivations, proven equivalent
exhaustively by tests/core/a2-eligibility-parity.test.js:

| doctor's switches → case tier ↓ | standard | vip (incl. legacy fast_track/priority rows) | urgent |
|---|---|---|---|
| NULL / unparseable (legacy row) | offered | refused | refused |
| ["standard"] | offered | refused | refused |
| ["standard","vip"] | offered | offered | refused |
| ["standard","vip","urgent"] | offered | offered | offered |
| ["vip","urgent"] (Standard off) | refused | offered | offered |
| ["priority"] (retired spelling) | refused | offered | refused |
| [] (everything off) | refused | refused | refused |

"Offered" now means the SAME answer from all four surfaces: broadcast
notifies ⇔ pool queue lists ⇔ picker selects ⇔ accept/view permit. Before
this batch, broadcast and the pool ignored the switches entirely.

Capacity — `capFor(doctor, tier)` (urgent → max_active_cases_urgent,
everything else → max_active_cases; 0/NULL = no cap) against the
`doctorLoadSql` load, identical at broadcast, picker and accept
(exhaustive load × cap × tier parity test). Exception: urgent broadcast is
uncapped (below). Account state (active/paused/pending/rejected) was already
unified in Batch A and is unchanged.

## Questions for you

1. **Uncapped urgent broadcast (X4's neighbour, explicitly left).** Urgent
   fan-out notifies every eligible doctor in the specialty regardless of
   load. FOR keeping it: a 4-hour case wants maximum reach, and accept still
   enforces the urgent cap, so an over-cap doctor who taps is bounced —
   invite-then-refuse survives on urgent alone. AGAINST: that bounce is the
   exact experience A2-1 just killed for VIP. Middle option if you want it:
   cap the urgent WhatsApp too, but on `max_active_cases_urgent` via the same
   capFor call — one-line change. Decide when convenient; nothing depends on
   it.
2. **Zeroed caps (X4).** Old broadcast read `max_active_cases = 0` as "never
   broadcast to this doctor"; capFor reads 0/NULL as "no cap" (that is what
   the accept gate already did, so the old broadcast refused people accept
   permits). No app code writes these columns and the migrations backfilled
   5/8, so only a hand-zeroed row flips behavior. If you ever zeroed a cap by
   hand as an off-switch, say so and we'll pick one semantic everywhere.

## Can A2-3 strand a case? (the brief asked)

Yes, by design, and the failure mode is a refusal rather than a bad handoff:
when the stricter picker finds no eligible target (no doctor supports the
tier / none under cap / service_id set but nobody has the doctor_services
row / the doctor's specialty lives only in doctor_specialties, which the
picker — unlike broadcast — does not consult), the accept bounces with
`?msg=capacity` and the case keeps its current holder; no state changes.
That is strictly safer than the old picker, which handed cases to doctors
every other gate refuses. Operational consequence to expect: `?msg=capacity`
can now fire in specialties where it never used to — if operators report a
spike, the picker/broadcast asymmetries in ADVERSARIAL-REVIEW.md X6 are the
map (the OR-fallback and doctor_services rows are the likely causes).

## Found beyond the brief

- **X2 — a FOURTH appointments side path, latent PII trap (follow-up ticket
  raised).** `GET /portal/video/appointments`' doctor branch selects the
  patient's name (`other_name`) and `slot_notes` with no acceptance gate,
  and its list template renders the name on assigned-not-accepted rows. It
  leaks nothing TODAY only because the query references two identifiers
  that don't exist (`joinCol`/`col` — ReferenceError swallowed by an empty
  catch, so the page renders empty for doctors AND patients) and the video
  kill-switch gates it. Any innocent fix to that query arms it. The right
  fix is its own small change (redact with the board's chain, or delete the
  dead branch and route doctors to /portal/doctor/appointments) — a task
  chip for it is queued.
- Broadcast's load count moving to doctorLoadSql can only BROADEN fan-out
  (refunded/draft/expired rows stop counting against caps) — in the accept
  gate's direction, by construction.
- Pre-existing helper edges now on the record (details in the reviews):
  jsonb scalar-string `?|`/JS mismatch (S2), `?|` byte-sensitivity to
  non-lowercase switch values (X3), capFor not trimming a corrupted
  `'URGENT '` tier (X8), the serviceId-NULL fallback skipping onboarding
  inside eligibleDoctorsFor (S4), and the superadmin reassign catch showing
  terminal-state copy for non-terminal errors (S9). All pre-date this batch;
  each is a one-place fix in a canonical helper if you want any of them.

## Status

Complete and reviewed; suite green against baseline. Waiting on your
approval — nothing pushed, nothing merged.
