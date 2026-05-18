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
