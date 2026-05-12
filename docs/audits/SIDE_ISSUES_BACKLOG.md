# Side Issues Backlog

Single canonical ledger of named side issues raised across audit sessions.
Created 2026-05-12 (backfill request post Theme 10b scoping + side issues
#47–#56 batch). Maintained going forward — every new side issue gets a row.

## Schema

| Column | Meaning |
|---|---|
| `#` | Side issue number. Sequence is global, not per-theme. |
| `Status` | `OPEN` (not started), `RESOLVED` (shipped), `DEFERRED` (decision made not to ship now). |
| `Title` | One-line description. Match the title used in commit messages and audit docs. |
| `Source` | Theme + phase that surfaced it, or `ad-hoc` for items raised outside an audit. |
| `Severity` | `P0` (launch-blocking), `P1` (must-have but not blocking), `P2` (should-have), `P3` (nice-to-have). |
| `Blocker` | External dependency before resolution can proceed: `Meta` (WhatsApp verification), `Internal-policy` (waiting on operator decision or product capability migration), `None`. |
| `Notes` | One-line summary + commit SHA(s) if resolved. |

## Theme 10b execution status (2026-05-12)

Theme 10b RTL fixes shipped in 7 atomic commits per the audit's 8-section
plan at `docs/audits/THEME_10B_RTL_AUDIT_FIX_PLAN.md` (commit `8cd6f1d`):

| Phase | Sub-issue | SHA | Summary |
|---|---|---|---|
| 1 | F — Arabic font fallback | `6456299` | Inter + Noto Sans Arabic unicode-range mix across 6 CSS surfaces + 5 Google Fonts loaders |
| 2 | C — Locale-aware formatters | `30ea413` | `src/utils/formatNumber.js` + 6 patient-facing bare-callsite fixes + OQ-3 notification dates |
| 3 | D — LTR-lock inputs | `e93924b` | 56 `dir="ltr"` insertions across 33 views + safety-net CSS rule |
| 4 | B — Icon mirroring | `8feef60` | Promoted `.p-icon--flip` globally + classed 9 directional SVGs |
| 5 | A — Layout primitives | `7d9de1c` | 76 logicalisations across 12 CSS files (margin/padding/border-l/r → inline-start/end) |
| 6 | E — Chart.js cosmetic RTL | `3b7a8ff` | `direction` config on 7 admin analytics charts |
| 7 | Tests T1-T6 | `f851ebb` | Lint + HTTP regression suite (5 lint + 1 boot test) |

Three sub-issues raised follow-up work during execution (rows #57, #58,
#60 below). #59 not assigned in this batch — surfaced as a gap so future
work can claim it without renumbering.

## Backfill scope note

**#1–#42: not backfilled in this commit.** A `git log` sweep across the
full history shows the `Side issue #N` numbering convention first appears
at **#48** (3 pricing-reset commits, `108fcf0 / d26bd89 / 08d46b9`) and at
**#47** (referenced in commit-body text but no commit attributed to it).
Earlier numbers may live in conversation history or an external tracker
that isn't in the repo. Per "don't invent rows," #1–#42 are intentionally
absent. If you want them in the ledger, paste titles + status and they get
appended.

**#52 ≡ #56 duplicate.** Both rows in the input list carry the title
"Migrate Uploadcare File Uploader 3.x → Blocks v1.x." Surfaced and resolved
in the table below: #52 holds the canonical row (DEFERRED, source =
side issue #52 today), and #56 is logged as a duplicate pointing at #52.
Recommend the next time you touch this list, drop #56 and renumber any
subsequent rows.

## Ledger

| # | Status | Title | Source | Severity | Blocker | Notes |
|---|---|---|---|---|---|---|
| 43 | OPEN | Doctor earnings clawback policy + `recomputeOnRefund` hook | Theme 7b follow-up | P2 | Internal-policy | Refund flow ships an audit trail and approve/deny actions (Theme 7b Phases 1–3, `6c5baa6 / 6b2ba5e / de15753`) but does not zero the doctor's accrued earnings when a refund is approved. Needs policy decision (claw the full earning, prorate, or never claw) before the hook can be wired. |
| 44 | OPEN | Operator-initiated refund creation from queue | Theme 7b audit OQ-14 | P2 | None | Theme 7b audit OQ-14 — `routes/superadmin.js:2554-2575` lets superadmin set `payment_status='refunded'` directly without writing a `refunds` row. Replace with redirect to `/superadmin/refunds` queue with pre-filled "create refund" affordance. Originally punted out of Theme 7b Phase 3. |
| 45 | RESOLVED | `RESEND_API_KEY` documented + fail-fast in prod | Theme 4 Sub-issue A | P1 | None | Resolved at `096211a` (env validator + dead SMTP block kill). Operationally verified during pre-launch audit pass. |
| 46 | RESOLVED | Silent-failure gap: `max_retries_exceeded` in `notification_worker` doesn't emit `NOTIFICATION_DROPPED` case_event | Theme 8 Phase 3 follow-up | P2 | None | **Retitled 2026-05-12.** Original framing ("schema-drift from retry path") was speculative; investigation found no literal schema drift on `case_events`. The real bug: `notification_worker.js:300-322` (max-retries-exhausted branch) wrote to `error_logs` but did not emit a `NOTIFICATION_DROPPED` case_event, so `/ops/silent-failures` (which keys on `case_events` event_types ending in `_DROPPED`/`_FAILED`/`_SKIPPED`/`_NO_OP`) missed every notification that got enqueued cleanly and then failed all 3 retry attempts. The enqueue-side already emitted via `notify.emitNotificationDropped` (`notify.js:271,388,591,618,622,628`). Fix: export `emitNotificationDropped` from `notify.js`; call it from the max-retries branch with `reason='max_retries_exceeded'`. Code-only, no migration. See commit message in this commit. |
| 47 | DEFERRED | Delete `src/sla_worker.js` + `src/jobs/sla_watcher.js` | ad-hoc (2026-05-12) | P3 | None | Today's grep surfaced live callers in `src/server.js:212`, `src/routes/superadmin.js:9`, `scripts/run_sla_check.js:3`; plus `tests/core/theme7-sla-breach-uses-canonical.test.js:121` enforces export-shape. 4-step unblock plan: (1) drop `require('./sla_watcher')` at server.js:212 + remove `runWatcherSweep()` call sites; (2) drop `require('../sla_watcher')` at superadmin.js:9 + callers; (3) delete or rewire `scripts/run_sla_check.js` to `case_sla_worker.runCaseSlaSweep`; (4) drop the "export shape preserved" assertion in theme7-sla-breach-uses-canonical.test.js lines 105–123. |
| 48 | RESOLVED | 95 unpriced services — v4 pricing reset | ad-hoc (pricing audit) | P0 | None | Resolved across migrations `051_insert_lab_panels.sql`, `052_price_and_unhide_launch.sql`, `053_delete_bundled_labs.sql`. Commits: `108fcf0` (7 new lab panel SKUs), `d26bd89` (price + un-hide 38 launch SKUs), `08d46b9` (hard-delete 38 lab tests). Companion docs at `docs/pricing/PRICING_RECONCILIATION_v4_PROD.md`. |
| 49 | RESOLVED | Worker heartbeats use canonical names | ad-hoc (2026-05-12) | P2 | None | Resolved at `440e988`. Renamed pingOps callers in `case_sla_worker.js` (`ops-agent` → `case_sla_worker`), `notification_worker.js` (`care-agent` → `notification_worker`), `instagram/scheduler.js` (`growth-agent` → `instagram_scheduler`). Phase 7 Widget 3 now keys on canonical names directly. |
| 50 | RESOLVED | `error_rate_5x` critical-alert cron | ad-hoc (2026-05-12) | P1 | None | Resolved at `1fcf472`. New `src/jobs/error_rate_check.js` runs the same baseline-vs-current query as `/ops` Widget 4 (7-day hourly baseline + current-hour count); fires `sendCriticalAlert(..., 'error_rate_5x')` when `current >= 5 && current >= 5 * baseline`. Cron registered at `*/15 * * * *` in `src/server.js`. Regression test at `tests/core/error-rate-cron-regression.test.js`. |
| 51 | DEFERRED | Migrate inline `<style>` blocks + `style=` attrs → nonced/external CSS | ad-hoc (2026-05-12) | P3 | Internal-policy | Promoted to **Theme 12** (Inline style migration) — multi-week scope. Today's grep: 37 views with inline `<style>` blocks + 115 with `style="..."` attrs. Removing `style-src 'unsafe-inline'` would break the UI; deferred until Theme 12 ships the bulk migration. Companion record at `7c32597` ("docs(audit): record helmet 'unsafe-inline' dependency for Theme 2"). |
| 52 | DEFERRED | Migrate Uploadcare File Uploader 3.x → Blocks v1.x | ad-hoc (2026-05-12) | P2 | Internal-policy | `src/server.js:350-354` documents that `script-src 'unsafe-eval'` is required by Uploadcare 3.x's `new Function()` template compilation. Removing `'unsafe-eval'` cleanly requires migrating to Blocks v1.x (CSP-strict). Comment block in server.js already names the migration target. Internal-policy: rewrite scope (file uploader is on every patient case-create path; needs UAT). |
| 53 | OPEN | `patient_payment_required.ejs` — video add-on checkbox UX | ad-hoc | P3 | None | Surfaced via session UX review (not via a numbered theme). Specifics held in conversation context; no commit attributed. |
| 54 | OPEN | `video_scheduler` + `acceptance_watcher` heartbeats | ad-hoc (2026-05-12, surfaced during #49) | P2 | None | These two workers emit no `/ops/agent/ping` traffic at all — `src/video_scheduler.js` and `src/workers/acceptance_watcher.js` have no `pingOps` function. After #49's rename, 3 of 5 canonical workers show fresh `lastRun` in Widget 3; the other 2 stay "never run." Resolution: add `pingOps('video_scheduler', ...)` and `pingOps('acceptance_watcher', ...)` to each, mirroring the shape in `case_sla_worker.js:503-512`. |
| 55 | RESOLVED | `CONFIGURED_AGENTS` dashboard rendering goes stale post-rename | ad-hoc (2026-05-12, surfaced during #49) | P3 | None | Resolved in this commit. Updated `CONFIGURED_AGENTS` (`src/routes/ops.js:52-58`) and the scheduling table (`src/views/ops-dashboard.ejs:513-518`) to the 5 canonical worker names (`case_sla_worker`, `notification_worker`, `video_scheduler`, `instagram_scheduler`, `acceptance_watcher`). `video_scheduler` + `acceptance_watcher` will show "never run" until side issue #54 wires their heartbeats. Legacy rollup-name rows in `agent_heartbeats` from before #49 will age out naturally via the merge at `ops.js:466` (stale timestamps surface alongside but don't block the canonical names). |
| 56 | OPEN (duplicate) | Migrate Uploadcare File Uploader 3.x → Blocks v1.x | ad-hoc (2026-05-12) | — | — | **Duplicate of #52.** Same title in input list; consolidated to #52 above. Recommend dropping this row and reusing #56 for the next new side issue. |
| 57 | OPEN | Sub-issue C2 sweep — bare `.toLocaleString()` cleanup in admin/superadmin/doctor-analytics views | Theme 10b Sub-issue C (commit `30ea413`) follow-up | P3 | None | Phase 2 fixed the 6 patient-facing bare callsites but intentionally left ~44 bare `.toLocaleString()` calls in admin/superadmin/doctor-analytics views per Sub-issue E §4 ground rule ("ops surface is en-only"). Files: `admin.ejs`, `admin_analytics.ejs`, `admin_campaign_detail.ejs`, `admin_campaigns.ejs`, `admin_doctors.ejs`, `admin_order_detail.ejs`, `admin_pricing.ejs`, `admin_services.ejs`, `admin_video_calls.ejs`, `admin_reviews.ejs`, `doctor_analytics.ejs`, `superadmin.ejs`, `superadmin_instagram.ejs`. Lint test T3 (`tests/lint/no-bare-tolocalestring.test.js`) allowlists these files; cleanup will require updating the allowlist to enforce the invariant. |
| 58 | OPEN | Theme 10b §F dead-code cleanup — `--v2-font-arabic` / `--font-arabic` token removal | Theme 10b Sub-issue F (commit `6456299`) follow-up | P3 | None | Phase 1 promoted Arabic-font handling to the unicode-range-mix model (Inter + Noto Sans Arabic in the same font-family stack per OQ-7). The `--v2-font-arabic` token (`portal-variables.css:287`) and `--font-arabic` token (`patient-tokens.css:89`) were defined for the rejected "full font swap" option-1 path; they're now defined-but-unused. Safe to delete after a `grep -rn` confirms no remaining references in views/JS. |
| 59 | OPEN | Canonical `chev-end.ejs` / `arrow-end.ejs` EJS partials if directional-SVG count grows past ~30 | Theme 10b Sub-issue B (commit `8feef60`) follow-up | P3 | None | Audit §4 Sub-issue B proposed 4 canonical EJS partials (`chev-end.ejs`, `chev-start.ejs`, `arrow-end.ejs`, `arrow-start.ejs`). Phase 4 deferred — at the current 9 directional-SVG callsites, 4 partials would be over-engineering. If a future theme adds enough new directional SVGs that the count grows past ~30 (when partial-vs-direct-class ratio crosses break-even), revive this work and refactor every callsite onto the partials. T2 lint (`tests/lint/directional-svgs-have-flip-class.test.js`) keeps the invariant healthy in the interim. |
| 60 | OPEN | Sub-issue A2 cleanup — `left:`/`right:` positioning logicalisation + redundant `[dir=rtl]` override deletion (post-visual-QA in production) | Theme 10b Sub-issue A (commit `7d9de1c`) follow-up | P2 | None | Phase 5 mechanically logicalised 76 margin/padding/border-l/r + text-align decls across 12 CSS files but intentionally skipped: (a) `left:`/`right:` positioning props (~20 callsites; semantic intent varies between inline-axis pin and decorative offset), (b) redundant `[dir=rtl]` override deletion (~30 overrides became semantically redundant but harmless), (c) files with existing RTL overrides not in §4's enumeration (`annotator.css`, `doctor-case-detail.css`, `doctor-dashboard.css`, `doctor-guide.css`, `doctor-profile.css`, `doctor-prescriptions.css`, `doctor-portal-v2.css`, `patient-portal-v2.css`, `patient-tokens.css`). ~50 callsites total. **Severity P2 (was P3 in #8c92f0c)** because the sidebar pin and decorative-offset semantic split is the kind of latent bug that produces "looks weird in production" — needs per-callsite review post-visual-QA in production. |

## How to add to this ledger

1. Pick the next unused number.
2. Append a row to the table. Keep the columns in the schema order.
3. If the issue resolves, change `Status` to `RESOLVED` and put the commit SHA(s) in the `Notes` column.
4. If the issue is bigger than a side issue (multi-week, multi-PR), promote it to a Theme and update the `Notes` to reference the Theme number. Side-issue row stays in the ledger as `DEFERRED` with a pointer.
5. If a side issue turns out to be a duplicate, mark it `OPEN (duplicate)` and point at the canonical row in `Notes`. Don't renumber — leaves git blame stable.
