# Batch A spec review — 2026-09-20

(Independent read-only spec-review agent; verbatim report. Fix-round dispositions are recorded separately in FIX-ROUND.md.)

Verdicts: A4 FAIL (S1 blocker) · A5 PASS-WITH-FINDINGS · A6 PASS-WITH-FINDINGS · A7 PASS-WITH-FINDINGS · A8 PASS-WITH-FINDINGS.

## A4 — FAIL
Checked and held: pre-accept payload withholds history/medications/name/DOB/contact (keys absent, not blanked); annotatedFiles []/fileAiChecks {} pre-accept; redactPreAcceptFiles keeps {id, file.ext} and /files/:fileId is separately acceptance-gated; previewCaseEarnings maths identical to writePendingForCase (addons cannot perturb base/uplift shares).
- S1 (blocker) doctor_case_access.js conjunct 8 + doctor.js caller: the load count (doctorLoadSql) INCLUDES the offered case itself when it is assigned-but-unaccepted (status 'assigned', doctor_id=me), while the assign gate measured capacity BEFORE attaching — so every hand-pick/auto-assign/reassign that fills a doctor's LAST slot renders Access Denied to the assignee. Pool cases unaffected.
- S2 (should-fix): view conjunct 7 (tier) applies to assigned-not-accepted; accept Guardrail 3d is pool-only, and assign_case has no tier check — an operator can route a VIP case to a standard-only doctor who can then never OPEN it but could still POST accept; the case otherwise sits until the window expires.
- S3 (should-fix): doctorCaseAccess blockReason (tier_not_supported/at_capacity) discarded at the call site; both denials render as generic "no longer available".
- S4 (note): PRE_ACCEPT_ORDER_FIELDS now includes clinical_question while WITHHELD_UNTIL_ACCEPT still lists it; safe (different scopes: brief vs list rows) but the constants read as contradictory.
- S5 (note, pre-existing): pendingVideoAppt (incl. patient free-text slot_notes) is loaded onto the case payload unconditionally, pre-accept included; template never renders it.
- S6 (note, pre-existing): service_name/age/sex/report_language/created_at on the brief are not in the spec's enumerated visible list (argued as scheduling facts in c30c0d7ba).
- S7 (should-fix): both new `order.urgency_tier || order.tier` reads trip tests/lint/urgency-tier-is-the-source.test.js (files not in ALLOWED). Verified by this session: the lint was ALREADY failing at baseline with 2 pre-existing hits; the new hits joined the same failing assertion, so the suite count did not move — the "byte-identical failures" claim held only at test-title granularity.
- Test honesty: honest; strictly stronger pins; no guard covered S1/S2 (until the fix round).

## A5 — PASS-WITH-FINDINGS
Checked and held: paid gate unchanged; blank-on-either-side specialty refusal real; 3d added; per-doctor capFor over canonical load; single fail-closed live read.
- S1 (should-fix): the blank-specialty refusal reuses ?msg=specialty copy ("outside your registered specialty… update your profile"), which is false and mis-remedied when the CASE has no specialty.
- S2 (should-fix): "not open to anyone" holds for the pool only; assigned-to-me still exempt (declared, consistent with cad13b5) — the spec sentence is not literally universal.
- S3 (note): capFor 0/NULL = no cap replaces the old global 4 on the accept path (columns DEFAULT 5, so NULL is rare; assign_case parity).
- S4 (note): the capacity-overflow target picker (findNextAvailableDoctor) stays ungated — declared out of scope.
- Test honesty: strengthened; two removed assertions each replaced by the stronger property; specialty lint loosened only to accept the merged read shape.

## A6 — PASS-WITH-FINDINGS
Checked and held: durations 15/45/120 untouched; both columns paired at every writer (broadcast single-column correct: no assignee); rollback guards make clobbering a concurrent accept impossible; restored shapes are sweepable.
- S1 (should-fix): the seed-script edit ITSELF hardcodes 120 minutes and writes accept_by_at without the paired orders column — a new inline duration in the very commit banning them; the new guard's regex and file list cannot see it.
- S2 (should-fix): ?reassign=failed is never rendered — superadmin_order_detail.ejs reads no such query param; operator sees nothing.
- S3 (should-fix): reassignCase throws for PAID/COMPLETED cases the old bare UPDATE silently "handled"; combined with S2 the action becomes a silent no-op. (Matches routes/admin.js behavior.)
- S4 (note): auto_assign.js release-claim comment now stale (ASSIGNMENT_ROW_FAILED is thrown AFTER transitionCase).
- S5 (note): if INSERT and rollback BOTH fail, the stranded shape survives with only the rolled_back:false event as tripwire.
- S6 (note): rollback COALESCE fallback 'paid' is lowercase/non-canonical (unreachable today); REASSIGNED-branch clock nulls not restored (safe direction).

## A7 — PASS-WITH-FINDINGS
Checked and held: the 8 edits correct; deliberately-left-alone list accurate (hasSlaAddon dead branch, wizard copy, Holter name, HSM identifier).
- S1 (should-fix, OUT-OF-SCOPE BEHAVIOR): routes/api/cases_intake.js (mounted at /api/cases) writes sla_type 'priority_24h', sla_hours 24 for every oncology case — a live fourth tier. The A7 receipt bucketing makes a 24h case read "VIP — within 18 hours" (false promise).
- S2 (should-fix): patient_payment_success.ejs still buckets instead of printing the real number.
- S3 (should-fix): notify.js addon_purchased_urgency tells an URGENT purchaser "Priority turnaround… added" (retired VIP spelling) in en+ar.
- S4 (note): superadmin_dashboard SQL still counts fast_track inside URGENT KPIs while the display now says VIP.
- S5 (note): emailService band `<=24 → VIP` misreports a 24h row.
- S6 (note): services.ejs new line bypasses tt() keys (necessarily — dynamic value).
- Test honesty: N/A — no guard shipped for A7.

## A8 — PASS-WITH-FINDINGS
- S1 (note): spec's single middot-joined line rendered as bilingual halves (matches the document's own convention).
- S2 (note): subline y-arithmetic uses doc.y - 11 backstep instead of sectionHeader's captured-y pattern; rule offset varies with Arabic font availability.
- S3 (note): raw-PDF fallback renders Arabic as placeholder blocks (path-wide behavior, declared).
- S4 (note): raw fallback has no page-bottom guard; +14pt brings the block nearer the fixed footer.
- S5 (note): no guard pins the heading.

Cross-cutting: the view rule became stricter than the accept gate for assigned-not-accepted cases (S1/S2 family); each item's guard was blind to its own residual gap; A7/A8 shipped no guard.
