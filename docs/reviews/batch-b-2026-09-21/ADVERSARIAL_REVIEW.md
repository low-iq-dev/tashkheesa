# Adversarial review — Batch B (earnings ledger + report service)

Branch `fix/earnings-ledger-and-report-service` vs `origin/main` @ 4283395b7.
Reviewed 2026-09-21, independently of the implementer's plan/progress notes
(diff + source + `docs/FIX_PLAN_2026-09-15.md` + `docs/PAYOUT_AND_URGENCY_POLICY.md`
only; no commit messages, no PLAN.md/SPEC_REVIEW.md/BATCH_B_PROGRESS.md).

Verdict up front: **no BLOCKER found.** The core policy mechanics — reassigned
earns zero, month-end `paid`, Cairo-by-completion bucketing, the atomic report
service, the pause-counter migration — are implemented correctly, and several
old defects are genuinely closed. What follows are the places where money can
still go wrong, ranked.

---

## MAJOR

### M-1. GET /payouts "owed" is not the amount `mark-paid` will settle — the operator can over-transfer
`src/services/earnings_reader.js:335-377` (`getOwedByDoctor`),
`src/services/earnings_writer.js:989-1085` (`markMonthEndPaid`),
`src/routes/api/admin.js` (`GET /payouts`, `POST /payouts/mark-paid`).

- `owed` = **all** `status='pending'` rows, including in-flight rows written at
  ACCEPTANCE for cases not yet delivered (plus all pending add-ons).
- `markMonthEndPaid` deliberately stamps only rows whose order has
  `completed_at` in the requested Cairo month.

Scenario: on Sep 30 the operator opens `/payouts`, sees Dr X owed 5,000 EGP
(3,800 completed in September + 1,200 accepted-but-undelivered), transfers
5,000 by InstaPay, then calls `mark-paid { month: '2026-09' }`, which stamps
3,800. The 1,200 was paid out for work not delivered — and if that case is
later reassigned away, the doctor was paid for a case that by policy earns
zero. The stamped totals come back in the mark-paid response, but the
transfers have already been made off the owed figure. Before Batch B this gap
did not exist in this form ('paid' was stamped at completion, so 'pending'
meant in-flight only and nobody paid off it month-end).

Fix shape: the payout surface needs a "payable for month M" figure (pending
AND completed, per month — the exact set the stamp selects), or at minimum an
`owedSettleableEgp` split next to `owedEgp`. Confidence: high on the
mismatch; medium on operational impact (depends on how Ziad actually pays).

### M-2. Reassignment racing a report submit zeroes a doctor who delivered — the `status='paid'` race guard no longer guards
`src/services/earnings_writer.js:864-872` (step 2 of
`markReassignedOnReassignment`), `src/case_lifecycle.js:3242-3251`
(`reassignCase` status gate), `src/services/report_submission.js:551-603`.

Pre-Batch-B, submit stamped the row `'paid'` immediately, so the
`row.status === 'paid'` guard in the reassignment write-down actually
protected a delivered case in the submit-vs-reassign race. Now submit leaves
the row `'pending'` until month-end, so that guard protects **nothing until
the payout runs** — the code's own comment ("the guard bites later… which is
the point") rebrands a widened race as policy.

Concrete interleaving:
1. `reassignCase` reads the case (`getCase`) — status `in_review`, passes its
   terminal-status gate.
2. Doctor A's submit transaction commits: order → `completed`, A's row settled
   at full fee, still `'pending'`.
3. `reassignCase` proceeds: `markReassignedOnReassignment` locks A's row —
   `'pending'`, not `'paid'` → flips it to `'reassigned'` at **0**; assignDoctor
   hands the completed case to B; `writePendingForCase` opens a full-fee
   pending row for B.

Outcome: A delivered the report and earns 0; B earns the full fee for a case
already completed; the patient's completed case is trampled back to assigned.
The window is small (between `reassignCase`'s status read and its earnings
write) but the SLA sweep fires exactly when doctors submit at the deadline —
this is the least unlikely moment for the race. The symmetric race (submit
losing) is also open: `completeOrderInTxn` re-checks only
`status <> 'completed'`, **not** `doctor_id = $doctorId`, so a submit that
started before an A→B reassignment can complete the case as A and settle A at
full fee via the came-back-row reopen, while B holds a second full-fee pending
row — double liability on one order (this half is pre-existing; the widened
guard-window half is new to Batch B).

Fix shape: (a) `markReassignedOnReassignment` should also skip when the order
is completed by this doctor (`orders.completed_at IS NOT NULL` and the row was
settled), not only when `'paid'`; (b) `completeOrderInTxn`'s conditional
UPDATE should add `AND doctor_id = $n` — it is already the one atomic gate,
so the recheck is free. Confidence: high on the mechanism (code-read), medium
on frequency.

---

## MINOR

### m-1. `/breach-cost` clawback money: the 90% policy arm matches a string the writer has never stamped
`src/services/earnings_reader.js:453-479` (`getClawbackSummaryByPolicy`)
matches `clawback_reason = 'patient_or_operator_post_acceptance_90pct_clawback'`,
but the writer stamps `'patient_or_operator_post_acceptance_scaled_90pct_clawback'`
(`earnings_writer.js:764`) — and did so on origin/main too (old line 680). So
every modern 90% clawback lands in the `ELSE 0` arm: counted, 0 EGP. Carried
over verbatim from the old inline query into the "one shared module", which
makes it look settled. For a scaled partial refund the amount is genuinely
underivable from the row (the ratio isn't stored), but for the common
full-refund case (`ratio=1`) `9 × earned` is exact and is silently not
computed. `/breach-cost` under-reports clawback EGP on an ops money surface.
Confidence: high (string comparison; verified old writer via
`git show origin/main`).

### m-2. Policy doc (B5) still documents the wrong audit enum
`docs/PAYOUT_AND_URGENCY_POLICY.md` §4.A policy table says the 90% row stamps
`patient_or_operator_post_acceptance_90pct_clawback`; the code stamps the
`…scaled_90pct…` value. B5's whole point was that the doc stops lying;
anyone reconciling the ledger against the doc will grep for a value that
does not exist. Confidence: high.

### m-3. `markMonthEndPaid` UPDATE…FROM does not re-check `status='pending'` on the target row
`src/services/earnings_writer.js:1006-1026`. The stampable set is chosen in a
subquery; the outer `UPDATE … WHERE u.id = sel.id` carries no status
predicate. Under READ COMMITTED, if a concurrent `markReassignedOnReassignment`
flips a selected row to `'reassigned'`/0 and commits first, EvalPlanQual
re-checks only `u.id = sel.id` (still true) and stamps `'paid'` over the
fresh `'reassigned'` — the reassignment marker is destroyed. Money impact at
stamp time is 0 (the amount is already 0), but the corrupted status then makes
`writePendingForCase` treat a come-back case as `already_exists` ('paid', not
'reassigned') and `settleCaseEarningsOnCompletion` skip as `already_paid_out`
— a doctor who later delivers that case is settled at 0. Requires a
mark-paid run racing a reassignment of a completed-then-reopened case:
narrow, but the fix is one line (`AND u.status = 'pending'` in the outer
WHERE, or `FOR UPDATE` in the subquery). Confidence: high on the SQL
semantics, low on real-world frequency.

### m-4. The completion flip's idempotency guard misses the legacy COMPLETED variants
`src/services/report_submission.js:383-390` gates on
`LOWER(COALESCE(status,'')) <> 'completed'`, and the early check
(`normalizeStatus === 'completed'`) is the same test. `case_lifecycle.js`'s
`DB_STATUS_VARIANTS` says production has historically stored `'done'` /
`'finished'` for COMPLETED (and `'in_progress'` really occurred in prod, so
the variant lists are not theoretical). A case sitting at `'done'` can be
re-completed: the flip wins, the assignment re-closes, and the post-commit
block **re-notifies the patient**. Same guard also permits completing a
`cancelled`/`refunded` case from a stale doctor tab (the old handler was no
better — it had no in-UPDATE guard at all — but now that this WHERE clause is
THE idempotency key, it should speak the whole vocabulary: either
`dbStatusValuesFor('COMPLETED')` for the exclusion, or a positive allow-list
of from-statuses). Earnings exposure on a refunded case is bounded by the
clawback guards (`recomputeOnRefund` stamps before mark-paid completes), but a
cancelled-never-refunded case would settle a full pending fee. Confidence:
high on the code path, medium on whether variant/terminal rows are reachable
by an assigned doctor's session.

### m-5. Loser-side writes outside the transaction can deface the winner's report text
`src/services/report_submission.js:448-459`. `persistReportText` runs before
the conditional flip, unconditionally, for BOTH racers. A stale tab holding
older text that loses the race still overwrites
`diagnosis_text`/`impression_text`/`recommendation_text` on the now-COMPLETED
order — the patient's on-site report (which renders those columns) shows the
stale text while the PDF and `report_exports` hold the winner's. The loser
also runs the pre-txn IN_REVIEW transition attempt and uploads an orphan PDF
to R2 (never referenced by any row). All acknowledged trade-offs of the
save-first design, but the completed-case overwrite is patient-visible: a
cheap improvement is `… WHERE id = $n AND LOWER(COALESCE(status,'')) <>
'completed'` on the draft-shaped UPDATE too. Confidence: high.

---

## NOTES

- **N-1. Two-statement stamp.** `markMonthEndPaid` stamps `doctor_earnings`
  and `addon_earnings` in two separate non-transactional statements plus a
  best-effort audit row; a crash between them leaves add-ons unstamped.
  Re-running the month heals it (idempotent), and the audit row then reports
  only the second run's deltas. Acceptable; worth knowing.
- **N-2. Late completions after a month's payout ran.** A case completing on
  the 30th after the run stays `pending` and visible as owed; settling it
  requires re-running `mark-paid` for that (past) month, which the guard
  permits. Nothing is stranded invisibly — but nothing prompts the re-run
  either.
- **N-3. Dashboard "Approved this month" is by COMPLETION month.** A
  September payout stamping August completions shows under August; the
  current-month tile's approved figure is ~always 0 until the month's own
  last-day run. Consistent with the policy, possibly surprising to a doctor.
- **N-4. `getOwedByDoctor` INNER JOINs `doctor_earnings`,** so a doctor with
  pending add-on commission and zero `doctor_earnings` rows is missing from
  the list while `getGlobalOwedTotals` counts them (header ≠ sum of rows).
  Carried over deliberately from the old query (add-ons only settle at case
  completion, which writes the case row first), so only legacy data could hit
  it.
- **N-5. `last_paid_at` / `cycle_cases`** in `getOwedByDoctor` have no
  `MONEY_ROWS`/kind filter — a legacy paid token or a reassigned row bumps
  them. Cosmetic; parity with the old query.
- **N-6. `getDoctorMonthlyStatement.case_count`** counts money-kind rows in
  any status, so it includes video appointments and reassigned-away cases in
  "cases". Parity-or-better vs the old COUNT(*).
- **N-7. Read-modify-write without lock in `recomputeOnRefund` /
  `recomputeOnBreach`.** The write-down clamp uses `existing.earned_amount`
  read outside any transaction; two concurrent adjusters can interleave. All
  writers only move the amount down, so the worst outcome is a stale (higher)
  clamp bound in a millisecond window. Pre-existing.
- **N-8. `writeVideoAppointmentEarning`'s `$7::timestamp`** is correct for the
  current callers (`nowIso()` UTC strings; sessions pinned UTC in src/pg.js),
  but a future caller passing a zoned local timestamp would have its offset
  silently discarded. The NOT-EXISTS + partial-unique-index
  (`uniq_doctor_earnings_appointment_video`, migration 083 — note: the code
  comments say "migration 082", which is actually ops_push_log) closes the
  double-insert race.
- **N-9. `/admin` tile failure path** logs with `console.warn` only, no
  `logErrorToDb` — a step down from the old safeGet path's observability;
  deliberate degradation per the comment.
- **N-10. `mark-paid` authz confirmed:** `router.use(requireJWT)` +
  `requireRole('superadmin')` at `routes/api/admin.js:632-633` precede the
  route; month is regex-validated server-side; all values parameterised. No
  injection surface found.

---

## Checked and cleared

- **Cairo conversions in the reader.** `de.created_at::timestamptz` /
  `COALESCE(...)::timestamptz AT TIME ZONE 'Africa/Cairo'` is correct
  (sessions pinned UTC — `SET TIME ZONE 'UTC'` + startup options in
  src/pg.js); no two-step double shift anywhere in the new module; the
  `fromDate` window converts the instant with the same one-step form, so both
  sides of every comparison are Cairo wall-clock. `NOW_CAIRO`/`MONTH_START_CAIRO`
  arithmetic (timestamp + interval) is sound.
- **Migration 109 backfill timezone.** `de.created_at AT TIME ZONE 'UTC'` on a
  naive column *states* the zone (naive→timestamptz), it does not shift — the
  correct single-step form. Idempotent across Render boots via reused token id
  + `ON CONFLICT (id) DO NOTHING`. Backfill filter `status='reassigned'`
  matches how every token was ever written (`markPartialPayOnReassignment`
  inserted tokens with `'reassigned'`; the reopen paths zero the amount but
  never change the status).
- **Pause-counter equivalence.** doctor_pause's event count matches the old
  token count case-for-case: A→B→A→B records two events (no unique constraint
  on (doctor, order) — checked migration 109), the crashed-half-done state
  falls through and records the missing event exactly as the old code minted
  the missing token, `admin\_manual%` exclusion moved verbatim from
  `reassignment_reason` to `reason` (stored verbatim by the writer), and the
  event insert is in the same transaction as the row flip.
- **Kind-prefix discipline.** Video rows cannot leak into main sums
  (COMPLETION_JOIN is gated `AND KIND_MAIN`; appointment-UUID vs order-id
  collision is not realistically possible), token rows are excluded from every
  money figure by `MONEY_ROWS`, and `getCaseFeesForOrders` is main-row-only —
  the old any-row LEFT JOIN that surfaced the 10% token as "the fee" is gone.
  A main row for a non-current doctor is excluded from money by its
  `'reassigned'` status in all non-race flows (the race is M-2).
- **`markMonthEndPaid` gates.** In-flight main rows cannot be stamped (the
  `o.completed_at IS NOT NULL` requirement for `earn-main-%`); token rows are
  excluded outright; future months refused; current month allowed; re-runs
  idempotent (only `'pending'` selected). Hard-deleted orders leave the row
  permanently pending — visible as owed, acceptable.
- **`recomputeOnRefund` cannot raise an amount.** Both branches pass the
  shared clamp against the row's current `earned_amount`; a row zeroed by
  reassignment stays 0 on the sla_breach path; a stage-1 breach stamp does not
  block the 90% path (intended two-stage design) and the stamp-preservation
  logic (COALESCE on the breach marker, NOW() on the 90% marker) cannot
  re-open a finished settlement.
- **`settleCaseEarningsOnCompletion`.** The already-`'paid'` guard makes a
  retried submit a no-op on settled cash; the clawback-preserve branch keeps
  the adjusted amount verbatim; the A→B→A reopen paths zero the legacy token
  so the doctor is paid 100% once, never 110%; `dbFor(client)` correctly
  routes every read AND write through the enclosing transaction. No caller of
  the removed `markCaseEarningsPaid` / `markPartialPayOnReassignment` survives
  outside comments.
- **Report route parity.** The new thin route maps every service code to the
  exact redirect/status the deleted 390-line handler produced
  (`invalid_request`→400, `not_found`→404, `forbidden`→403, and the four
  `?error=` redirects); `alreadyCompleted` and `completed` both land on the
  case page as before. The atomic core strictly strengthens the old sequence
  (report_exports, assignment close, order_events, earnings settle now commit
  or roll back together; before, each was individually best-effort).
- **Email templates.** `caseReference` is derived in notification_worker from
  `caseId` (`data.caseReference || caseId.slice(0,12).toUpperCase()`), so
  dropping `partialPct`/`partialAmount` from the payload leaves no unbound
  variable; `isAcceptanceBreach` still flows via `...data`; EN and AR
  templates changed in lockstep and neither references the removed fields.
  The in-app body (notify.js `order_reassigned_from_doctor`) never used them.
- **`/payouts` JSON shape for the Command app.** Every pre-existing field name
  in `doctors[]`, `totals`, `month` and `basis` survives with the same key and
  type; only the `basis` prose changed. `superadmin_dashboard`'s positional
  `Promise.all` destructuring is intact (one thenable replaced in place), and
  its `payouts.map` was updated to the reader's camelCase in the same commit.
  EJS surfaces (`portal_doctor_earnings.ejs`, analytics view, video
  appointments view) read only fields the reader/routes still supply
  (`reassigned_count` is additive).
- **A4 redaction interplay.** `redactPatientIdentity` deletes a fixed identity
  field list from a clone; the merged `doctor_fee_egp` survives redaction.
- **Test pins moved, not weakened.** The report_exports lint guard now points
  at report_submission.js AND additionally requires the route to call
  `submitDoctorReport`; kpi-endpoints-fail-loud gains two NEW pins (the
  /payouts reader requirement and a no-catch/no-safe* scan of
  earnings_reader.js); the behaviour test stubs the reader at the same seam as
  the must* helpers and restores it. The deleted P1-DOC-2 partial-pay
  assertions test retired policy and are replaced by zero-policy equivalents.
- **Video earning consolidation.** Both raw INSERTs route through the writer
  with identical guard semantics (NOT EXISTS + untargeted ON CONFLICT matching
  the partial unique index); the call-end path stays inside its transaction
  via `client`; the no-show sweep gains cross-path dedupe it previously
  lacked (deterministic id vs 'earn-<uuid>' never collided before).
- **`LIMIT $2` / `ANY($2::text[])` / `unnest($1::text[])`** parameter typing
  all valid; ids are stringified before binding; `fromCairoSql` interpolation
  in `/breach-cost` comes only from the whitelisted `BREACH_COST_PERIODS`
  constant table.

## Summary

No blocker. Two MAJORs: (M-1) the `/payouts` owed figure includes in-flight
earnings the month-end stamp will never settle, so the screen the operator
pays from can over-state the transfer; (M-2) the reassignment race guard was
implicitly weakened by moving 'paid' to month-end — a doctor who delivers in
the reassignment window is zeroed, and the completion flip doesn't re-check
`doctor_id`, leaving a double-liability path. Five MINORs, the sharpest being
the `/breach-cost` clawback arm matching a `clawback_reason` string the writer
has never produced (carried over, now enshrined in the shared reader, and the
refreshed policy doc documents the same wrong string). Everything else
checked — Cairo conversions, migration 109 backfill and pause-counter
equivalence, month-end stamp gates, refund clamps, JSON shape stability for
the Command app, email variable parity, and the lint/test pins — is clean.
