# Batch A2 — SPEC REVIEW (fix/routing-eligibility-a2 @ 345239d5c)

Reviewer scope: the HEAD diff against the Batch A2 brief, item by item. No source
was changed by this review. Test suite re-run independently:
`env DATABASE_URL= node tests/run.js` → **1926 passed / 6 failed / 52 skipped**,
and the 6 failures are exactly the recorded baseline set (env-vars-validated,
orders-table-readers-allowlist, payment-money-paths-wiring ×3,
theme9-video-flag-enforcement). The commit's test claim is accurate.

Standing-constraint sweep first: tiers (48/18/4) untouched; src/acceptance_window.js
untouched; the Batch A pre-accept visibility rule (doctorCaseAccess) untouched —
doctor_case_access.js changed only additively (slot_notes onto the existing
WITHHELD_UNTIL_ACCEPT list, plus one new function that consumes that list), which is
the mechanism the brief itself directed.

---

## A2-1 (X4) — broadcast capacity = capFor. Verdict: **MEETS SPEC**

- **Column-picking DELETED, not corrected:** yes. The `capColumn` /
  `defaultCap` ternary and the whole second query are gone from
  src/notify/broadcast.js; one query serves every tier
  (src/notify/broadcast.js:194–237), and capacity is applied in JS as
  `cap === 0 || Number(d.active_load) < cap` with `cap = capFor(d, tier)`
  (src/notify/broadcast.js:245–248). The pin test bans the old shapes
  (`capColumn`, `defaultCap`, the VIP→urgent-column ternary, `LOWER(o.status) NOT IN`).
- **Capacity now equals the accept gate's:** yes, both halves. The cap is capFor
  (src/services/doctor_eligibility.js:155–159), the same call the accept handler
  makes at src/routes/doctor.js:3696; the load is a `COUNT(*)` over
  `doctorLoadSql('o.')` (src/notify/broadcast.js:171–178 comment + query), the
  identical expression countActiveCasesForDoctor uses for the accept gate
  (src/routes/doctor.js:131–145). The accept side's `excludeOrderId` asymmetry is
  immaterial for broadcast: a broadcast case has `doctor_id NULL`, so the exclusion
  matches nothing. `invited ⇔ !acceptRefuses` is proven exhaustively by the parity
  test (tests/core/a2-eligibility-parity.test.js:117–139).
- **Urgent fan-out untouched:** yes — `if (tier === 'urgent') eligibleDoctors = candidates;`
  (src/notify/broadcast.js:242–243), explicitly flagged to Ziad in the comment,
  not decided. Compliant with the brief's "question for Ziad, not a decision".
- **The doctorLoadSql switch — shape or creep? Judged: within the brief's shape.**
  The old load was a hand-typed exclusion (`LOWER(status) NOT IN ('completed','cancelled')`);
  "broadcast calls capFor" is meaningless unless the load compared against that cap
  is the load the accept gate counts, and the brief's own question 1 phrases the
  target as "capFor + the same load count". doctorLoadSql is the existing canonical
  definition (routes/api/_assign_helpers.js:138–140, AUDIT-PREDICATE-PARITY), so this
  is pointing the caller at an existing helper, not writing a new condition.
- **S1 (note):** two real production-behavior deltas ride the unification, both
  inherent to adopting capFor and both disclosed in the commit message: (a) a
  doctor with NULL `max_active_cases` was previously capped at the private default
  5 (VIP: 8 on the wrong column) and is now uncapped in broadcast — which is what
  the accept gate already does, so parity is the point; (b) the notification
  ordering (least-loaded-first) now sorts by the doctorLoadSql count for all tiers,
  including urgent, where the old exclusion-list count ordered. Neither is a
  spec violation; both belong in the record.

## A2-2 (X5) — sla_tiers_supported on broadcast and the pool arms. Verdict: **MEETS SPEC**

- **Broadcast predicate matches auto_assign EXACTLY:** yes.
  src/notify/broadcast.js:233 `COALESCE(u.sla_tiers_supported, '["standard"]'::jsonb) ?| $2`
  with `$2 = tierSpellings(tier)` (line 194) is character-for-character
  src/auto_assign.js:79 modulo the `u.` alias, and the vocabulary is imported from
  auto_assign, not re-typed. The pin test pins the literal string.
- **Genuine reuse, not restatement:** yes. `allowedOrderTierValues`
  (src/services/doctor_eligibility.js:185–195) is literally
  `universe.filter((t) => doctorSupportsTier(slaTiers, t))` — the gate's own
  function decides every membership. `orderTierSql`
  (src/services/doctor_eligibility.js:197–200) is necessarily a parallel SQL
  spelling of the JS fallback (SQL cannot call JS), but it is pinned verbatim by
  the parity test and its equivalence to the gate's input expression
  `(order.urgency_tier || order.tier || 'standard')` (accept: doctor.js:3588;
  view rule: doctor_case_access.js:382) is proven across the full doctor-config ×
  order-tier matrix.
- **NULL = standard-only preserved everywhere:** yes — broadcast via the SQL
  COALESCE default, the pool arms via `allowedOrderTierValues(null) → ['standard']`
  (asserted directly by the test, including the `[]`-is-not-NULL distinction), the
  picker via eligibleDoctorsFor's own COALESCE.
- **Pool-only scoping:** correct. The tier clause appears in exactly the four pool
  arms (src/routes/doctor.js:5242, 5307, 5449, 5505), and in the two queue queries
  it sits inside the `doctor_id IS NULL` subquery only — the assigned-to-me arm is
  unfiltered, with the scope note citing Guardrail 3d / conjunct 7
  (src/routes/doctor.js:5427–5431). This matches the view rule's pool-only tier
  conjunct (doctor_case_access.js:362–383). A repo-wide grep found no fifth
  doctor-facing pool listing outside doctor.js.
- **Live reads:** yes. Both handlers call `readDoctorSlaTiersRaw(doctorId)`
  per-request (src/routes/doctor.js:294, 937; helper at 5201–5210); nothing reads
  the JWT.
- **S2 (minor):** the SQL `?|` predicate and JS `doctorSupportsTier` disagree on a
  malformed jsonb *scalar string* column value (e.g. `'"vip"'::jsonb`): `?|` on a
  jsonb string matches the string itself (SQL invites), while the JS side fails
  `Array.isArray` and reads standard-only (gate refuses) — the invite-then-refuse
  shape this batch exists to kill. This mismatch is pre-existing between
  auto_assign.js:79 and Guardrail 3d, not introduced here, and no writer produces
  scalar jsonb; recording it because A2-2 imports it into a third surface.
- **S3 (minor):** the parity test's `sqlOrderTier` is a hand-written JS mirror of
  orderTierSql, and the mirror is not perfectly faithful: Postgres `TRIM` strips
  spaces only, JS `.trim()` strips all whitespace, so a tab-padded `"\tvip"`
  urgency_tier would read `'\tvip'` in SQL (pool hides) but `'vip'` at the gate
  (accept takes). Fail direction is under-show — the safe side — and no writer
  produces tab-padded tiers, but the hermetic test cannot catch its own mirror
  drifting; the DB-gated half covers only the `?|` clause, not orderTierSql.

## A2-3 (X8) — findNextAvailableDoctor through the canonical helpers. Verdict: **MEETS SPEC**

- **Gates on the brief's list:** tier — yes, via eligibleDoctorsFor's `?|`
  predicate with `tier = (order.urgency_tier || order.tier || 'standard')`
  (src/routes/doctor.js:170–204), the same expression as the accept gate's
  acceptOrderTier (doctor.js:3588); onboarding + doctor_services — yes *when the
  order carries a service_id* (auto_assign.js:66–71); per-doctor cap — yes,
  `capFor(row, tier)` against `countActiveCasesForDoctor` (doctor.js:193–199),
  the literal 4 and the hand-typed five-status list both gone and both banned by
  the pin test. Account gates (is_active, is_paused, pending_approval) ride along
  in the helper — the old picker had these three, so nothing regressed.
- **The serviceId-NULL fallback — S4 (minor, judged acceptable reuse):** when
  `order.service_id` is NULL, eligibleDoctorsFor deliberately skips
  onboarding_complete and doctor_services (auto_assign.js:63–66 — "fall back to
  specialty-only rather than matching zero doctors"). The picker inherits exactly
  auto_assign's semantics, which is what "route it through the same eligibility
  helper" means, and the shape rule forbids bolting a new condition on top. But
  the residue must be on the record: broadcast checks onboarding_complete
  unconditionally (broadcast.js:228), so for a NULL-service order the picker can
  select an onboarding-incomplete doctor whom broadcast would never invite —
  the picker and auto_assign agree with each other, not yet with broadcast, on
  this one column. Pre-existing helper semantics, not new drift; if it should
  close, it closes inside eligibleDoctorsFor, once.
- **Ordering unchanged:** yes. Old: `ORDER BY COALESCE(created_at,'1970-01-01') ASC
  LIMIT 1` with the cap in SQL. New: same ORDER BY over the candidate ids
  (doctor.js:188–192), iterate in order, first under-cap (or uncapped) wins —
  semantically the same oldest-account-first pick. (eligibleDoctorsFor's own
  `ORDER BY name` is discarded by the re-sort; auto_assign's least-loaded policy
  is correctly NOT imported.)
- **No-target claim verified accurate:** `findNextAvailableDoctor` returns null on
  empty spec, unreadable pool (fail-closed catch), or no under-cap candidate; the
  caller then hits `return res.redirect(...?msg=capacity)` with no state change
  (src/routes/doctor.js:3745–3746) — the case keeps its holder. The report's claim
  is true. When a target IS found the reassign path runs, and its own failure also
  lands on ?msg=capacity (doctor.js:3735–3741).
- Signature change (specialtyId → order) is the minimum needed to carry
  tier/service; the sole caller was updated and the pin enforces the new call shape.
- **S8 (note, performance only):** the picker now issues one query per candidate's
  load, sequentially, instead of one SQL pass; and broadcast filters capacity in
  JS after fetching all candidates. Behavior-equivalent; fine at current pool
  sizes; not a spec issue.

## A2-4 (A4/S5) — slot_notes withheld until accept. Verdict: **MEETS SPEC**

- **Same mechanism, not a second one:** yes. `slot_notes` joined the existing
  WITHHELD_UNTIL_ACCEPT list (doctor_case_access.js:170), and
  `redactWithheldUntilAccept` (doctor_case_access.js:431–437) is a thin
  "delete the withheld keys" applier of that same list for non-orders row shapes —
  no second list, no new key names, keys deleted not blanked, clone semantics
  (all four properties pinned by the parity test).
- **Scheduling facts kept:** yes. pendingVideoAppt keeps id, status, scheduled_at,
  doctor_proposed_time (the SELECT at doctor.js:2956–2963 minus slot_notes); the
  video page redacts after the date-formatting lines so the formatted times
  survive (video.js:958–960); the board keeps everything but the withheld keys and
  patient identity (video.js:2303–2305).
- **Templates checked — nothing breaks:**
  - portal_doctor_case.ejs / doctor_case_intelligence.ejs: **no view reads
    pendingVideoAppt at all** (repo-wide grep) — it was payload-only exposure, so
    pre-accept rendering cannot break and post-accept is trivially intact. The
    redaction is still correct defense ("an absent key cannot be printed by a
    template edit later").
  - video_appointment.ejs:340–342 renders slot_notes behind
    `<% if (appointment.slot_notes) %>` — a deleted key is undefined/falsy, so the
    pre-accept doctor view skips the block cleanly; patients and accepted doctors
    get the unredacted row, so post-accept rendering is intact.
  - doctor_appointments.ejs reads none of the withheld keys.
- **Gating condition is the settled one:** `!showFullCase` is
  `!isAcceptedByThisDoctor` (doctor.js:2763), and the video page/board both gate on
  doctorHasAccepted{Order,Case} — the Batch A acceptance test, not a new predicate.
- **Sweep:** my own repo-wide slot_notes sweep found no remaining pre-accept
  doctor-facing path — the only other flows are the doctor-side propose-slot
  handler (video.js:1995–2019, requires `appointment.doctor_id === req.user.id`
  and notifies the *patient*) and the patient-side form input. Broadcast/notify
  payloads carry no patient free text.
- **S7 (note):** the progress doc says "side-path sweep findings in the batch
  report", but no batch report is in the commit — the sweep's *outcomes* (video
  page, board) are implemented, its written findings are not in-repo. Cosmetic
  documentation gap only, given my sweep re-derived a clean result.

## A2-5 (A6/S3) — terminal-state reassign stays refused. Verdict: **MEETS SPEC**

- **Verification claims all true:** the allowlist
  `[ASSIGNED, IN_REVIEW, SLA_BREACH, REASSIGNED].includes(currentStatus)` refuses
  completed/cancelled/refunded (and every other state) at
  src/case_lifecycle.js:3248–3250 with the named-status throw; the superadmin
  catch redirects `?error=reassign_failed` (src/routes/superadmin.js:5541); the
  banner names the refusal ("completed, cancelled or refunded cases cannot be
  moved", src/views/superadmin_order_detail.ejs:133). No override path was added;
  case_lifecycle.js is untouched by the diff. Compliant with Ziad's decision.
- **Pin load-bearing:** yes in substance — tests/lint/batch-a2-routing-pins.test.js
  reads the live sources and fails on any of the three surfaces reverting, and it
  runs under the runner harness (verified: the 12 new checks are inside the 1926).
- **S6 (minor):** one pin string is satisfiable by a comment: `?error=reassign_failed`
  also appears in the explanatory comment at superadmin.js:5521, so deleting the
  actual redirect at 5541 while keeping the comment would not trip the pin.
  (The A2-1 pins were checked for the same weakness and are clean — their banned
  and required shapes only match code.) Cheap hardening: match the
  `return res.redirect(...reassign_failed...)` shape.
- **S9 (note, pre-existing):** the catch is generic, so a *non*-terminal-state
  reassignCase throw ("already assigned to this doctor", "Case not found") lands
  under the same terminal-state banner copy. Not introduced or worsened by this
  commit (A2-5 only verified and pinned); recording for the backlog.

## Tests (question 6)

- Both new files sit in tests/core/ and tests/lint/, which tests/run.js discovers
  recursively (everything ending .test.js outside tests/pin/), and both report
  through `global._testRunner` — so their 12 checks are tallied and gate the run.
  Verified arithmetically (1914 + 12 = 1926) and by re-running the suite.
- The paused-doctors lint change is sound *for doctor.js*: with
  `allowClause:false, allowShared:false, allowAutoAssign:true`, the
  capacity-overflow site now passes ONLY via delegation to eligibleDoctorsFor —
  reverting the picker to inline SQL fails the lint even if the inline SQL keeps
  the is_paused clause, which fails safe (forces a deliberate lint edit).
- **S5 (minor):** the claim "pinned at the 'auto-assign' site, so the invariant
  still fails there if the predicate is ever dropped" overstates the granularity.
  The auto-assign site check is file-level, and src/auto_assign.js carries TWO
  `COALESCE(is_paused, false) = false` occurrences (eligibleDoctorsFor at line 74
  and the manual-queue COUNT at line 215). Dropping the predicate from
  eligibleDoctorsFor alone — the one the picker now rides — would leave the lint
  green. A function-scoped slice (the pins file already has sliceFunction for
  exactly this) would close it.

## Unrequested changes (question 7) — complete inventory, each judged

1. Broadcast's two queries unified into one — structural consequence of deleting
   the column-picking (the queries differed only in the cap clause); justified.
2. Broadcast load-count/ordering switched to doctorLoadSql — required by "capFor +
   the same load count"; justified (S1 notes the ordering side-effect).
3. NULL-cap 5/8 defaults → "no cap configured" — inherent to capFor, disclosed;
   justified (S1).
4. video.js: `viewerIsUnacceptedDoctor` extracted from the existing patient
   ternary — minimal refactor needed to reuse the same condition; justified.
5. Accept-handler KNOWN-GAP comment rewritten to CLOSED, and the MAX_ACTIVE_CASES
   comment updated — documentation kept truthful; justified.
6. docs/BATCH_A2_PROGRESS.md added — process artifact; harmless.
7. paused-doctors lint extended with allowAutoAssign — necessitated by A2-3;
   justified (S5 notes the granularity caveat).
8. readDoctorSlaTiersRaw fails closed to standard-only on a transient read error,
   where the accept path refuses outright (account_check_failed) — a deliberate,
   documented under-show; the worst case is a standard-tier invite-then-refuse
   during a DB error window. Acceptable; note only.

**No instance of the diff writing a new eligibility condition was found** — every
predicate added is an import or derivation of tierSpellings, doctorSupportsTier,
capFor, doctorLoadSql, or eligibleDoctorsFor, and the derivations are parity-tested.

## Findings index

| # | Severity | Where | Summary |
|---|----------|-------|---------|
| S1 | note | src/notify/broadcast.js:242–248 | NULL-cap default 5/8 → uncapped, and ordering now doctorLoadSql-based — inherent to capFor parity, disclosed |
| S2 | minor | src/notify/broadcast.js:233 / src/services/doctor_eligibility.js:143–153 | jsonb scalar-string sla_tiers_supported: SQL `?|` invites, JS gate refuses (pre-existing helper mismatch, now on 3 surfaces) |
| S3 | minor | tests/core/a2-eligibility-parity.test.js:104–112 | parity test's JS mirror of orderTierSql not TRIM-faithful (tabs); under-show direction; no DB-side pin of orderTierSql |
| S4 | minor | src/routes/doctor.js:177–186 / src/auto_assign.js:63–71 | serviceId-NULL picker path skips onboarding/doctor_services (auto_assign's own fallback); broadcast still checks onboarding unconditionally — residual cross-surface asymmetry lives in the helper |
| S5 | minor | tests/lint/paused-doctors-excluded-everywhere.test.js:44–49 | is_paused "pinned in auto_assign" is file-level; a drop from eligibleDoctorsFor alone stays green (second occurrence at auto_assign.js:215) |
| S6 | minor | tests/lint/batch-a2-routing-pins.test.js:118–121 | `?error=reassign_failed` pin satisfiable by the comment at superadmin.js:5521 |
| S7 | note | docs/BATCH_A2_PROGRESS.md | A2-4 sweep findings referenced but not committed; independent sweep here came back clean |
| S8 | note | src/routes/doctor.js:193–199 / src/notify/broadcast.js:245 | picker N+1 load counts; broadcast capacity filter moved to JS — performance only |
| S9 | note | src/routes/superadmin.js:5527–5541 | generic catch means non-terminal reassign errors get the terminal-state banner copy (pre-existing) |

## Overall verdict

**All five items MEET SPEC; no blockers, no majors.** Every fix is genuinely a
redirection to an existing canonical helper — the banned local logic is deleted
rather than corrected, the urgent fan-out and the terminal-state refusal were
left exactly as the brief ordered, the standing constraints (tiers, acceptance
windows, the settled visibility rule) are untouched, and the parity test plus
source pins make the unification enforceable rather than aspirational. The test
delta (1914→1926, same 6 baseline failures) was independently reproduced. The
six minor findings are edge-hardening, not defects in what was asked: two
faithfulness edges in the parity proof (S2 jsonb scalars, S3 the TRIM mirror),
one residual asymmetry that lives inside the canonical helper itself and was
explicitly anticipated by the brief (S4), and three pin/lint granularity
weaknesses (S5, S6) worth a cheap follow-up in the fix round. Nothing in the
diff invents a new eligibility rule, and nothing the brief asked for is missing.
