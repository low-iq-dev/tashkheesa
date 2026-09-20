# Batch A fix round — 2026-09-20

Disposition of every spec-review (S*) and adversarial-review (X*) finding. FIXED = changed in the fix-round commit; DECLINED = deliberate, with the rationale; REPORTED = real, out of this batch's scope, in the batch report for Ziad.

## Fixed

- **A4/S1 + X3 (blocker)** — tier (7) and capacity (8) conjuncts scoped to POOL offers, mirroring the specialty conjunct and the accept handler; AND the load count now excludes the case being decided (`countActiveCasesForDoctor(doctorId, excludeOrderId)`, used by both the view gate and accept Guardrail 4). An assignee can always open the case that filled their last slot, and accepting it no longer trips the overflow reassign. Pinned: exposure guard "tier and cap do NOT take back an ASSIGNED offer", account-gates source pin on the exclusion.
- **A4/S2 + A5/S2** — resolved by the same scoping: viewing and accepting now draw the SAME line (pool offers pass specialty+tier+capacity; assigned offers pass the account rule only). The routed-VIP-case-invisible-to-its-own-doctor state is gone.
- **X6** — the accept-refusal copy now rides the denial screen: renderAccessDenied passes the ?msg=-derived message as errorMessage and the template renders it above the generic denial body, so a paused/out-of-tier/at-cap/unroutable bounce names its reason instead of "the patient cancelled it". (The direct-view denial without a ?msg= stays generic — c30c0d7's "do not widen the refusal" ruling.)
- **A5/S1** — a no-specialty pool case refuses with its own `?msg=case_unroutable` + bilingual copy ("operations needs to route it"), not the misleading update-your-profile specialty copy. Guard updated.
- **X1** — superadmin reassign: an UNASSIGNED order now goes through `assignDoctor` (first assignment — this page is the documented human fallback for manual_pending parking) and only a held case goes through `reassignCase`; failures surface as `?error=reassign_failed` / `?error=reassign_ineligible`, rendered by the order page's existing flashError banner (the old `?reassign=` spelling rendered nowhere). Guard drives all three paths.
- **X2** — reason is now `admin_manual_superadmin` (matches doctor_pause's admin_manual% exclusion) AND `operatorInitiated: true` is passed — an operator reassign can no longer feed the auto-pause counter. Pinned in the guard.
- **A6/S1** — the seed script derives accept_by_at from acceptance_window (tier-aware) and the A6 guard now covers scripts/seed_demo_doctor.js, including a ban on the literal it shipped with.
- **A6/S6** — the rollback's status fallback is canonical 'PAID'.
- **X9 + A6/S4** — auto_assign's release recognises ASSIGNMENT_ROW_FAILED with rolledBack and logs the truth ("already released by case_lifecycle's rollback") instead of "left in place deliberately"; its stale before-transitionCase comment corrected.
- **X10** — the A6 guard stubs messaging/notify/audit, so it no longer reaches a real pg connection and dies after its passes; clean exit standalone.
- **A4/S7** — src/services/doctor_case_access.js and src/routes/doctor.js added to the urgency-tier lint's ALLOWED (both use the sanctioned urgency_tier-first fallback); the lint is back to exactly its two pre-existing baseline hits.
- **X13** — the exposure guard's leak filter is location-scoped again: the question is blanked at its two sanctioned paths (order.clinical_question, clinicalContext.question) and the full-secret scan runs unfiltered, so a third copy anywhere in the payload trips it.
- **X14 + A7/S2** — the receipt claims a tier name only on an exact sla_hours match (4/18/48); any other value prints its own real number, so the receipt can never promise a window shorter than the case's SLA.
- **A7/S3** — addon_purchased_urgency says "Urgent turnaround has been added" / "تمت ترقية حالتك إلى المراجعة العاجلة" (was the retired "Priority").
- **A7/S4** — the dashboard KPI predicates count fast_track with VIP, matching the display maps.
- **A7/S5** — emailService's VIP band tightened to <= 18.
- **A7 guard gap + A8/S5** — new tests/lint/batch-a-copy-pins.test.js pins every A7 string fix and the A8 signature block on both generators.
- **X12 + A8/S2** — the signature subline uses sectionHeader's captured-y pattern; both halves share one baseline, the rule offset no longer depends on the Arabic font resolving, and the font restore moved outside the try.
- **X11 (mitigated)** — the raw-PDF fallback's subline is English-only (the second grey box read as redaction anyway) and the block's growth trimmed to 10pt net; the path's missing pagination is pre-existing and REPORTED.
- **X7** — previewCaseEarnings uses the shared loadEarningsOrderRow (the same snapshot SELECT the writers use) and skips the discarded order_addons scan.
- **X5 (comment half)** — the Guardrail 3d comment no longer claims broadcast filters tiers; it names the gap explicitly.

## Declined, with rationale

- **A4/S3** — the VIEW denial keeps its two existing refusal codes (c30c0d7's explicit "never invents a new refusal" ruling, unchanged by the fix plan). The X6 fix already names the reason whenever the doctor ACTED (any accept bounce); a cold view of a pool case a doctor cannot take renders the generic denial, which is now only reachable without a ?msg=.
- **A4/S4** — PRE_ACCEPT_ORDER_FIELDS (the case-page brief) and WITHHELD_UNTIL_ACCEPT (the bulk-list redaction) intentionally disagree on clinical_question; both carry comments naming the split, and the guard pins both directions (question ON the brief, OFF every list).
- **A8/S1** — the "Signed electronically · موقّع إلكترونياً" subline renders as bilingual halves (EN left, AR right) rather than one middot-joined string, matching every other bilingual label in the document.
- **A7/S6** — services.ejs's SLA line bypasses tt() keys because the value is computed, not static; noted, no i18n key can carry a dynamic number.
- **A5/S3** — capFor 0/NULL = "no cap" is services/assign_case.js's canonical direction; the columns default 5/8, so a NULL is a hand-made row. Kept for one-definition parity.

## Reported to Ziad (real, out of scope — see the batch report)

- **A7/S1** — routes/api/cases_intake.js writes a live `priority_24h` / sla_hours 24 tier for every oncology case (mounted at /api/cases). A behavior/pricing decision, not a copy fix.
- **X4** — broadcast caps VIP on max_active_cases_urgent while capFor (the canonical helper every gate uses) caps VIP on max_active_cases: invited-but-refused is still possible for VIP, and urgent broadcast is explicitly uncapped. Broadcast SQL = parked routing domain.
- **X5 (SQL half)** — broadcast and the pool queue queries have no sla_tiers_supported predicate; latent post-migration-089, live the day a doctor narrows tiers. Same parked routing domain.
- **X8** — findNextAvailableDoctor (overflow/reassignment target picker) still has no tier/onboarding/doctor_services predicate and uses the old count + global 4.
- **A6/S3** — reassignCase refuses completed/cancelled/refunded cases the old bare UPDATE silently "moved"; now surfaced to the operator via the flash. Whether an operator should be able to reattribute a COMPLETED case is Ziad's call.
- **A6/S5** — if the assignment-row INSERT and the rollback BOTH fail, the stranded shape survives with the rolled_back:false event as the only tripwire.
- **A4/S5** — pendingVideoAppt (incl. patient free-text slot_notes) rides the case payload unconditionally (pre-existing).
- **A4/S6** — age/sex/service/report-language on the brief exceed the spec's literal visible list (pre-existing, argued as scheduling facts).
- **X11 (residual)** — the raw-PDF fallback has no pagination and a fixed footer (pre-existing).
- Pre-existing baseline lint hits (urgency-tier lint): src/routes/superadmin.js:6526, src/services/refund_summary.js:19 — untouched, part of the 6-failure baseline.
