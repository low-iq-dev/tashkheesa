# Batch B — spec review

Reviewer: spec review (independent). Date: 2026-09-21.
Branch `fix/earnings-ledger-and-report-service` (7 commits, `3fb4d24c1..df7143ecd`) against base `origin/main @ 4283395b7`.
Specification: `docs/FIX_PLAN_2026-09-15.md` (Decisions table + Batch B) and the brief's requirements as restated in `docs/reviews/batch-b-2026-09-21/PLAN.md`.
Method: full diff read, independent grep for residual aggregation SQL, spec item-by-item verification, and an independent re-run of the no-DB test suite.

## Verdict summary

| Item | Verdict |
|---|---|
| B1 — one aggregation module, every reader converted | **PASS** |
| B1 — kind discipline / status semantics / Cairo-by-completion / money rounding settled in one place; no type migration | **PASS** |
| B2 — 10% token writer removed; pause counter re-homed with equivalence (incl. admin_manual) | **PASS** |
| B2 — `paid` at month-end via explicit action, actor stated; add-ons same lifecycle | **PASS** |
| B2 — raw video INSERTs through earnings_writer | **PASS** |
| B2 — SLA breach reverses the uplift only; base stands if delivered | **PASS** |
| B3 — two dry runs with output shown, recommendation, Ziad commits, no prod write from the repo | **PARTIAL** |
| B4 — report submit as an idempotent, atomic service; thin route; reusable signature; three fields | **PASS** |
| B5 — policy doc states the decisions, contradicts itself nowhere | **PASS** |
| Standing constraints (tiers, percentages, payout structure/mechanics, no policy invention) | **PASS** |
| Verification evidence (five proofs in `docs/reviews/batch-b-2026-09-21/`) | **PASS** (one presentation caveat, see F2) |
| Test baseline not regressed | **PASS** (independently re-run) |

No BLOCKER findings. One MAJOR (B3 evidence not persisted in the repo), two MINOR, several NOTEs.

---

## B1 — one earnings aggregation (PASS)

**Spec:** one function/module returns a doctor's earnings for a period; every reader calls it; no caller keeps its own SQL. The module settles (1) id-prefix kind discipline, (2) `reassigned` status semantics, (3) Africa/Cairo months by completion date with naive-UTC columns converted, (4) money rounding in one place; `earned_amount` stays DOUBLE PRECISION.

**Evidence:**
- `src/services/earnings_reader.js` (new, 505 lines) is the module. The four disciplines are explicit, shared SQL fragments: `KIND_MAIN`/`KIND_REASSIGN_TOKEN`/`MONEY_ROWS` (`earnings_reader.js:61-64`), status semantics documented and enforced (`:29-32`, e.g. `getDoctorMonthSummary` counts `pending`/`paid` only, `:114-142`), `COMPLETION_CAIRO_DE = COALESCE(o.completed_at, de.created_at::timestamptz) AT TIME ZONE 'Africa/Cairo'` with the `LEFT JOIN orders` on main-prefix rows only (`:74-80`), and one `money()` rounding to piastres applied to every figure (`:95-98`). `addon_earnings` (already timestamptz) converts without the cast (`:90`). No type migration anywhere in the diff — `earned_amount` stays DOUBLE PRECISION as required.
- Every site the brief listed is converted: `doctor.js:390` (dashboard tile), `:819` (payout tile), `:1413/:1433` (earnings page statement + lifetime); `analytics.js:307/:323` (headline + monthly series) and the recent-cases table now merges per-case fees via `earningsReader.getCaseFeesForOrders` (`analytics.js:353`) instead of the old LEFT JOIN that could surface a token as "the fee"; `api/admin.js:3115` (/breach-cost via `getClawbackSummaryByPolicy`) and `:4146-4153` (/payouts via `getOwedByDoctor` + `getGlobalOwedTotals`); `superadmin_dashboard.js:571` (payouts card) and `:755` (leaderboard owed via `getOwedForDoctorIds`); `admin.js:1174` (web admin tile via `getGlobalOwedTotals`); `video.js:2320-2321` (video dashboard stats — previously a whole-ledger UTC sum with no status discipline).
- **Independent grep** for `FROM doctor_earnings|addon_earnings` across `src/` excluding the reader/writer, `_to_delete/` and tests: the only remaining hits are the two single-row per-appointment lookups `video.js:948` and `video.js:1700` (`SELECT * … WHERE appointment_id = $1`) — explicitly permitted as row fetches, not aggregations — plus comments and test helpers. No SUM/COUNT/GROUP BY over either ledger survives outside the two services.

## B2 — ledger/policy alignment (PASS)

**Token writer removed; counter re-homed with proof.** `markPartialPayOnReassignment` is gone; `markReassignedOnReassignment` (`earnings_writer.js:845`) flips the main row to `reassigned`/0 and inserts a `doctor_sla_events` row **in the same transaction** (`:900-918`), with the old guards (no main row → skip; already `paid` → skip; idempotent per (doctor, order) via the event row, `:880-894`). `REASSIGN_PARTIAL_PCT` no longer exists in `src/` (the prefix constant survives only for legacy exclusion, per plan). Migration `109_doctor_sla_events.sql` creates the table, the windowed index, and an idempotent backfill from existing token rows reusing the token id (`109:44-53`), with the naive-UTC→timestamptz conversion stated (`AT TIME ZONE 'UTC'`). `doctor_pause.js:91-98` now counts `doctor_sla_events` with the same `reason NOT LIKE 'admin\_manual%'` exclusion and window. Equivalence is proven, including the admin_manual exclusion: `tests/finance/reassignment-earnings.test.js` — "equivalence: token-row query and doctor_sla_events count the same N (incl. admin_manual exclusion)" (VERIFICATION_OUTPUT.txt:65) plus the operator-initiated-never-counts case (:64).

**`paid` at month-end, explicit action, actor stated.** `markCaseEarningsPaid` became `settleCaseEarningsOnCompletion` (`earnings_writer.js:314`) which settles the amount but leaves status `pending`; `markMonthEndPaid` (`earnings_writer.js:989`) is the **only** writer of `status='paid'`, stamping pending money rows of the given Cairo completion month across BOTH ledgers (add-ons at `:1032-1044` — same lifecycle satisfied), excluding reassign tokens, refusing future months, requiring `orders.completed_at` for main rows (an in-flight pending row can never be marked paid), idempotent, with an admin_audit trail. Who runs it is stated: Command API `POST /api/v1/admin/payouts/mark-paid` behind `requireJWT + requireRole('superadmin')`, "the operator (Ziad / finance) makes the transfers … then calls this" (`api/admin.js:4202-4217`); restated in policy doc §1.A.

**Raw INSERTs through the writer.** All three sites replaced by `writeVideoAppointmentEarning` (`earnings_writer.js:948`): `video.js` call-end (in-transaction, `client` passed) and no-show route, and `video_scheduler.js` no-show sweep (deterministic `earn-noshow-<id>` id preserved). Guard semantics identical to the raw INSERT they replace (`NOT EXISTS` pre-check + untargeted `ON CONFLICT DO NOTHING`).

**SLA breach reverses the uplift only.** `recomputeOnRefund`'s `reason='sla_breach'` branch (`earnings_writer.js:687-712`) now clamps to the base-only figure (`upliftAmount: 0`), stamps the existing `BREACH_UPLIFT_CLAWBACK` marker, and retires `sla_breach_full_clawback` for new writes. A case reassigned away (not delivered) still earns 0 through the reassignment path and the clamp preserves the 0. Proven: "recomputeOnRefund sla_breach: base fee stands — decisions table 2026-09-15" (VERIFICATION_OUTPUT.txt:55) and the c/case in the reconciliation seed (breached-but-delivered earns 600, the base).

**Copy.** The booted-doctor emails (en+ar `case-reassigned-original.hbs`) no longer promise the 10% partial pay — they state no fee is payable; the earnings page (`portal_doctor_earnings.ejs`) drops "Locked in when your report was delivered" for "Settled in a completed month-end payout", and the reassigned disclosures no longer say "partial pay".

## B3 — the two production rows (PARTIAL)

**Spec:** dry run inside `BEGIN … ROLLBACK`, **show the output**, recommendation, Ziad runs the commit; nothing in the repo writes to prod.

- No code in the repo touches the prod rows: there is no correction script on the branch, and the verification harness (`verify_batch_b.js:1-7`) explicitly targets a local scratch database (`postgresql://localhost/tashkheesa_batchb_verify`). The migration 109 backfill is additive/idempotent and B3-order-safe (`109:35-43`). Ziad-runs-the-commit is respected: `docs/BATCH_B_PROGRESS.md:13` records "awaiting Ziad's COMMIT — DONE (dry runs only)".
- A recommendation exists and is reasoned: PLAN.md:121-128 — **(b) delete** (test residue: cancelled order, demo doctor; `addon_earnings` verified empty).
- **Gap (F1 below):** the dry-run outputs themselves are not persisted anywhere in the repo. Both PLAN.md ("with full output in the report") and the progress doc ("outputs captured") *claim* the two BEGIN…ROLLBACK runs were executed via Supabase MCP, but `docs/reviews/batch-b-2026-09-21/` contains no dry-run transcript, and the "final report to Ziad" that would carry it is still PENDING. As evidence stands in the repository, "show the output" is unmet.

## B4 — report submission service (PASS)

**Spec:** a service, idempotent on a submission key, atomic (report + status + earnings all-or-nothing), thin route, signature usable by a second caller (no req/res/rendering), report exactly three fields.

- `src/services/report_submission.js` — `submitDoctorReport({ orderId, doctorId, diagnosisText, impressionText, recommendationsText, via })` (`:415`) returns a result object; no `req`, no `res`, no rendering. The three fields are the whole doctor-supplied surface (`:13-15`), with the draft fallback and the findings+impression emptiness gate.
- Atomicity: one `withTransaction` (`:550-604`) holds the conditional completion flip (`UPDATE orders … AND status <> completed`, `completeOrderInTxn`), the `report_exports` insert, the `doctor_assignments` close, the `order_events` completion event, and `settleCaseEarningsOnCompletion(orderId, doctorId, { client })` on the **same client** — all land or none do. Proven by the forced-failure test: "the transaction rolled back whole: nothing landed except the draft text, and the case is retryable" + clean retry (VERIFICATION_OUTPUT.txt:37-40).
- Idempotency: an already-completed case returns `{ ok, alreadyCompleted }` with no side effects; a concurrent race is settled by the conditional flip (loser gets rowCount 0 and writes nothing, `:559`, `:610-614`); the patient notification is post-commit and reached only by the winner. Proven sequentially AND concurrently: one report_exports row, one status change, one earnings settle, one notification (VERIFICATION_OUTPUT.txt:31-35). (See F3 on the letter of "a submission key".)
- Thin route: `handlePortalDoctorGenerateReport` (`doctor.js:6280`) is ~61 lines of validate → call → map-to-redirect; the shared helpers moved into the service and `doctor.js` imports them back (single copy). `routes/doctor.js` shrank by ~1,000 lines net.

## B5 — policy doc (PASS)

`docs/PAYOUT_AND_URGENCY_POLICY.md`: new §1.A states every row of the decisions table (pending at submit / paid at month-end via `markMonthEndPaid` run by Ziad/finance; Cairo months by completion date everywhere; reassigned earns zero, token removed, counter in `doctor_sla_events`; add-ons same lifecycle). The §4-vs-§4.A `sla_breach` contradiction is closed on the uplift-only side; the §4.A policy table now carries the delivered-late vs reassigned-away rows and marks `sla_breach_full_clawback` legacy-only; the rationale paragraph that argued for full clawback was rewritten; the audit-column example and changelog updated. A full-text scan found no surviving contradiction: tiers stay 48/18/4, uplift split stays 30/70, the 10% keep on patient/operator refunds (a different, pre-existing rule) is intact and clearly distinguished from the removed reassignment token.

## Standing constraints (PASS)

- **Three SLA tiers only (48/18/4):** unchanged in doc (§2: 48h/18h/4h) and no tier constant changes anywhere in the diff.
- **Payout structure (fixed `doctor_fee` + 30% of uplift):** `computeDoctorEarnings` untouched; new call sites pass `upliftDoctorPct: 30` (`earnings_writer.js:706-709` etc.). No percentage changed anywhere.
- **Payout mechanics (last working day, Cairo, EGP, cash/InstaPay/Shifa):** unchanged; `markMonthEndPaid` merely records that the (still manual) payout ran — the settled decision, not an invention.
- **Reassigned earns zero / Cairo months by completion:** these ARE the decisions, implemented as decided.
- **No policy invention:** everything new traces to a decisions-table row or the brief (see F5-F7 for the judgment calls that go slightly beyond the letter).

## Verification evidence (PASS, with F2)

`docs/reviews/batch-b-2026-09-21/VERIFICATION_OUTPUT.txt` exists and covers all five: (1) reconciliation — one number on five surfaces (3120 current-month, 3220 owed) with the hand-computed value and reassigned=0 on every one; (2) Cairo boundary — the 23:30/00:30 pair (same UTC day) splits on statement, series and payout run; (3) counter equivalence — via the appended `reassignment-earnings.test.js` run (lines 58-70), incl. admin_manual; (4) idempotency — sequential and concurrent; (5) atomicity — forced failure + clean retry. `verify_batch_b.js` + `verify_schema.sql` are committed, reproducible against a scratch DB, with external side effects stubbed at the module seam.

**Test baseline (independently re-run):** `env DATABASE_URL= node tests/run.js` on this branch → **1928 passed / 6 failed / 52 skipped** — matches the progress doc's claim and the A2 baseline's failing count (6), with the +1 passed from the new lint pin.

---

## Findings

### F1 — B3 dry-run outputs are not persisted in the repo — MAJOR
**Spec:** B3: "Dry run inside `BEGIN … ROLLBACK`, show the output, Ziad runs the commit." Brief: "two dry runs (zero vs delete) BEGIN…ROLLBACK **with output**, recommendation, Ziad commits."
**Evidence:** `docs/reviews/batch-b-2026-09-21/` contains PLAN.md, VERIFICATION_OUTPUT.txt, verify_batch_b.js, verify_schema.sql — no dry-run transcript. PLAN.md:123 promises "full output in the report"; `docs/BATCH_B_PROGRESS.md:13` says "outputs captured"; the final report is PENDING. The recommendation ((b) delete) and the prod-state recon (2 rows, addon_earnings empty) are recorded, and nothing in the repo writes to prod — but the shown-output requirement is currently satisfied only by claim.
**Required:** persist both dry-run transcripts (or include them verbatim in the final report to Ziad before he runs the COMMIT). Until then B3 is PARTIAL.

### F2 — VERIFICATION_OUTPUT.txt has no numbered section 3 — MINOR
**Spec:** verification list item 3 is the pause-counter equivalence.
**Evidence:** the file jumps from "── 2 ──" to "── 4 ──"; `verify_batch_b.js:227-228` notes the equivalence runs in `tests/finance/reassignment-earnings.test.js`, whose output IS appended (lines 57-70) and includes the exact equivalence assertion with the admin_manual exclusion. The proof exists; only the presentation deviates — a reader scanning for "3." could think it missing, and the evidence is a test-pass line rather than a printed old-count-vs-new-count pair.
**Suggested:** a one-line pointer at the section-3 position in the output file.

### F3 — "idempotent on a submission key" is implemented as a conditional status flip — NOTE
**Spec (brief):** "make it idempotent on a submission key."
**Evidence:** there is no submission-key column/token; the idempotency gate is the conditional completion UPDATE on `orderId` (`report_submission.js:34-42`, `:559`) — the winner owns every irreversible side effect. For a case with exactly one live submission path this is equivalent in effect, and the double-submit and concurrent-race proofs pass. It does not distinguish two *different* reports racing (both would be "the submission" for that order) — acceptable for the stated goal (double submit must not double-write/re-notify), but it is the letter-vs-spirit deviation worth recording.

### F4 — Plan/implementation naming drift on one reader function — NOTE
PLAN.md names `getDoctorRecentCaseFees(doctorId, {limit})`; the implementation is `getCaseFeesForOrders(doctorId, orderIds)` (`analytics.js:353`). Same job (per-case main-row fee via the reader, A4 redaction kept in the route); no spec impact.

### F5 — `markMonthEndPaid` future-month guard and audit row — NOTE (beyond spec, safe)
The future-month refusal (`earnings_writer.js:993-1001`) and the `error_logs` admin_audit entry are not in the spec. Both are protective/observational; neither changes policy.

### F6 — the reassignment `already_paid` guard now bites later — NOTE (consequence of spec, documented)
Because `paid` is no longer stamped at submit, `markReassignedOnReassignment`'s no-clawback-after-paid guard (`earnings_writer.js:866-873`) now protects only money finance actually settled; a delivered-but-not-yet-paid-out row would be zeroed by a reassignment. The code comment states this is deliberate ("which is the point"), and a completed case is not reassigned in practice. Consistent with "reassigned earns zero"; recorded because it is a behavioural shift relative to the old guard's timing.

### F7 — `doctor_pause.js` admin_manual exclusion carried forward — NOTE
The exclusion pre-dates Batch B (AUDIT-2026-08-22) and the brief explicitly required preserving it ("including the admin_manual exclusion"); the backfill retro-applies it to Command-era events. Spec-conformant.

### F8 — reader hard-zeroes `reassigned_total` in the monthly statement — NOTE
`getDoctorMonthlyStatement` returns `0::float8 AS reassigned_total` by construction (`earnings_reader.js:158`) while exposing `reassigned_count`; the page's legacy-adjustment disclosure now keys off count. Belt-and-braces against legacy token amounts, aligned with "reassigned earns zero".

---

## Summary

Batch B implements the specification faithfully. B1, B2, B4 and B5 PASS on direct code evidence: one reader module with all ~14 aggregation sites converted and an independent grep finding no residual aggregation SQL; the token writer removed with the pause counter re-homed and proven equivalent (admin_manual included); `paid` moved to an explicit, superadmin-gated month-end action with add-ons in the same lifecycle; all three raw video INSERTs routed through the writer; the SLA-breach settlement corrected to uplift-only; an atomic, idempotent report-submission service behind a ~61-line route; and a policy doc that now states the decisions table and no longer contradicts itself. Standing constraints are intact (tiers 48/18/4, 30% uplift share, fixed doctor_fee, payout mechanics, no invented policy), the five verifications are evidenced and reproducible, and the no-DB suite was independently re-run at 1928/6/52 (baseline failing set size unchanged). The single substantive gap is B3: the two BEGIN…ROLLBACK dry runs are claimed and their recommendation recorded, but their outputs are not persisted anywhere in the repository — "show the output" must be satisfied (in the review directory or the final report) before Ziad runs the COMMIT. One MAJOR (F1), two MINOR-or-below presentation items, and five NOTEs; no BLOCKER.
