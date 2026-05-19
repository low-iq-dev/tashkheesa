# Superadmin redesign — migration notes

Living log of decisions, deviations, and discoveries. Updated each phase.

Branch: `feat/superadmin-redesign` (from `main`).
Plan source: brief delivered 2026-05-18; inventory at `SUPERADMIN_INVENTORY.md`.

---

## Phase log

### Phase 1 — Design system + shell

- Copied prototype `docs/redesign/superadmin/styles.css` (1,106 LOC) → `public/css/superadmin-cockpit.css` verbatim. No edits.
- Created supplementary CSS file `public/css/superadmin-cockpit-extras.css` for additions the prototype didn't cover (form fields, sub-page header, breadcrumb, flash messages). Uses only tokens defined in the verbatim file — no new tokens.
- Built fresh layout `src/views/layouts/superadmin.ejs`. Forked from `layouts/portal.ejs` only in spirit — does not include any portal CSS (`portal-variables.css`, `portal-components.css`, `portal-global.css`, `admin-styles.css`, `owner-styles.css` are all excluded for superadmin views).
- Created `src/views/partials/superadmin/{header,footer,sidebar,topbar,pills,attention_banner,page_header,tab_bar}.ejs` for chrome and `c_{kpi,card,empty,spark,bar_row,tier_strip,table,chip,avatar,form_field}.ejs` for components. Icons consolidated into a single dispatcher `partials/superadmin/icons.ejs` rather than 14 separate files (deviation from brief — see below).
- Added preview route `GET /superadmin/__preview` rendering `superadmin__preview.ejs`. Owner-guarded by `requireSuperadmin`. Removed before final merge.

---

## Forked partials

The brief mandates "fork instead of touch" for partials shared with other portals. So far:

| Original | Fork | Reason |
|---|---|---|
| `src/views/partials/header.ejs` (router) | not forked yet | Superadmin views use `partials/superadmin/header.ejs` directly (bypasses the portal router). Original untouched. |
| `src/views/partials/footer.ejs` | not forked | Superadmin views use `partials/superadmin/footer.ejs`. Original untouched. |
| `src/views/layouts/portal.ejs` (sidebar inline) | `partials/superadmin/sidebar.ejs` | Extracted superadmin sidebar block out of the shared layout. |

---

## Repointed admin links

The owner sidebar's nine `/admin/*` → fork list (per §A of the brief):

| Sidebar item | Old target | New target | Status |
|---|---|---|---|
| Cases | `/admin/orders` | `/superadmin/orders` | Phase 3 batch 1 |
| Video Calls | `/admin/video-calls` | `/superadmin/video-calls` | Phase 3 batch 6 |
| Pricing | `/admin/pricing` | `/superadmin/pricing` | Phase 3 batch 3 |
| Analytics | `/portal/admin/analytics` | `/superadmin/analytics` | Phase 3 batch 7 |
| Reviews | `/admin/reviews` | `/superadmin/reviews` | Phase 3 batch 6 |
| Chat Moderation | `/admin/chat-moderation` (+ detail) | `/superadmin/chat-moderation` (+ detail) | Phase 3 batch 6 |
| Campaigns | `/portal/admin/campaigns` | `/superadmin/campaigns` | Phase 3 batch 4 |
| Referrals | `/portal/admin/referrals` | `/superadmin/referrals` | Phase 3 batch 4 |
| Error Log | `/admin/errors` | `/superadmin/errors` | Phase 3 batch 7 |

In Phase 1, sidebar links point to the *new* `/superadmin/*` paths. They'll 404 until each batch lands.

---

## Shared JSON endpoints — intentionally not forked

The following endpoints are shared API surface (JSON only, no view layer) and are called from superadmin pages without being forked to `/superadmin/...`. They're documented here so anyone auditing the route table later knows the deviation is intentional, not an oversight.

| Endpoint | Caller(s) | Why shared |
|---|---|---|
| `POST /admin/orders/:id/uploads/lock?format=json` | `superadmin_order_detail.ejs` uploads card | JSON-only endpoint, no admin view rendered. Same logic for admin + superadmin. Forking would duplicate ~80 LOC of support code with zero behaviour delta. |
| `POST /admin/orders/:id/uploads/unlock?format=json` | `superadmin_order_detail.ejs` uploads card | Same as above. |
| `POST /api/referral/grant-reward` | (no forked view calls it) | API-mounted under `/api/`. Role-gated `requireRole('admin','superadmin')`. Internal use only: the payment webhook in `routes/payments.js` calls the same logic inline; this route is kept for manual operator use. Not called from any forked view. |
| `DELETE /portal/admin/review/:reviewId` | `superadmin_reviews.ejs` (Hide / Flag buttons) | JSON-only endpoint in `routes/reviews.js:245`, role-gated `requireRole('admin','superadmin')`. Updates `reviews.is_visible` or `reviews.admin_flagged`. The `/portal/admin/` URL prefix is already a shared-API namespace. Fetch URL in the forked view intentionally NOT repointed. |
| `GET /admin/errors/stats` | `superadmin_errors.ejs` (KPI + chart bootstrap) | JSON-only stats endpoint in `routes/admin.js:2398`, role-gated `requireRole('admin','superadmin')`. Returns errorsByDay/errorsByLevel/topErrors/totals. No view rendering. Fetch URL in the Batch 7 fork is intentionally NOT repointed. |
| `GET /api/analytics/export` | `superadmin_analytics.ejs` (3 × Cases/Revenue/Doctors CSV + 1 × Top Doctors export) | CSV endpoint in `routes/analytics.js:362`, role-gated `requireRole('superadmin')` (P0-SEC). Lives under `/api/` namespace, no view layer. 4 hrefs in the Batch 7 fork intentionally NOT repointed. |

**Policy:** if any of these ever need superadmin-specific behaviour (different audit trail, different role check, different side effects), fork them then — not pre-emptively. They are API surface, not view surface, so they sit outside the brief's "fork the view + route together" rule.

## Behaviour observed, not changed

Things spotted during the migration that look like real cleanup candidates but were preserved verbatim because the brief is visual-only. Each entry is a future-work hook.

| Site | Behaviour | Why deferred |
|---|---|---|
| `GET /superadmin/chat-moderation/:reportId` (and the mirrored legacy `/admin/chat-moderation/:reportId`) | Write-on-read side effect: flips `chat_reports.status` from `'open'` to `'reviewing'` on first view. | Existing behaviour. Changing it during a visual migration risks losing the "first reviewer" audit signal silently. Fix in a dedicated batch (move the flip into a separate POST or into the view-tracking infra). |
| `superadmin_errors.ejs` stack-trace toggle (mirror of `admin_errors.ejs`) | Markup wires `data-action="toggle-stack" data-target="stack_X"` but the inline JS only exposes `window.toggleStack(id)` with no event delegation listener — the click never fires. Identical (non-functional) state on `/admin/errors` today. | Visual-only migration. Preserved verbatim in Batch 7. Fix wants either an event delegate (`document.addEventListener('click', e => …)`) or rewiring the markup to `onclick=` — pick one in a dedicated cleanup. |
| `superadmin_analytics.ejs` filter deep-links (mirror of `admin_analytics.ejs`) | KPI/attention links use `?payment=unpaid` and `?status=paid` query params. **Neither `/admin/orders` nor `/superadmin/orders` processes `payment`**, and `paid` is a `payment_status` value not a `status` value — both filters are silently no-ops today. | Existing behaviour on both routes. Preserved verbatim (Batch 7) — links repointed to `/superadmin/orders?...` with identical params per Q6. Real fix needs either adding a `payment` filter to the orders handler or changing the analytics view to use a working filter (out of scope for visual migration). |
| Attention banner Triage button (`partials/superadmin/attention_banner.ejs`) | Links to `/superadmin/orders?filter=attention` but the orders route does not handle `filter`. Silent no-op — the button leads to an unfiltered orders list. | Pre-existing from Phase 2 (dashboard cockpit). Surfaced during Phase 4 walk. Fix wants either adding a `filter=attention` handler to the orders route (`completed_at IS NULL AND deadline_at < NOW() + INTERVAL '4 hours'` — same shape as the sidebar badge query) or changing the banner CTA to a specific working filter. Deferred. |
| Date/time rendering across the entire superadmin portal (13 sites) | `formatEventDate` in `src/middleware.js:229` and 12 per-view `fmtDate` / `_fmtWhen` / `fmtDateTime` helpers all use server-local TZ — none pass `timeZone: 'Africa/Cairo'` to `Intl.DateTimeFormat` options or `.tz('Africa/Cairo')` to dayjs. No `TZ` env in `.env` or `.env.production`, so on Render this defaults to UTC. **Every timestamp on every superadmin page is displayed in server-local TZ, not Cairo time.** | Pre-existing — copied verbatim from legacy admin views; predates the redesign. Phase 4 surfaced it as WARN-2 but explicitly deferred. Real fix is a dedicated TZ batch touching `src/middleware.js` (formatEventDate helper) + the 12 inline view formatters (`superadmin_chat_moderation.ejs`, `superadmin_chat_moderation_detail.ejs`, `superadmin_orders.ejs`, `superadmin_orders_trash.ejs`, `superadmin_doctors.ejs`, `superadmin_doctor_detail.ejs`, `superadmin_video_calls.ejs`, `superadmin_errors.ejs`, `superadmin_campaigns.ejs`, `superadmin_campaign_detail.ejs`, `superadmin_reviews.ejs`, `superadmin_order_detail.ejs`) — each needs `{ timeZone: 'Africa/Cairo' }` added to its `toLocaleString` / `toLocaleDateString` options object, plus the middleware helper updated to use dayjs's timezone plugin. Optionally set `TZ=Africa/Cairo` in the Render env as a belt-and-braces measure (would also fix `.getHours()` / `.getDate()` calls in `superadmin_errors.ejs:fmtDate`). Out of scope for the redesign visual-only PR; track as a follow-up. |

## Chat moderation policy

**Mute duration: 7 days.** Two route handlers apply the constant, kept in sync:

1. `routes/admin.js` — `POST /admin/chat-moderation/:reportId/resolve` (line `~2730`)
2. `routes/superadmin.js` — `POST /superadmin/chat-moderation/:reportId/resolve` (the Batch 6 fork)

Grep anchor: `INTERVAL '7 days'`. Both handlers have a `CHAT MODERATION POLICY` comment block naming both sites. If the window changes, update both at once.

## Deliberate deviations from the brief

1. **Icons consolidated.** Brief says `partials/superadmin/icons/<name>.ejs` (one file per icon). Implemented as a single dispatcher `partials/superadmin/icons.ejs` with a `name` local. Why: 30+ icon files for tiny content is high-friction. Effect: same call surface, fewer files. Easy to split later if needed.
2. **Layout vs `layout_open`/`layout_close`.** Brief lists both `layouts/superadmin.ejs` AND `partials/superadmin/layout_open.ejs` + `layout_close.ejs`. Implemented as the existing repo's pattern: `layouts/superadmin.ejs` is the opener (mirrors `layouts/portal.ejs`), `partials/superadmin/footer.ejs` is the closer. `partials/superadmin/header.ejs` is a thin pass-through. No separate `layout_open/close` files.
3. **Extras CSS.** Created `public/css/superadmin-cockpit-extras.css` so `superadmin-cockpit.css` stays a verbatim copy of the prototype. Anything the prototype didn't style (form fields, breadcrumb, page header on sub-pages, flash messages) goes in extras.

---

## Behaviour bugs / oddities discovered

- **pg-boss SLA sweep is already scheduled** (confirmed at boot: `[job-queue] SLA sweep scheduled via pg-boss (*/5 * * * *, singleton)` in `src/server.js`). So §B's plan to "add a pg-boss schedule before removing the inline call" is unnecessary — the inline `recalcSlaBreaches()` in the dashboard route is duplicate work and can be deleted in Phase 2 without any replacement. Behaviour parity confirmed by reading the SLA sweep wiring in `src/server.js:1095-1101`. **Removed in Phase 2.**
- **Overdue-orders write-on-read loop** (`for (const o of overdueOrders) enforceBreachIfNeeded(o)`) in the legacy handler was the same write-on-read pattern as `recalcSlaBreaches()`. Same pg-boss sweep covers it. **Also removed in Phase 2** — flag if you want it back as a Promise.all fallback.

---

## Dashboard perf

**Before (Phase 1 baseline, just to give context):** ~25 sequential queries with one fire-and-forget `recalcSlaBreaches()` call on every load. Not measured in production but easily >2s on a busy DB.

**After (Phase 2, dev DB):**
- 9 parallel fetchers via `Promise.all`
- Cold-cache p50 (dev DB, small data): **11ms**
- Cold-cache p99 (first call, pool-warmup): **115ms**
- Warm-cache: **0ms** across the board
- Brief target: <800ms p50, <1.5s p99 — comfortably under on dev. Production should be measured after first deploy.

**Removed write-on-read side effects:**
1. Inline `recalcSlaBreaches()` — pg-boss sweep handles this (`server.js:1095-1101`).
2. The `overdueOrders` + `enforceBreachIfNeeded` loop — same coverage via pg-boss `case_sla_worker.runCaseSlaSweep`. Removed alongside #1 since they served the same purpose (write-on-read SLA enforcement). If you'd rather keep #2 as a fallback, I can re-add it inside a Promise.all rather than as a serial pre-step. Flag it if you want it back.

## Phase 2 — Dashboard cockpit + perf rework

- Built `src/services/superadmin_dashboard.js` (~860 LOC). Nine public fetchers (3 chrome + 6 tabs). In-process Map+TTL cache via `getCached(key, ttlMs, fn)`. 30s TTL for live chrome (pills, banner, badges); 60s for tab data. `_bustCache()` exposed for tests.
- Built six tab partials: `partials/superadmin/tab_{operations,finance,doctors,patients,marketing,health}.ejs` plus `tab_bar.ejs`.
- Rewrote `src/views/superadmin.ejs` from 675 LOC (legacy KPI dump) to 82 LOC (chrome + 6 panes + client-side hash routing).
- Rewrote `GET /superadmin` handler: 447 LOC → 96 LOC. Parallel `Promise.all` over the nine fetchers; each is wrapped in `.catch()` so a single failure leaves the rest rendering. `console.log('[superadmin_dashboard] data=Xms render+data=Yms range=Z')` on every render.

### Data gaps surfaced (render `c_empty`)

The brief mandates no fake data. Where a metric isn't in the DB today, the tab partial renders an empty state explaining why:

| Tab | Block | Why it's empty |
|---|---|---|
| Patients | Acquisition source | No `source` / UTM field on `users` |
| Patients | Cohort retention | No weekly patient-snapshot table |
| Marketing | IG reach (7d/30d) + top posts | Reach numbers live in the IG API; not mirrored locally |
| Marketing | WhatsApp templates list | Templates live in Meta Business; not mirrored |
| Marketing | Meta verification state | Manual check, no DB signal |
| Marketing | Campaign open/click rates | `campaign_recipients` only stores `status` — no `opened_at` / `clicked_at` columns |
| Health | Services uptime | Would need an external healthcheck → `uptime_log` |
| Health | Per-worker state | `pg-boss.job` rows are queryable but per-worker last-run + attempt history would need a wrapper; deferred |
| Health | WhatsApp crash alerts | No DB feed |
| Health | Recent deploys | Would need a Render API integration |
| Health | API uptime, DB pool, last deploy KPIs | Same — no DB signal |

Each of the above is a future-work hook. None block Phase 2.

### Schema mismatches discovered

Surfaced by the first `Promise.all` smoke. Fixes inlined into the service:

1. `campaign_recipients` has no `opened_at` / `clicked_at` — only `status`. Now reports sent/failed via status; open/click default to 0 with a tab-level note.
2. `referral_redemptions` has no `converted_at` — uses `order_id IS NOT NULL` as the conversion signal.
3. SLA-buckets query needed a subquery to GROUP BY the CASE-derived `tier` alias.
4. Urgency-tier finance query needed an explicit `GROUP BY COALESCE(o.urgency_tier, 'standard')` rather than the alias `tier`.

---

## Deferred features (not in scope of the visual migration — surface for later)

| Item | Notes |
|---|---|
| `superadmin_profile.ejs` change-password form | The Batch 7 brief mentioned "+ change password" but the legacy view is read-only and no `POST /superadmin/profile/password` route exists today. Adding the form would require a new route, password-strength validation, current-password verification, and audit logging — out of scope for a visual batch. Read-only verbatim was shipped in Batch 7 (Q4 ruling). Pick up in Phase 4 polish or a dedicated security batch. |
| `superadmin_alerts.ejs` severity-coloured chips | The Batch 7 brief mentioned "severity colors, action chips" but the live notifications data has no severity field. The Batch 7 fork ships with a chip on `status` only (Q3 ruling). When a real severity field exists, swap to severity-coloured chips. |
| Orders-list `payment` filter | The analytics view links to `/superadmin/orders?payment=unpaid` but the orders route ignores `payment`. Add support to make the deep-link work (see "Behaviour observed, not changed"). |

## Pre-existing bugs surfaced during Phase 4 QA — deferred to follow-up PRs

These were found during the browser walk after Phase 4 polish landed. Each is a real data or backend correctness issue **unrelated to the visual redesign**. Logged here so they aren't lost; explicit decision to defer was made by the user so this PR ships only the design system + visual migration.

| Bug | Where | Notes |
|---|---|---|
| `/superadmin/analytics` number reconciliation | `routes/analytics.js` GET `/portal/admin/analytics` (mirrored by the Batch 7 fork in `routes/superadmin.js`) | KPI counts / chart totals don't reconcile with each other or with the dashboard cockpit's tab totals. Same queries served two consumers diverge somewhere. Needs a query-by-query audit against ground-truth case counts. The Batch 7 fork mirrors the legacy handler byte-for-byte, so any reconciliation fix lands in both routes simultaneously. |
| Duplicate display-name dedupe | doctors/patients lists across the portal | "Demo Doctor, EG" + similar variants show up as separate rows where they should dedupe. Root cause likely a JOIN on name/email/specialty without a stable user_id grouping, or duplicate user rows in the DB. Investigate before adding a UI-side dedupe (the data should be canonical). |
| `EPIPE` backend errors (764 occurrences in `error_logs`) | server-wide, see `superadmin_errors` view | High-count error class. Typically caused by writes to a closed response stream (client disconnected mid-response, or write-after-end). Needs a stack-trace sample from one row to localize — could be the SSE pipe, a streamed CSV export, or the SLA sweep logger. |
| Video-calls "Completed: 0" KPI | `superadmin_video_calls.ejs` KPI logic + the upstream `appointments.status` value the route reads | KPI shows 0 completed even when the appointments table has rows with `call_status = 'completed'`. The KPI computation likely keys off `status` instead of `call_status`, or off a value that's never written. Audit which column drives "completed" semantics. |
| Services missing codes / naming inconsistency | `services` table data | Some service rows have no `code` value; naming differs from the source-of-truth catalog. Data cleanup, not code. Schedule a one-shot script + a NOT NULL constraint follow-up. |
| Order timeline vs doctor state mismatch | `superadmin_order_detail.ejs` timeline + `orders_active.doctor_id` | Timeline events suggest a doctor reassignment but `doctor_id` still shows the previous doctor. Race condition in `POST /reassign` handler — likely the timeline event is written before the UPDATE commits, or the read-after-write picks up the stale row. Investigate transaction boundary in `routes/superadmin.js` `/orders/:id/reassign`. |
| Pricing formula vs displayed value | `superadmin_pricing.ejs` rows + `service_regional_prices` rows | Some `tashkheesa_price` cells don't match the 1.15 × `hospital_cost` formula stamped on the policy comment. Likely manual overrides written directly via the bulk-activate flow that bypassed the multiplier. Audit for rows where `tashkheesa_price ≠ ROUND(hospital_cost * 1.15)` and decide whether to backfill or annotate. |
| Errors table audit + fatal row mixing | `superadmin_errors.ejs` view + `error_logs` table | The Errors page intermixes audit-style log rows (informational) with fatal/error rows. Either the writer is mis-tagging `level`, or the page should filter by `level IN ('error','fatal','warn')` and exclude info/audit. Pick whichever the writer intended. |
| Settings threshold ordering validation | `routes/superadmin.js` POST `/superadmin/settings` | The view renders a soft warning when `locked > auto > minimum` ordering is violated, but the route accepts the invalid ordering on submit. Either enforce server-side (reject the POST) or accept that "soft warn only" was the design intent. Decide and align. |
| `superadmin_alerts.ejs` badge ≠ page row count | `services/superadmin_dashboard.js getSidebarBadges` (alerts query) vs `routes/superadmin.js` GET `/superadmin/alerts` | **Root cause found:** badge query is `COUNT(*) FROM notifications WHERE status NOT IN ('seen','read') AND template ILIKE '%superadmin%' OR template ILIKE '%admin_alert%' AND at > NOW() - INTERVAL '30 days'` — global, template-name-matched, unread-only. Page query is `fetchSuperadminNotifications(userId, userEmail, 50)` — per-user via `user_id` / `to_user_id`, all read states, top 50. Different filter sets, so the numbers naturally disagree. Fix wants either narrowing the badge query to the current user (need to thread `userId` through `getSidebarBadges()`, currently arg-less + globally cached) or widening the page query. Either way, an intentional product decision is needed. |

These were all explicitly **out of scope** for the superadmin redesign branch — they are pre-existing data and backend correctness issues that predate the visual migration. None block merge of the redesign.

## Deferred items

- **`SUPERADMIN_INVENTORY.md`** is untracked at repo root. It's the recon artifact that informed the brief. Leaving the decision to track or delete it for the user.
- **Preview route `/superadmin/__preview`** is in-tree for the Phase 1 review. Must be removed before final merge (or before any non-Phase-1 commit hits a deploy branch).
- **Sidebar links to nine `/superadmin/*` routes that don't exist yet** (orders, video-calls, pricing, analytics, reviews, chat-moderation, campaigns, referrals, errors). They'll 404 until their Phase 3 batch lands. Document for testers.

---

## Phase 1 verification

- `node ejs.render(...)` smoke-test on `superadmin__preview.ejs` → OK, 25,400 chars of HTML output.
- `node src/server.js` boots clean on port 3099. `/healthz` → 200.
- `GET /superadmin/__preview` unauthed → 302 → `/login?next=...` (guard works).
- Full authed visual review pending with Ziad in browser.
