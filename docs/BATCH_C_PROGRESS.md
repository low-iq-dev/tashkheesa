# Batch C — progress ledger

OWNER: this session (MacBook, worktree `/Users/ziadelwahsh/tashkheesa-batchc`, branch `feat/doctor-access-and-api` cut from origin/main @ 5cd16e9cc)

Baseline (no-DB, this machine, 2026-09-22): **1926 passed / 11 failed / 52 skipped** — `env DATABASE_URL= node tests/run.js`, deterministic across two runs. The 11 pre-existing failures: email-stub-mode ×5, env-vars-validated-or-documented ×1, orders-table-readers-allowlist ×1 (3 findings), payment-money-paths-wiring ×3, theme9-video-flag-enforcement ×1. Goal: add zero.

| Item | Status | Notes |
|---|---|---|
| Upstream check | DONE | origin/main = 5cd16e9cc, nothing from Batch C upstream |
| C1 sessions table + per-device refresh/push | — | migration 110 + `services/user_sessions.js` + auth/admin/profile/push rewiring |
| C2 doctor auth endpoints `/api/v1/doctor/auth/*` | — | 12h refresh, full state check, no account creation; patient door refuses doctors |
| C3 decline + hand-back | — | decline = pre-accept via reassignCase (no earnings row / no SLA event, proven by `no_main_row` early-return); hand-back = post-accept reassignCase, excused reasons excluded in doctor_pause |
| C4 appearance column + phrase library | — | migration 111, shapes matched to app `DbPhrase` / `appearance` |
| C5 RLS on deleted_users / email_delivery_events / email_suppressions | — | migration 112, 085-style guarded ENABLE |
| Reviews (spec + adversarial + fix round) | — | C1/C2 get the heavy round |
| Final test run | — | must equal baseline |
