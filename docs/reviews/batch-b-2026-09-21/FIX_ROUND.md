# Batch B fix round — every finding dispositioned

Inputs: SPEC_REVIEW.md (1 MAJOR, 1 MINOR, 6 NOTEs) and ADVERSARIAL_REVIEW.md
(2 MAJOR, 5 MINOR, 10 NOTEs). Every finding below is FIXED (with the change
named) or DISPOSITIONED (with the reason). After the round: the scratch-DB
verification passes end-to-end including four new fix-round checks
(VERIFICATION_OUTPUT.txt §6), and the no-DB suite is 1928 passed / 6 failed —
the failing set byte-identical to the pre-batch baseline.

## Spec review

| # | Sev | Disposition |
|---|---|---|
| F1 — B3 dry-run outputs not persisted | MAJOR | **FIXED** — B3_DRY_RUNS.md carries both BEGIN…ROLLBACK transcripts verbatim, the SQL, the asserts, the recommendation and the deploy-order analysis. |
| F2 — no numbered §3 in the verification output | MINOR | **FIXED** — verify_batch_b.js §3 now prints the retired token-row count and the doctor_sla_events count side by side (1 === 1, with an admin_manual event excluded from both). |
| F3 — idempotency key is the conditional flip, not a literal key | NOTE | **DISPOSITIONED** — recorded as the letter-vs-spirit deviation; the flip is per-order and the sequential + concurrent double-submit proofs show one-of-everything. A literal key would need a column (migration) for no additional guarantee on this surface. |
| F4 — reader function naming drift vs PLAN.md | NOTE | **DISPOSITIONED** — same job, better name for the actual call shape. |
| F5 — future-month guard + audit row beyond spec | NOTE | **DISPOSITIONED** — protective/observational only; kept. |
| F6 — `already_paid` reassignment guard bites later | NOTE | **SUPERSEDED by adversarial M-2's fix** — the guard family now also refuses a reassignment of a DELIVERED case (see below), which restores the protection the old at-submit `paid` stamp gave, at the right boundary. |
| F7 — admin_manual exclusion carried forward | NOTE | **DISPOSITIONED** — required by the brief; preserved and proven. |
| F8 — statement hard-zeroes reassigned money | NOTE | **DISPOSITIONED** — deliberate belt-and-braces; the lifetime figure computes it so a legacy anomaly stays visible. |

## Adversarial review

| # | Sev | Disposition |
|---|---|---|
| M-1 — /payouts owed ≠ what mark-paid settles | MAJOR | **FIXED** — `getOwedByDoctor` / `getGlobalOwedTotals` now return `owedSettleableEgp` (pending AND delivered — exactly the set `markMonthEndPaid` can stamp: main rows require the order's `completed_at`; video and add-on rows are written at delivery) and `owedInFlightEgp` (accepted-but-undelivered). GET /payouts surfaces both, per doctor and in the totals, additively (no existing field changed), and `basis.owed` says plainly: *transfer off owedSettleableEgp*. Proof: §6 — a seeded undelivered case shows as 333 in-flight, settleable+in-flight=owed, and mark-paid leaves it pending. |
| M-2 — reassignment racing a submit zeroes a delivered doctor; flip lacks doctor recheck | MAJOR | **FIXED, both halves** — (a) `markReassignedOnReassignment` gains a delivered-guard after its FOR UPDATE: it reads the ORDER's `completed_at`/status (the settle in the submit transaction serialises on the same row lock, so a committed submit is always visible) and returns `skipped: 'already_completed'` instead of zeroing a doctor who delivered. (b) `completeOrderInTxn`'s conditional UPDATE now also requires `doctor_id = $doctor` — the load-time authorisation made atomic — so a submit racing an A→B reassignment loses the flip instead of completing a case it no longer holds (closing the pre-existing double-liability half too). Proof: §6 — a delivered case's reassignment is refused, the fee intact. Residual: interleavings where NEITHER transaction has committed remain theoretically possible (full closure needs case-level locking across reassignCase, out of Batch B's scope); both deterministic halves and the committed-first races are closed. |
| m-1 — /breach-cost 90% arm matches a string the writer never stamps | MINOR | **FIXED** — the arm matches both the retired `…90pct_clawback` and the real `…scaled_90pct_clawback` (stamped since 2026-08-17); 9×earned is exact at a full refund and documented as an upper bound for partial ones (the ratio is not stored) — a stated bound instead of the silent 0 this pre-existing bug produced. |
| m-2 — policy doc documents the wrong audit enum | MINOR | **FIXED** — §4.A's table names `…scaled_90pct_clawback`, with the pre-2026-08-17 legacy value noted. |
| m-3 — mark-paid UPDATE…FROM lacks a status re-check | MINOR | **FIXED** — both outer UPDATEs re-check `u.status = 'pending'`, so EvalPlanQual cannot stamp `paid` over a concurrently-committed `reassigned` flip. |
| m-4 — completion guard misses legacy COMPLETED variants and terminal statuses | MINOR | **FIXED** — the early check, the draft-text write and the flip all speak the DB_STATUS_VARIANTS vocabulary: `done`/`finished` read as already-completed (no re-notify — proven in §6), and `cancelled`/`canceled`/`refunded`/`expired` return the new `case_not_open` result (route redirects with `?error=case_not_open`). |
| m-5 — the race loser defaces the winner's report text | MINOR | **FIXED** — `persistReportText` carries the same terminal-status guard and reports its row count; a stale submit gets the idempotent result and the completed case's text is untouched (proven in §6). The orphan R2 PDF on a true race remains (harmless object, no row references it) — accepted. |
| N-1 — two-statement month-end stamp | NOTE | **DISPOSITIONED** — idempotent re-run heals a crash between the two; audit row then reports the delta. Accepted. |
| N-2 — late completions after a month's run | NOTE | **DISPOSITIONED** — visible as owed (and now as *settleable*, per M-1's split, which is the prompt N-2 said was missing); re-running the past month is permitted and idempotent. |
| N-3 — tile "approved this month" ~0 until the month's own run | NOTE | **DISPOSITIONED** — consequence of completion-month attribution, consistent with policy; earnings-page footnote explains the lifecycle. |
| N-4 — INNER JOIN hides an addons-only doctor from the list | NOTE | **DISPOSITIONED** — carried over deliberately (add-ons settle only at completion, which writes the case row first); totals stay whole-table. |
| N-5 — last_paid_at / cycle_cases unfiltered by kind | NOTE | **DISPOSITIONED** — cosmetic parity with the old query; token rows are never `paid` and carry 0. |
| N-6 — statement case_count includes video rows | NOTE | **DISPOSITIONED** — parity-or-better vs the old COUNT(*). |
| N-7 — unlocked read-modify-write in the recompute clamps | NOTE | **DISPOSITIONED** — pre-existing; all writers move down, worst case a stale higher bound in a millisecond window. |
| N-8 — `$7::timestamp` caveat + wrong migration number in a comment | NOTE | **FIXED (comment)** — the writer's comment now names migration 083's `uniq_doctor_earnings_appointment_video`; the caller contract (UTC ISO strings) is stated. |
| N-9 — /admin tile logs console.warn only | NOTE | **DISPOSITIONED** — deliberate degradation for an optional dashboard tile; the money endpoints fail loud. |
| N-10 — mark-paid authz confirmed | NOTE | No action needed. |

## Post-round evidence

- verify_batch_b.js §1–§6 all pass (VERIFICATION_OUTPUT.txt regenerated end-to-end).
- tests/services/earnings_writer.test.js and tests/finance/reassignment-earnings.test.js pass against the scratch DB.
- No-DB suite: 1928 passed / 6 failed / 52 skipped — failing set identical to the pre-batch baseline.
