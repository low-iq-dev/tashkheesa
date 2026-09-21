# Batch B implementation plan — earnings ledger and the report path

Branch `fix/earnings-ledger-and-report-service`, cut from origin/main @ 4283395b7.
Spec: `docs/FIX_PLAN_2026-09-15.md` (Decisions table + Batch B) plus the CC brief.
Test baseline: 1927 passed / 6 failed / 52 skipped (no-DB run), plus 214 untallied
node:test `✖` lines from the separate node:test harness. Neither may regress.

## Recon findings that shape the design

1. **Three row kinds live in `doctor_earnings`**, distinguished only by id prefix:
   - `earn-main-%` — main-case fee rows; `appointment_id` holds the ORDER id.
   - `earn-reassign-%` — the 10% reassignment token rows (B2 removes the writer).
   - everything else (`earn-<uuid>` from routes/video.js, `earn-noshow-<id>` from
     video_scheduler.js) — standalone video-appointment earnings; `appointment_id`
     holds the APPOINTMENTS id. Real money, deliberately counted by Command
     /payouts (api/admin.js:4162 comment) and therefore by the new reader.
2. **`addon_earnings` uses integer EGP + timestamptz** — no timezone conversion
   or float rounding needed there. Only `doctor_earnings` is naive-UTC + double.
3. **The earnings row for a main case is written at ACCEPTANCE**, not completion
   (`writePendingForCase`, doctor.js:3834). So `created_at` on a main row is the
   acceptance date. "Month by completion date" therefore needs
   `orders.completed_at` (timestamptz since migration 081) joined via
   `appointment_id` for `earn-main-%` rows, falling back to the row's
   `created_at` for rows whose order has not completed yet (in-flight pending)
   and for video rows (written at the completion moment itself).
4. **`recomputeOnRefund`'s `reason='sla_breach'` branch zeroes the BASE fee**
   (full clawback at refund mark-paid), and policy doc §4.A codifies it — while
   §4/Example D and the settled decisions table say the SLA breach reverses the
   urgency uplift only, base stands if the doctor delivers. Code and doc both
   change (decisions table wins). The delivered-late doctor keeps the base.
   A case reassigned away (not delivered) still earns 0 via the reassignment path.
5. **prod DB**: exactly 2 `doctor_earnings` rows (the demo-doctor pair on the
   cancelled order), `addon_earnings` EMPTY. Confirmed via Supabase MCP.
6. Aggregation sites found (beyond the brief's list): `admin.js:1171/:1174` (web
   admin dashboard tiles), `superadmin_dashboard.js:740-755` (doctor leaderboard
   owed), `video.js:2321-2331` (video dashboard stats — sums the WHOLE ledger
   with a UTC month and no prefix/status discipline), `video.js:946/:1705`
   (single-row per-appointment lookups — not aggregations, left as row fetches).
   Raw INSERTs besides video_scheduler.js:142: `video.js:1506` and `video.js:1851`
   (both inside withTransaction) — all three move into earnings_writer.

## B1 — `src/services/earnings_reader.js`

One module owning the four things every caller currently gets differently:

- **Kind discipline**: exported SQL fragments `KIND_MAIN`, `KIND_REASSIGN_TOKEN`,
  `KIND_VIDEO` (id-prefix predicates). Money sums always EXCLUDE
  `earn-reassign-%` rows (their policy amount is 0; excluding is belt and braces
  against legacy nonzero tokens).
- **Status semantics** (post-B2): `pending` = owed (awaiting month-end payout);
  `paid` = settled by the month-end payout run; `reassigned` = earns 0, never
  counted as owed or earned. This kills the doctor.js:377 "Not yet approved
  includes reassigned" defect.
- **Cairo month by completion date**: month expression =
  `COALESCE(orders.completed_at, de.created_at::timestamptz) AT TIME ZONE 'Africa/Cairo'`
  for main rows (LEFT JOIN orders ON o.id = de.appointment_id, main-prefix only),
  `de.created_at::timestamptz AT TIME ZONE 'Africa/Cairo'` for video rows,
  `ae.created_at AT TIME ZONE 'Africa/Cairo'` for add-ons. The `::timestamptz`
  cast (session pinned UTC) is the house form for naive columns (api/admin.js
  guard-13 note).
- **Money**: one `money()` (Number → round to piastres) applied to every figure.

Functions (all built over shared fragments; every converted caller uses one):
- `getDoctorMonthSummary(doctorId)` — current-Cairo-month approved/not-yet-approved across both ledgers (dashboard tile).
- `getDoctorMonthlyStatement(doctorId, {limitMonths})` — per-Cairo-month main+addon buckets (earnings page).
- `getDoctorLifetimeTotals(doctorId)` — lifetime paid/pending/reassigned splits (earnings page).
- `getDoctorTotalEarned(doctorId, {fromDate})` — pending+paid, kind-disciplined (analytics headline, video stats).
- `getDoctorMonthlySeries(doctorId, {fromDate})` — Cairo-month series (analytics chart).
- `getDoctorRecentCaseFees(doctorId, {limit})` — recent cases with the per-case main-row fee (analytics table; keeps A4 redaction in the route).
- `getMostRecentPaidEarning(doctorId)` — payout tile.
- `getOwedByDoctor({limit})` — per-doctor owed/paid-this-month rows + oldest-unpaid (Command /payouts, superadmin dashboard payouts ledger).
- `getGlobalOwedTotals()` — whole-table owed splits (web admin tiles, /payouts totals).
- `getOwedForDoctorIds(ids)` — per-doctor owed map (superadmin leaderboard merge).
- `getClawbackSummaryByPolicy({fromCairoSql})` — the breach-cost clawback derivation moves here beside the rest.

Converted callers: doctor.js:369, :815, :1428/:1458/:1488; analytics.js:303/:317/:340;
admin.js:1171/:1174; api/admin.js /payouts (:4193) and /breach-cost (:3127);
superadmin_dashboard.js:565 and :740; video.js:2321. No caller keeps its own SQL.

NOT converted (single-row lookups, not aggregations): video.js:946, :1705.
`earned_amount` stays DOUBLE PRECISION — a type migration has its own blast
radius and is explicitly out of scope (brief B1.4); rounding is centralised instead.

## B2 — ledger/policy alignment

1. **Counter re-home**: new table `doctor_sla_events` (migration 109):
   `(id, doctor_id, order_id, reason, created_at timestamptz)`. Written exactly
   where the token used to be written (same guards: main row exists, not already
   paid, idempotent per (doctor, order)). Backfill in the migration from existing
   `earn-reassign-%` rows so the count is identical at cutover.
   `doctor_pause.js` counts `doctor_sla_events` with the same
   `reason NOT LIKE 'admin\_manual%'` exclusion and window. Chosen over (a) case
   status (reassignment ≠ one case status, windowed per-doctor count awkward) and
   (b) marker rows in the money ledger (the pollution this batch removes).
2. **`markPartialPayOnReassignment` → `markReassignedOnReassignment`**: same
   transaction shape and guards; flips the main row to `reassigned`/0/0 with the
   reason; INSERTs the `doctor_sla_events` row in the same transaction; writes NO
   token row. `REASSIGN_PARTIAL_PCT` deleted. The `earn-reassign-%` prefix
   constant survives only for legacy-row exclusion in the reader and the
   re-open zeroing paths (which stay, defending against legacy tokens).
3. **`paid` at month-end**: `markCaseEarningsPaid` becomes
   `settleCaseEarningsOnCompletion(orderId, doctorId, client?)` — identical
   recompute/clawback-preservation/reopen logic, but the row settles at
   status `pending` (paid_at untouched). New
   `markMonthEndPaid({ month, doctorId?, actor })` stamps `status='paid',
   paid_at=NOW()` on pending rows whose Cairo completion month = `month`
   (both ledgers). Trigger: Command API `POST /api/v1/admin/payouts/mark-paid`
   (superadmin JWT), run by Ziad/finance after the InstaPay/cash transfers on
   the last working day of the month.
4. **Add-ons**: same lifecycle — already pending on delivery; `markMonthEndPaid`
   covers `addon_earnings` too.
5. **Raw INSERTs through the writer**: new
   `writeVideoAppointmentEarning({..., client?})` in earnings_writer; the three
   sites (video_scheduler.js:142, video.js:1506, video.js:1851) call it.
6. **SLA-breach refund settlement**: `recomputeOnRefund` `reason='sla_breach'`
   now clamps to the base-only figure (uplift share reversed; base stands),
   stamping the existing `BREACH_UPLIFT_CLAWBACK` marker. The
   `sla_breach_full_clawback` policy string is retired for new writes;
   /breach-cost keeps deriving legacy rows that carry it.

## B3 — the two production rows

Both dry runs (BEGIN…ROLLBACK) executed via Supabase MCP with full output in the
report: (a) zero the token row's earned_amount; (b) delete both rows.
Recommendation: **(b) delete** — test residue (cancelled order, demo doctor,
non-UUID doctor_id on the order), and it starts the ledger verified-empty before
the new aggregation. `addon_earnings` verified empty — nothing to correct there.
Ziad runs the COMMIT.

## B4 — `src/services/report_submission.js`

`submitDoctorReport({ orderId, doctorId, fields, via })` → result object; no
req/res/rendering. The web route validates, calls, maps result → redirect.
Phase-1 app endpoint will call the same function.

Order of operations:
1. Load + authorize (assigned doctor only). Already-completed → `{ ok, alreadyCompleted }` with NO side effects (idempotent result).
2. Resolve the three fields with the draft fallback (the report is exactly findings/impression/recommendations).
3. Persist text draft-shaped (outside the transaction, so a later failure never loses the report).
4. Emptiness check (findings + impression required).
5. Render the PDF to R2 (outside the transaction; on failure the case stays open with text saved).
6. Best-effort IN_REVIEW bookkeeping transition (unchanged semantics).
7. **One transaction**: conditional completion flip
   (`UPDATE orders … WHERE id=$1 AND status <> completed` — rowCount 0 ⇒ a
   concurrent submit won; return alreadyCompleted, write nothing else),
   report text+URL columns, `report_exports` insert, `doctor_assignments`
   close, `order_events` completion event, and
   `settleCaseEarningsOnCompletion(client)` — all land or none do. This
   conditional flip IS the idempotency gate for every irreversible side effect.
8. Post-commit best-effort: CASE_COMPLETED case event, medical_records copy,
   prescription add-on settlement (own idempotency via unique index), patient
   notification (exactly once, because only the winning submit reaches here).

Helpers move from doctor.js into the service (single copy; doctor.js imports
back): schema probes (orders columns, 3 report-column pickers),
buildCombinedReportText, buildReportDraftFields (+ readDiagnosisFromOrder,
parseCombinedNotesToFields), isReportSectionEmpty, computeAgeFromDob,
reportGenderLabel, persistReportText, the completion writer,
ReportSchemaUnresolvedError, rx_doctorFallback.

## B5 — policy doc

State the decisions table; fix §4.A's `sla_breach` full-clawback row (the
contradiction with §4/Example D), restate `paid`-at-month-end, reassigned-earns-0,
Cairo months by completion date. Update §4.A's table to the new settlement.

## Verification

1. Reconciliation on a scratch Postgres schema (local PG): seed the brief's mix
   (completed, uplifted, breached, reassigned, video add-on, rows either side of
   a Cairo month boundary); show dashboard-tile, earnings-page, Command-finance
   and analytics numbers all equal, next to the hand-computed value.
2. Cairo boundary: 23:30 Cairo last-of-month vs 00:30 first-of-month land in
   different months on every surface.
3. Pause counter: old query vs doctor_sla_events count equal for the same
   doctor, including the admin_manual exclusion.
4. Idempotency: double submit → one report_exports row, one status change, one
   earnings settle, one notification.
5. Atomicity: forced status-flip failure → nothing landed.
Plus: no-DB suite tally and node:test ✖ count unchanged vs baseline.
