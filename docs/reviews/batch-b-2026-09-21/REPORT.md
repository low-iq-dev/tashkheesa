# Batch B — final report: the earnings ledger and the report path

Branch `fix/earnings-ledger-and-report-service`, cut from origin/main @
`4283395b7`. **Not pushed, not merged.** 13 commits. Full review round run:
implementer → spec review (SPEC_REVIEW.md) → independent adversarial review
(ADVERSARIAL_REVIEW.md, reviewer isolated from the implementer's reasoning) →
fix round (FIX_ROUND.md, every finding fixed or dispositioned).

## Tests

- **Before:** 1927 passed / 6 failed / 52 skipped (no-DB run; the same 6
  pre-existing failures as A2's baseline).
- **After:** 1928 passed / 6 failed / 52 skipped — the failing set is
  **byte-identical to the baseline**. Zero failures added.
- The suite also prints ~214 `✖` lines from node:test-based files; these are
  a pre-existing runner artifact (the files pass standalone — verified — and
  their results never reach the tally). Count unchanged. Flagged under
  "found beyond the brief" below.

## What changed (one line per commit)

| Commit | What |
|---|---|
| 3fb4d24c1 | B2 writers: reassigned earns zero (token writer removed, counter → doctor_sla_events, migration 109), paid = month-end (`settleCaseEarningsOnCompletion` + `markMonthEndPaid`), sla_breach refund → uplift-only, video INSERTs through the writer, booted-doctor email honest (en+ar). New `earnings_reader.js`. |
| c61b3de87 | B1: all fourteen-plus aggregation sites call the reader; new `POST /api/v1/admin/payouts/mark-paid`. |
| c68121061 | B1 test fix-ups: pins moved to the reader discipline. |
| 65afd7481 | B2 copy: earnings page states the new lifecycle; no partial-pay promise anywhere. |
| 0d2397087 | B4: `report_submission.js` — atomic, idempotent submission service; 390-line handler → thin route. |
| c555daefa | B5: policy doc states the decisions table, contradiction closed uplift-only. |
| df7143ecd | Verification harness + evidence (scratch prod-faithful Postgres). |
| 35b079de0 / 55e860fec / b588777e6 | Progress ledger; B3 transcripts + spec review persisted; equivalence printed side-by-side. |
| 426e78caa | The fix round (see below). |

## The dozen-plus aggregations — full list, and where each went

Every site now calls `src/services/earnings_reader.js`; **no caller keeps its
own SQL** (independently re-grepped by the spec reviewer: zero residual
aggregation SQL over either ledger outside reader/writer).

| Old site | Was wrong because | Now calls |
|---|---|---|
| doctor.js:369 (dashboard tile) | server-TZ month; **counted `reassigned` as "Not yet approved"** | `getDoctorMonthSummary` |
| doctor.js:821 (payout tile) | own join | `getMostRecentPaidEarning` |
| doctor.js:1428 / :1457 / :1490+ (earnings page ×3) | `created_at` months (= acceptance date), server TZ | `getDoctorMonthlyStatement`, `getDoctorLifetimeTotals` |
| analytics.js:304 | **no status, no kind filter — counted the 10% token as earnings** | `getDoctorTotalEarned` |
| analytics.js:317 | UTC calendar months by creation date | `getDoctorMonthlySeries` |
| analytics.js:340 | any-row join could surface the token as "the fee" | `getCaseFeesForOrders` |
| admin.js:1171/:1174 (web admin tiles) | two raw sums | `getGlobalOwedTotals` |
| api/admin.js:4238ff (Command /payouts) | **excluded `reassigned` — did not see the 32** | `getOwedByDoctor` + `getGlobalOwedTotals` |
| api/admin.js:3138 (/breach-cost clawback) | inline derivation; **90% arm matched a string the writer never stamps → 0 EGP** | `getClawbackSummaryByPolicy` (both strings) |
| superadmin_dashboard.js:565 (finance card) | LEFT-JOIN copy | `getOwedByDoctor({limit:6})` |
| superadmin_dashboard.js:740-755 (leaderboard) | four correlated subqueries | `getOwedForDoctorIds` merge |
| video.js:2321/:2327 (video dashboard, brief missed) | whole-ledger sums, UTC month, no status filter | `getDoctorTotalEarned` + `getDoctorMonthSummary` |
| video.js:946/:1705 | single-row per-appointment lookups — **left as row fetches** (not aggregations) |

The production row that gave three answers now gives one: `reassigned` earns
0 on every surface (proven live in the reconciliation below).

## The reconciliation (verification step 1 — VERIFICATION_OUTPUT.txt §1)

Seeded mix on a prod-faithful scratch Postgres: standard 600, VIP 870
(600+270), breached-but-delivered 600 (uplift reversed, base stands),
reassigned 0, video add-on 850, and a Cairo-boundary pair (100 / 200).

| Surface | Figure | Value |
|---|---|---|
| hand-computed | current-Cairo-month pending | **3120** = 600+870+600+850+200 |
| dashboard tile | notYetApproved | **3120** ✓ |
| hand-computed | owed overall | **3220** = 3120+100 |
| earnings page lifetime | pending | **3220** ✓ (reassigned = 0) |
| Command finance | owed (2370 cases + 850 addons) | **3220** ✓ |
| web admin tile | owedTotal | **3220** ✓ |
| doctor analytics | total earned | **3220** ✓ |

**The Cairo boundary (step 2):** 23:30 Cairo Aug 31 (20:30Z) and 00:30 Cairo
Sep 1 (21:30Z) share a UTC day; the statement, the analytics series and the
payout run all split them — `markMonthEndPaid('2026-08')` stamps exactly the
100, re-running stamps 0.

**Idempotency (step 4):** the same report submitted twice, sequentially AND
concurrently: one `report_exports` row, one status change, one earnings row
(settled `pending`), one patient notification.

**Atomicity (step 5):** with a trigger failing the status flip, the whole
transaction rolls back — no export row, no event, assignment open, earnings
untouched, no notification; only the draft text survives (by design) and the
retry completes cleanly.

## The pause counter (B2) — how it was re-homed, and the proof

The token row's second job moved to **`doctor_sla_events`** (migration 109):
one row per reassignment-away event, written by
`markReassignedOnReassignment` in the same transaction that zeroes the main
row, under the same guards the token had (no row → no event; already paid →
no event; per-(doctor, order) idempotency; a genuine second reassignment
after a come-back records a second event, as the old code minted a second
token). The reason is stored verbatim, so `doctor_pause.js`'s
**`admin_manual` exclusion is preserved** — operator-initiated reassignment
still never pauses a good doctor. Chosen over the case status (reassignments
have many reasons; windowed per-doctor counting is awkward) and over marker
rows in the money ledger (the pollution this batch removes).

**Proof (step 3, §3 of the output):** the retired token-row query and the new
events query return the same N for the same doctor — 1 === 1, with an
admin_manual event excluded from both. Migration 109 backfills events from
existing token rows (idempotent across Render boots; correct-instant
timezone conversion — proven on a second scratch DB).

## The month-end `paid` stamp — trigger and operator

`paid` now means *finance settled the month*. The only writer is
`earnings_writer.markMonthEndPaid`, exposed as **`POST
/api/v1/admin/payouts/mark-paid`** (superadmin JWT — Command app). **Who runs
it: Ziad/finance**, after making the cash/InstaPay/Shifa transfers off GET
/payouts on the last working day of the month, with body `{ month:
'YYYY-MM', doctorId? }`. Idempotent; future months refused; in-flight
(undelivered) rows can never be stamped; after the fix round the /payouts
screen shows `owedSettleableEgp` (what the stamp will settle — **the figure
to transfer**) vs `owedInFlightEgp`.

## B3 — recommendation and dry runs

Both dry runs executed via the Supabase MCP inside `BEGIN … ROLLBACK`; full
SQL + verbatim outputs in **B3_DRY_RUNS.md**. (a) zeroing the token leaves 2
rows totalling 0; (b) deleting both leaves the ledger empty; `addon_earnings`
is already empty; the order row is untouched either way.

**Recommendation: (b) delete both rows.** They are test residue — a cancelled
order (never completed), held by the marketing-demo account, with a non-UUID
doctor id on the order — and deletion starts every new aggregation against a
verified-empty ledger. Safe in either deploy order. **Ziad runs the COMMIT**
(re-issue the chosen block with COMMIT in place of ROLLBACK).

## Review round results

- **Spec review:** no blockers; B1/B2/B4/B5 PASS on direct evidence; the one
  MAJOR (B3 outputs not persisted) fixed.
- **Adversarial review:** no blockers; 2 MAJOR + 5 MINOR, **all fixed** (the
  /payouts settleable split; the delivered-case reassignment guard + atomic
  doctor_id recheck; the /breach-cost clawback string; the policy doc enum;
  the mark-paid status recheck; the full status vocabulary on the completion
  guards; the stale-loser text protection) — plus 16 NOTEs dispositioned.
  Everything else it probed (Cairo conversions, migration backfill,
  equivalence edge cases, refund clamps, Command JSON shape, template
  variables, authz) came back clean. Details in FIX_ROUND.md.

## Found beyond the brief

1. **`recomputeOnRefund`'s `sla_breach` branch zeroed the base fee** —
   policy-doc §4.A's side of the contradiction the decisions table settled
   against. Changed to the uplift-only clamp (base stands if delivered);
   `sla_breach_full_clawback` survives only as a legacy audit value.
2. **/breach-cost's 90% clawback arm has silently reported 0 EGP since
   2026-08-17** (string drift `…90pct_clawback` vs `…scaled_90pct_clawback`)
   — pre-existing on main, found by the adversarial review, fixed here.
3. **Two more raw `doctor_earnings` INSERTs** in video.js (:1506 call-end,
   :1851 no-show mark) beyond the scheduler one the brief named — all three
   now go through the writer; the scheduler's raw form could double-pay an
   appointment that already had a call-end row.
4. **The booted-doctor email promised "10% partial pay"** (en+ar) — now
   states plainly that a reassigned case carries no fee.
5. **The earnings-page copy denied a settlement run exists** ("approval is
   not a transfer") — B2 built exactly that run, so the footnote/tiles now
   state the real lifecycle. Note the "Approved" label now *understates*
   (paid = money actually moved); safe direction, flagged if Ziad wants a
   stronger word later.
6. **The node:test ✖ harness artifact:** ~30 test files use node:test inside
   tests/run.js's require() runner; mid-suite their tests abort sub-millisecond
   and are never tallied (they pass standalone). Same family as the known
   CI-runner masking issue; worth its own fix next cycle.
7. **/payouts "owed" vs what month-end can settle** (adversarial M-1) — the
   operator-facing gap created by moving `paid` to month-end; closed with the
   settleable/in-flight split.
8. One suite-order **flake** in tests/admin/kpi-payload-parity (port/timing;
   did not reproduce across three subsequent full runs).

## Stopping here, per the brief

Nothing pushed, nothing merged. Awaiting: Ziad's B3 choice + COMMIT, and
approval to push the branch.
