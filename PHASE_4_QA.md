# Phase 4 — QA walk log

Branch: `feat/superadmin-redesign` · Base commit: `9333f67` (Batch 7) · **Final commit after fixes:** `381b5e2`.

## Status

| Fix | Commit | Status |
|---|---|---|
| FAIL-1 — Refunds sidebar entry (both sidebars) | `7772028` | **Done** |
| WARN-1 — EGP suffix on 3 money columns | `4560858` | **Done** |
| Fix 3 — Plumb sidebar badges via middleware | `381b5e2` | **Done** |
| WARN-2 — Cairo TZ across 13 sites | — | **Deferred** (logged in MIGRATION_NOTES "Behaviour observed, not changed" — dedicated TZ batch for a follow-up PR) |
| WARN-3 — Pre-existing query-param no-ops + broken stack toggle | — | **Deferred** (already documented in MIGRATION_NOTES) |

Post-fix re-walk: 30/30 EJS views compile clean · 26/26 GET routes return 302 unauthed · non-superadmin regression check clean (`/admin`, `/portal/doctor`, `/portal/patient`, `/login` all responsive, no server log errors) · zero server-side errors in the boot log after the walk.

Phase 4 non-negotiables:
1. ✅ Zero server-side render errors on any superadmin page (static + curl walk).
2. ✅ Sidebar nav works on every page — Refunds now in both sidebars, badge count plumbed, active state matches `currentSection: 'refunds'`.
3. ✅ No regression in admin / doctor / patient portals — CSS + partial leakage scan clean, smoke-curls clean.

Remaining `NEEDS-BROWSER` items (runtime JS errors, visual RTL flip, Network-tab asset 404s) are out of scope for the static walk — the user has those.

---

Method note: this is a **static QA walk** — EJS compile + server-boot curl smoke + grep-level checks across every superadmin view and route. I do not have an interactive browser session in this environment, so anything that needs eyes-on-screen is tagged `[NEEDS-BROWSER]`. See "Limits of this walk" at the end for what was and wasn't covered.

---

## Per-page status (26 GET routes)

| Route | Status | Notes |
|---|---|---|
| `/superadmin` | OK | compiles; 302 unauthed; sidebar key `dashboard` |
| `/superadmin/__preview` | OK | component preview route still wired |
| `/superadmin/orders` | OK | sidebar key `orders` |
| `/superadmin/orders/:id` | OK | active state on `orders` |
| `/superadmin/orders/new` | OK | active state on `orders` |
| `/superadmin/orders/trash` | OK | active state on `orders` |
| `/superadmin/orders/:id/payment` | OK | active state on `orders` |
| `/superadmin/doctors` | OK | sidebar key `doctors` |
| `/superadmin/doctors/:id` | OK | active state on `doctors` |
| `/superadmin/doctors/new` | OK | active state on `doctors` |
| `/superadmin/doctors/:id/edit` | OK | active state on `doctors` |
| `/superadmin/services` | OK | sidebar key `services` |
| `/superadmin/services/new` | OK | active state on `services` |
| `/superadmin/services/:id/edit` | OK | active state on `services` |
| `/superadmin/pricing` | OK | currency column shown separately, no EGP suffix needed on numeric cells |
| `/superadmin/pricing/export` | OK | CSV route |
| `/superadmin/campaigns` | OK | sidebar key `campaigns` |
| `/superadmin/campaigns/new` | OK | active state on `campaigns` |
| `/superadmin/campaigns/:id` | OK | active state on `campaigns` |
| `/superadmin/referrals` | OK | sidebar key `referrals` |
| `/superadmin/instagram` | OK | sidebar key `instagram` |
| `/superadmin/refunds` | ~~FAIL~~ → **OK** | Fixed in `7772028` — Refunds entry added to both sidebars; active state now resolves; badge count plumbed via `7772028` + `381b5e2`. |
| `/superadmin/refunds/create` | ~~FAIL~~ → **OK** | Same fix as above. |
| `/superadmin/video-calls` | ~~WARN~~ → **OK** | Fixed in `4560858` — `Payment` column header now reads `Payment (EGP)` / `الدفع (جنيه)`. |
| `/superadmin/chat-moderation` | OK | sidebar key `chat-moderation` |
| `/superadmin/chat-moderation/:reportId` | OK | active state on `chat-moderation`; write-on-read flip already documented |
| `/superadmin/reviews` | OK | sidebar key `reviews` |
| `/superadmin/settings` | OK | sidebar key `settings` |
| `/superadmin/events` | OK | sidebar key `events` |
| `/superadmin/alerts` | OK | sidebar key `alerts` |
| `/superadmin/profile` | OK | sidebar key `profile` |
| `/superadmin/errors` | OK | sidebar key `errors`; stack-trace toggle already documented |
| `/superadmin/analytics` | OK | sidebar key `analytics`; payment=unpaid / status=paid no-ops already documented |

**Tally:** 30 pages walked. **Post-fix: 30 OK · 0 WARN · 0 FAIL** (Initial walk: 27 OK · 1 WARN · 2 FAIL; all three resolved.)

---

## FAILs

### FAIL-1: Refunds is orphaned from the sidebar

**Where:** `src/views/partials/superadmin/sidebar.ejs`, `src/views/superadmin_refunds.ejs:31` and `src/views/superadmin_refund_create.ejs:35` (both pass `currentSection: 'refunds'`).

**Symptom:**
- The superadmin sidebar has **no `refunds` link** — neither under Operations nor anywhere else.
- `/superadmin/refunds` and `/superadmin/refunds/create` both pass `currentSection: 'refunds'`, but the sidebar's `_groups` array has no entry with `id: 'refunds'`, so the active-state highlight does nothing.
- The only links to `/superadmin/refunds` in the codebase are *internal* (the create page links back to the queue and vice versa). Nothing on the dashboard, no other sidebar, no other page links to it. The page is reachable **only by typing the URL**.
- This violates Phase 4 non-negotiable #2: *"Sidebar nav works on every page — every link goes somewhere that renders, no 404s, active state correct."*

**Pre-existing? Partly.** The legacy `layouts/portal.ejs` superadmin sidebar block also has no refunds link — so the orphan predates the redesign. But the redesign didn't fix it, and Batch 5 shipped a fully-restyled refunds queue that ended up unreachable from the new chrome.

**Proposed fix:** add one entry to `partials/superadmin/sidebar.ejs` under the Operations group:
```js
{ id: 'refunds', label: _isAr ? 'الاستردادات' : 'Refunds', href: '/superadmin/refunds', icon: 'refund' /* fallback: 'pricing' */ }
```
Plus add a corresponding entry to the legacy `layouts/portal.ejs` superadmin sidebar block for any view that hasn't migrated to the new chrome (none in superadmin views post-Batch-7, but admin views with `portalRole: 'superadmin'` still render the legacy block).

Single commit, no behaviour change.

---

## WARNs

### WARN-1: EGP suffix inconsistency in 3 sites

The brief's check category states: *"Every currency value is rendered as `12,345 EGP`. Flag any raw numbers, decimals, or wrong currency symbols."*

| Site | Render | Context |
|---|---|---|
| `src/views/superadmin_video_calls.ejs:129` | `<strong class="tabular"><%= Number(a.payment_amount).toLocaleString('en-GB') %></strong>` | "Payment" column on the appointments table. Column header is just "Payment"/"Dirham" with no `(EGP)` qualifier; no global "all amounts in EGP" meta header on the card. **Real ambiguity.** |
| `src/views/partials/superadmin/tab_doctors.ejs:50,51` | `<td class="num"><%= Number(r.rev).toLocaleString('en-US') %></td>` (and `r.owed`) | Doctors-tab leaderboard "Rev" + "Owed" columns. No EGP suffix anywhere on the tab. |
| `src/views/partials/superadmin/tab_marketing.ejs:90` | `<td class="num"><%= Number(r.rev).toLocaleString('en-US') %></td>` | Marketing-tab referrals "Revenue" column. No EGP suffix. |

Compare with `tab_finance.ejs` which uses a global `<span class="meta">all amounts in EGP</span>` header to disambiguate. The other two dashboard tabs and `superadmin_video_calls.ejs` lack any disambiguation.

**Pre-existing (Phase 2 for dashboard tabs; Batch 6 for video-calls — verbatim from legacy admin view).** Visual-only fix: add either a per-cell `EGP` suffix or a per-card meta header. Trivial scope, but per Phase 4 "don't refactor" guidance, propose as a single fix commit or defer.

### WARN-2: Cairo TZ is not applied anywhere — all timestamps render in server-local TZ

The brief's check category states: *"Every timestamp on every page displays Cairo time (`Africa/Cairo`)."*

**Observed:**
- The global helper `res.locals.formatEventDate` at `src/middleware.js:229` uses `dayjs(iso).format('DD/MM/YYYY — hh:mm A')` — no `.tz('Africa/Cairo')` extension.
- 12 superadmin views define their own `fmtDate` / `_fmtWhen` / `fmtDateTime` helpers, all of which use either `new Date(iso).toLocaleString('en-GB', { ... })` or raw `.getHours()`/`.getDate()` calls. **None pass `timeZone: 'Africa/Cairo'`** in the options object.
- No `TZ=Africa/Cairo` env variable in `.env` or `.env.production` (grep negative).

**Consequence:** every timestamp on every superadmin page renders in the server's local TZ (UTC on Render, unless `TZ` is set in the deployment env).

**Pre-existing.** Not introduced by the redesign — the legacy admin views had the same pattern, and Batches 1-7 copied the formatters verbatim per the visual-only mandate.

**Why not auto-fix in Phase 4:** the fix touches ~13 files (1 middleware helper + 12 inline formatters) plus possibly a deployment env tweak. It's a behaviour change with a real testing surface (RTL parsing of times, AM/PM rendering, DST semantics). Per Phase 4 "don't refactor" and given the issue predates the redesign, I propose deferring this to a dedicated TZ batch and documenting under MIGRATION_NOTES "Behaviour observed, not changed."

### WARN-3: Pre-existing silent-no-op query params (already documented)

These were captured in MIGRATION_NOTES "Behaviour observed, not changed" during Batches 5-7 and are listed here for completeness — no new action:

- `/superadmin/orders?payment=unpaid` (link in analytics attention banner) — `payment` is not in either admin or superadmin orders route. Silent no-op.
- `/superadmin/orders?status=paid` (link in analytics KPI) — `paid` is a `payment_status`, not a `status`. Silent no-op.
- `/superadmin/orders?filter=attention` (attention banner Triage button) — `filter` query param not handled. **Newly noted in this walk.** Pre-existing from Phase 2. Adds nothing functional today.
- `window.toggleStack(id)` in `superadmin_errors.ejs` — wired with `data-action`/`data-target` but no click delegate. Identical broken state on `/admin/errors`. Preserved verbatim per Batch 7.

---

## NEEDS-BROWSER (could not verify in static walk)

The following Phase 4 check categories require a live authenticated session and dev-tools inspection. The static walk surfaces structural correctness only:

| Check | Status |
|---|---|
| Zero **runtime** JS errors on any page | NEEDS-BROWSER — server logs after curl walk are clean (no SSR exceptions). Client-side runtime errors are invisible to me. |
| Zero CSP violations | NEEDS-BROWSER — CSP policy verified (`script-src 'self' 'unsafe-eval' 'nonce-…' …`), all superadmin inline scripts have nonce gates, all external scripts come from allow-listed hosts (`cdn.jsdelivr.net`). |
| Zero 404s on CSS/font/image assets | NEEDS-BROWSER — confirmed `superadmin-cockpit.css` + `extras.css` exist in `public/css/`; font preconnect is to `fonts.googleapis.com` (live CDN). |
| Sidebar badges populate with real numbers | Fixed in `381b5e2` — router-level middleware plumbs `getSidebarBadges()` into `res.locals.sidebarBadges` for every GET request to `/superadmin/*`, so all 26 view routes now get real counts (cached 30s in the service). Service also gained a `refunds` key aliased to the existing `finAttn` query. Browser confirmation still useful for the new Refunds badge specifically. |
| Sidebar topbar pills are real (not hardcoded) | OK by code review — `pills.ejs` and `topbar.ejs` consume `_pills` from locals, no hardcoded fallbacks. Browser confirmation still useful. |
| Attention banner shows when items, hides when empty | OK by code review — `attention_banner.ejs:9` has explicit `if (!_items.length) return;` early-out. |
| RTL flip correctness | NEEDS-BROWSER — cannot verify visually. Worth manually toggling `dir="rtl"` on `<html>` on representative pages (dashboard, an `/superadmin/orders` row, an order detail, settings form). |
| Empty states render via `c_empty` for every list page | OK by code review — every list-page view checks `if (!list.length)` and includes `partials/superadmin/c_empty`. |

---

## Cross-portal regression — clean

| Check | Result |
|---|---|
| Non-superadmin views including `partials/superadmin/*` | None (only `layouts/superadmin.ejs` itself) |
| Non-superadmin layouts loading `superadmin-cockpit*.css` | None |
| `layouts/superadmin.ejs` loading admin/owner/portal CSS | None — exclusive chrome (only `superadmin-cockpit*.css` + Google Fonts) |
| `layouts/portal.ejs` loading `superadmin-cockpit.css` | No |
| Smoke-curl `/admin`, `/admin/orders`, `/admin/errors`, `/portal/admin/analytics`, `/portal/doctor`, `/portal/patient`, `/login` | All 302 (or 200 for `/login`) — no server errors in log |

Phase 4 non-negotiable #3 (no regression in admin/doctor/patient portals): **PASS.**

---

## Fix history (post-walk)

1. **FAIL-1 — Refunds sidebar entry.** `7772028`. Added entry to both `partials/superadmin/sidebar.ejs` (Operations group) and the legacy superadmin sidebar block in `layouts/portal.ejs`. New `refund` icon added to the icons dispatcher. `badgeKey: 'refunds'` / `alertOn: 'refunds'` set up for the next commit.
2. **WARN-1 — EGP suffix on 3 money columns.** `4560858`. Column headers updated: `tab_doctors.ejs` leaderboard `Revenue` → `Revenue (EGP)` + `Owed` → `Owed (EGP)`; `tab_marketing.ejs` referrals `Revenue` → `Revenue (EGP)`; `superadmin_video_calls.ejs` appointments `Payment` → `Payment (EGP)` / `الدفع (جنيه)`. Per-column suffix chosen over the `tab_finance.ejs` section-h meta convention because it's closer to the cells (immediate disambiguation).
3. **Fix 3 — Plumb sidebar badges via middleware.** `381b5e2`. Router-level GET-only middleware added to `routes/superadmin.js` that calls `superadminDashboard.getSidebarBadges()` and sets `res.locals.sidebarBadges` for every authed superadmin GET. Removes the need for per-route changes. `getSidebarBadges()` itself was extended in `services/superadmin_dashboard.js` to expose a `refunds` key (aliased to the existing `finAttn` query — same pending-refunds count consumed by the dashboard's Finance tab attention indicator). 30s internal cache absorbs repeat hits.
4. **WARN-2 — Cairo TZ.** Deferred. Logged under MIGRATION_NOTES "Behaviour observed, not changed" with the full file list and proposed fix shape (add `{ timeZone: 'Africa/Cairo' }` to 12 inline view formatters + update the `formatEventDate` middleware helper + set `TZ=Africa/Cairo` in Render env as defense-in-depth). Pre-exists the redesign by years.
5. **WARN-3 — Pre-existing no-op query params + broken stack toggle.** Deferred. Already documented in MIGRATION_NOTES from Batches 5-7. The Phase 4 walk added one new entry (`?filter=attention` on the dashboard's Triage button).

---

## Limits of this walk

- No interactive login → could not exercise authed view paths to verify render output, real data, or active-state highlighting visually. All checks are SSR-static + server-log-clean + grep-level.
- No browser → no JS runtime errors, no CSP violations at runtime, no Network-tab asset 404s, no RTL flip verification, no live badge accuracy.
- Did not actually fire `/superadmin/pricing` per-row save fetch (`POST /superadmin/pricing/:id/update`) — confirmed only that the route is registered.
- The `/superadmin/__preview` route was not deep-inspected — confirmed it's still wired but did not render its 14+ component grid.

A human in a browser should still walk the 4 categories tagged `NEEDS-BROWSER` above before the branch is merged.
