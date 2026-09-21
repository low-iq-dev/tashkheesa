# Batch A2 — routing and eligibility (fix/routing-eligibility-a2)

OWNER: this session

Baseline (recorded before any change, `env DATABASE_URL= node tests/run.js`):
**1914 passed / 6 failed / 52 skipped.** The 6 are the known baseline set:
env-vars-validated-or-documented, orders-table-readers-allowlist,
payment-money-paths-wiring ×3, theme9-video-flag-enforcement.

- A2-1 (X4): IMPLEMENTED — broadcast's two doctor queries unified into one; capacity is capFor (VIP on max_active_cases) over a doctorLoadSql count, filtered in JS; the local capColumn/defaultCap logic deleted. Urgent fan-out left uncapped, flagged to Ziad.
- A2-2 (X5): IMPLEMENTED — broadcast query gained auto_assign's `?| tierSpellings` predicate; all four pool arms (dashboard build/count, queue build/count) gained `orderTierSql = ANY(allowedOrderTierValues)`, both derived from doctorSupportsTier; handlers read sla_tiers_supported live; NULL = standard-only proven by parity test.
- A2-3 (X8): IMPLEMENTED — findNextAvailableDoctor = eligibleDoctorsFor (auto_assign) + capFor + countActiveCasesForDoctor, oldest-account ordering preserved; literal 4 gone; caller passes the order. No-target behavior unchanged: ?msg=capacity, case stays put.
- A2-4 (A4/S5): IMPLEMENTED — slot_notes added to WITHHELD_UNTIL_ACCEPT; new redactWithheldUntilAccept applied to the case page's pendingVideoAppt, the video appointment page (unaccepted doctor), and the doctor appointments board. Side-path sweep findings in the batch report.
- A2-5 (A6/S3): VERIFIED — reassignCase's status allowlist refuses completed/cancelled/refunded; superadmin catch surfaces ?error=reassign_failed; banner names the terminal-state refusal. Pinned in tests/lint/batch-a2-routing-pins.test.js.

Tests added: tests/core/a2-eligibility-parity.test.js (6), tests/lint/batch-a2-routing-pins.test.js (6); paused-doctors lint split into function-scoped halves (+1). Suite after: **1927 / 6 / 52** — same 6 baseline failures, 0 new.
Reviews: DONE — docs/reviews/batch-a2-2026-09-21/ (SPEC-REVIEW: all items MEET SPEC; ADVERSARIAL: SHIP, no blockers; FIX-ROUND: X1/S5/X7/S6/S3/S7 fixed, rest dispositioned; REPORT.md = the batch report, incl. the uncapped-urgent and zeroed-cap questions for Ziad and the latent X2 side path, ticketed).
STATUS: complete, awaiting Ziad. Nothing pushed, nothing merged.
