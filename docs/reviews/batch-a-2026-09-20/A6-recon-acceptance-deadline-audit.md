# A6 recon — acceptance-deadline audit (2026-09-20)

Produced by a read-only exploration agent against the worktree at fix/launch-gates-routing-revocation (= origin/main 0787acbb4). Feeds the A6 implementation; every claim carries file:line.

## Headline

**Item 1 (single source) — CLEAN.** No inline or hardcoded acceptance duration survives in src/. Every assignment writer resolves minutes through src/acceptance_window.js, directly or via acceptByIsoForOrder. The violations are all about WHICH columns get written and what happens when a write FAILS.

## Writers

Compliant (both columns, one value, via acceptance_window):
- W1 case_lifecycle.assignDoctor (case_lifecycle.js:3059-3060 → orders :3073/:3097, doctor_assignments :3102-3119) — but see P0 below.
- W2 workers/acceptance_watcher.autoAssignOrder (:398-404, :461-463) — the only writer that ROLLS BACK the claim when the mirror INSERT fails (:478-490).
- W3 routes/api/admin.js POST /cases/:id/assign (:1905-1914, same txn).
- W4 services/admin_bulk_assign.js (:193-203, per-case SAVEPOINT).

Single-column, justified (pool cases, no assignment row exists): notify/broadcast.js:132-142; acceptance_watcher no-doctor backoff :361-368; case_lifecycle.reassignCase(id,null) retry marker :3318-3330. The latter two OVERLOAD acceptance_deadline_at as a retry timer (P2 below).

## ⚠ Violations, ranked

- **P0 — case_lifecycle.js:3120-3122: assignDoctor's doctor_assignments INSERT is inside `catch (e) { /* table may not exist */ }`.** On any failure the case is ASSIGNED with doctor_id and orders.acceptance_deadline_at set but NO assignment row → invisible to all three sweeps → never times out, zero telemetry. Identical anti-pattern already removed from acceptance_watcher (:419-427) and answered with a rollback. assignDoctor backs auto-assign, force-assign, both reassign routes, both manual-queue approves, and the doctor broadcast-accept.
- **P0 — routes/superadmin.js:5491-5498: POST /superadmin/orders/:id/reassign is a bare doctor_id UPDATE.** No acceptance_deadline_at, no doctor_assignments row, no finalizePreviousAssignment, no clock reset, no partial-pay. The admin route (routes/admin.js:2138-2159) and Command route (routes/api/admin.js:1810-1846) document this exact bug as fixed; the superadmin web route was missed. Never-expires + double-pays the outgoing doctor + old doctor keeps the case against capacity.
- **P1 — legacy NULL accept_by_at rows: report-only, nothing backfills.** case_sla_worker.js:1062-1102 logs hourly; no migration or script backfills (migrations grep: 014 adds the column, 081 retypes it, nothing else). Deliberate (backfill would fire a partial-pay clawback burst — :66-87). scripts/seed_demo_doctor.js:339 still mints new rows of this shape.
- **P1 — assignDoctor commits doctor_id (:3032-3036) ~3 awaits before either deadline write.** Callers that do NOT release the claim on throw: routes/admin.js:2359 force-assign, routes/doctor.js:3583 accept, case_sla_worker.js:614 handleDoctorTimeout.
- **P1 — sweep blind spots:** stranded-paid sweep requires paid_at NOT NULL (case_sla_worker.js:701) and paid_at >= 2026-09-15 (:702); acceptance_watcher requires acceptance_deadline_at NOT NULL (:58). A paid case with NULL paid_at (the defect superadmin.js:2461-2469 records) is invisible to every sweep forever. markCasePaid fires the broadcast fire-and-forget (case_lifecycle.js:2465-2467), so the NULL-deadline shape is routine after a transient failure.
- **P2 — semantic overload:** acceptance_watcher :363 and case_lifecycle :3325 write a RETRY timestamp into acceptance_deadline_at; portal_doctor_dashboard.ejs:81-89 renders it to doctors as "accept within Xm".
- **P2 — reader split:** dashboard + cases list read orders.acceptance_deadline_at (portal_doctor_dashboard.ejs:81-89, portal_doctor_cases.ejs:45-52); the case page reads doctor_assignments.accept_by_at (routes/doctor.js:2882-2905). Same number whenever both columns are written; diverges exactly on the violations above.
- **P2 — manual-queue finalize-failure** (superadmin.js:2946-2999, api/admin.js:3713-3745): if the release UPDATE also fails/matches 0 rows, doctor_id stays with no handshake; self-documented as not automatically recoverable.
- **P3 — doctor_id '' vs NULL:** case_sla_worker.js:470 uses bare IS NOT NULL; :703 and acceptance_watcher :57 use NULLIF(doctor_id,''). A row with doctor_id='' is unassigned to two sweeps and assigned to the third.
- **P3 — operator-created orders** (superadmin.js:2447-2504) stamp accepted_at for an acceptance that never happened, no deadline columns.
- **P3 — dead writer:** db.js:689-697 acceptOrder (no deadline handling) imported at routes/doctor.js:4 and never called.

## Sweep WHERE clauses (for the miss analysis)

- Sweep A (acceptance_watcher:42): doctor_id NULL/'' AND acceptance_deadline_at NOT NULL AND past AND status IN (pending,available,submitted,new,paid,reassigned) AND payment paid/captured.
- Sweep B (fetchDoctorTimeouts case_sla_worker:435): status='assigned' AND doctor_id NOT NULL AND accepted_at NULL AND latest OPEN assignment row exists AND accept_by_at NOT NULL AND past.
- Sweep C (fetchStrandedPaidCases :694): status='paid', paid/captured, doctor_id NULL/'', acceptance_deadline_at NULL, assignment_status not manual_*, paid_at NOT NULL AND >= 2026-09-15 AND < now-10m, not parked.

Anything with a doctor and no open+dated assignment row is missed by all three.

## A6 disposition (this session)

- Item 1 (single source): verified clean — no change needed.
- Item 2 (both columns): fix superadmin reassign by routing through caseLifecycle.reassignCase (copy the routes/admin.js pattern).
- Item 3 (never-expiring path): close at the source — assignDoctor stops swallowing the assignment-row INSERT failure (rollback + loud failure, acceptance_watcher pattern). Legacy NULL-accept_by_at backlog stays report-only per the documented clawback-burst rationale; prod count to be read (Supabase MCP, SELECT-only) and put in front of Ziad.
- Found-not-fixed (recorded for follow-up): claim-before-deadline windows (P1), sweep blind spots (P1), retry-timer overload rendered as a countdown (P2), manual-queue finalize-failure (P2), ''-vs-NULL doctor_id (P3), operator-created accepted_at fabrication (P3), dead acceptOrder (P3), seed script shape (P3).
