# Batch B progress — earnings ledger and report service

OWNER: this session

- SETUP: branch `fix/earnings-ledger-and-report-service` cut from origin/main @ 4283395b7 — DONE
- SETUP: upstream 60-commit check — no prior Batch B work upstream — DONE
- SETUP: test baseline (no-DB run) — DONE: tally 1927 passed / 6 failed / 52 skipped (matches A2 baseline); plus 214 untallied node:test ✖ lines (separate harness artifact, pre-existing)
- RECON: aggregation sites enumerated — 14+ sites incl. 4 the brief missed (admin.js tiles, superadmin leaderboard, video dashboard stats, video single-row reads) — DONE
- RECON: prod DB state via Supabase MCP — 2 doctor_earnings rows (demo-doctor pair, cancelled order), addon_earnings EMPTY — DONE
- B1: `src/services/earnings_reader.js` + every caller converted (doctor tile/payout tile/earnings page, analytics ×3, video stats, web admin tile, superadmin payouts card + leaderboard, Command /payouts + /breach-cost clawback) — DONE (commits c61b3de87, c68121061)
- B2: ledger/policy alignment — DONE (commit 3fb4d24c1): markReassignedOnReassignment (zero + doctor_sla_events, migration 109 w/ backfill), settleCaseEarningsOnCompletion (pending at completion), markMonthEndPaid (the only 'paid' writer; Command POST /payouts/mark-paid), recomputeOnRefund sla_breach → uplift-only, 3 raw video INSERTs through the writer, booted-doctor email (en+ar) no longer promises 10%
- B2 copy: earnings-page tiles/footnote/pill state the new lifecycle — DONE (commit 65afd7481)
- B3: both dry runs executed via Supabase MCP inside BEGIN…ROLLBACK, outputs captured; recommendation (b) DELETE; awaiting Ziad's COMMIT — DONE (dry runs only)
- B4: `src/services/report_submission.js` — atomic + idempotent submission service; route is thin — DONE (commit 0d2397087)
- B5: policy doc — §1.A lifecycle added, §4/§4.A sla_breach contradiction closed uplift-only — DONE (commit c555daefa)
- VERIFY: all five brief verifications PASSED on a prod-faithful scratch Postgres (docs/reviews/batch-b-2026-09-21/VERIFICATION_OUTPUT.txt; commit df7143ecd): one-number-five-places, Cairo boundary (23:30/00:30 pair splits on statement+series+payout), counter equivalence incl. admin_manual, sequential+concurrent idempotency, trigger-forced atomicity rollback + clean retry; migration 109 proven idempotent w/ correct backfill
- VERIFY: final no-DB suite 1928 passed / 6 failed — failing set IDENTICAL to baseline; node:test ✖ count 214 = baseline
- REVIEW: spec review — IN PROGRESS
- REVIEW: independent adversarial review — IN PROGRESS
- REVIEW: fix round — PENDING
- REPORT: final report to Ziad — PENDING

NOT pushed, NOT merged. Ziad runs the B3 COMMIT and approves the push.
