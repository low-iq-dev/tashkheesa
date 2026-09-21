# Batch A2 fix round — 2026-09-21

Disposition of every spec-review (S*) and adversarial-review (X*) finding.
FIXED = changed in the fix-round commit; DECLINED = deliberate, with the
rationale; REPORTED = real, out of this batch's scope, in the batch report
for Ziad.

## Fixed

- **X1 (minor)** — `readDoctorSlaTiersRaw` now distinguishes the two absences:
  a READ row with a NULL column still returns that NULL (standard-only, the
  column's own semantics), but a failed read / missing row returns `[]` —
  an EMPTY allowed set, so the pool under-shows to nothing for that request
  instead of listing Standard cases to a vip/urgent-only doctor whose gates
  would bounce them. The wrong fail-closed claim in the comment is rewritten
  to say exactly this.
- **S5 + X7 (minor)** — the paused-doctors lint's picker coverage is now
  FUNCTION-scoped, both halves: (1) `findNextAvailableDoctor` must actually
  call `eligibleDoctorsFor` inside its own body (the import line no longer
  satisfies it — X7's literal comment-match premise was wrong, the lint
  strips comments, but the import-line hole was real); (2) `eligibleDoctorsFor`
  itself must carry the `is_paused` predicate inside ITS body, closing S5's
  file-granularity hole (auto_assign.js's second is_paused occurrence in the
  manual-queue COUNT can no longer keep the lint green on its own). The dead
  `allowAutoAssign` flag was removed rather than left as an unused escape.
- **S6 (minor)** — the A2-5 pin now requires the redirect's template literal
  (`res.redirect(\`/superadmin/orders/${orderId}?error=reassign_failed\`)`),
  not any occurrence of the bare query string, so the explanatory comment at
  superadmin.js:5521 cannot satisfy it.
- **S3 (minor, documented rather than re-engineered)** — the parity test now
  carries the known TRIM divergence in writing: Postgres TRIM strips spaces
  only, JS .trim() strips all whitespace, so a tab-padded tier under-shows
  (pool hides, gate would take). The trailing-SPACE case — the corruption
  that actually happened historically — is in the matrix and agrees on both
  sides. If a tab-producing writer ever appears the fix is BTRIM in
  orderTierSql, and the comment says so. (Changing orderTierSql now would be
  writing new normalisation no gate performs — the brief's stop condition.)
- **S7 (note)** — the batch report referenced by the progress doc now exists
  (REPORT.md in this directory).

## Declined, with rationale

- **S2** — the jsonb scalar-string mismatch (`'"vip"'::jsonb`: SQL `?|`
  matches, the JS gate reads standard-only) is a PRE-EXISTING disagreement
  between auto_assign.js:79 and doctorSupportsTier, imported here verbatim
  because importing that predicate verbatim is what A2-2 ordered. No writer
  produces scalar jsonb (signup validator allowlists arrays; 086/089 wrote
  arrays). Fixing it means changing the canonical helpers themselves — one
  place, its own change, not a rider on this batch. REPORTED for backlog.
- **S4 / X6 (onboarding half)** — the picker inherits eligibleDoctorsFor's
  serviceId-NULL fallback (skips onboarding/doctor_services when the order
  carries no service_id). That is auto_assign's own documented semantics; the
  brief's shape rule forbids bolting an extra condition on top of the helper.
  If the fallback should close, it closes inside eligibleDoctorsFor, once.
  REPORTED.
- **X4** — capFor's 0/NULL = "no cap" direction replacing broadcast's old
  0 = "never broadcast" / NULL = 5/8 defaults is the point of A2-1 (one cap
  definition), was disclosed in the commit, and per the migrations (010/033
  DEFAULT 5/8 with backfill) plus a writer grep, a 0/NULL row exists only via
  manual SQL. REPORTED as a question for Ziad (did anyone ever zero a cap by
  hand as an off-switch?).
- **X8** — capFor not trimming the tier ('URGENT ' caps on the standard
  column): pre-existing helper quirk; all four surfaces pass the same raw
  string so PARITY — this batch's subject — holds. A capFor change is a
  canonical-helper change; REPORTED for backlog.
- **S9** — the superadmin catch being generic (a "case not found" throw gets
  the terminal-state banner copy): pre-existing, A2-5 was verify-and-pin
  only. REPORTED for backlog.

## Reported to Ziad (in REPORT.md)

- **X2 (major, latent)** — the FOURTH appointments side path:
  GET /portal/video/appointments' doctor branch selects the patient's name
  and slot_notes with no acceptance gate; inert today only because its query
  references undefined `${joinCol}`/`${col}` (ReferenceError swallowed by an
  empty catch — the page is silently broken for patients too) and the video
  kill-switch. Armed by any innocent fix to that query. Follow-up ticket
  raised (task chip): redact with the board's chain or delete the dead
  branch. NOT fixed here: the redaction needs an orders join the query
  doesn't have, which is building on a broken route, not reporting.
- **X6 (stranding half)** — the picker is stricter than broadcast
  (doctor_specialties OR-fallback, pending_approval, doctor_services); see
  REPORT.md for the operator-facing consequence (?msg=capacity in
  specialties where it never used to fire).
- **S1 / X5** — broadcast's load count now doctorLoadSql (fan-out can only
  broaden, toward accept-gate parity) and ordering rides the same count.
- **X3** — the `?|` predicate is byte-sensitive where the JS gates lowercase;
  unreachable via live writers; on record for the first non-lowercase writer.

Suite after the fix round: **1927 passed / 6 failed / 52 skipped** — the same
6 baseline failures, +1 passing check from the split lint.
