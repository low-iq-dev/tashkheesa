# Batch B progress — earnings ledger and report service

OWNER: this session

- SETUP: branch `fix/earnings-ledger-and-report-service` cut from origin/main @ 4283395b7 — DONE
- SETUP: upstream 60-commit check — no prior Batch B work upstream — DONE
- SETUP: test baseline (no-DB run) — DONE: tally 1927 passed / 6 failed / 52 skipped (matches A2 baseline); plus 214 untallied node:test ✖ lines (separate harness, pre-existing) — both numbers must not regress
- RECON: enumerate every earnings aggregation site — PENDING
- RECON: prod DB state (B3 rows, addon_earnings) via Supabase MCP — PENDING
- B1: shared earnings reader, all callers converted — PENDING
- B2: ledger/policy alignment (token row goes, pause counter re-homed, paid at month-end, video_scheduler via writer) — PENDING
- B3: dry runs (a) zero vs (b) delete, recommendation for Ziad — PENDING
- B4: report submit service (idempotent, atomic) — PENDING
- B5: policy doc pass — PENDING
- VERIFY: reconciliation (one number, four places) — PENDING
- VERIFY: Cairo month boundary — PENDING
- VERIFY: pause-counter equivalence — PENDING
- VERIFY: idempotency + atomicity — PENDING
- REVIEW: spec review — PENDING
- REVIEW: independent adversarial review — PENDING
- REVIEW: fix round — PENDING
- REPORT: final report to Ziad — PENDING
