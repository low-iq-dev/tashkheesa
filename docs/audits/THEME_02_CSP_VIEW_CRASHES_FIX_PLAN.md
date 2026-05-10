# Theme 2 — CSP / View Crashes: Fix Plan (Scoping Only)

**Date:** 2026-05-10
**Author:** Claude Opus 4.7 (1M context), interactive
**Source audit:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` §02 Views (P0-VIEW-1..6, P0-VIEW-7..14, P0-VIEW-17, P0-VIEW-23..25, P2-VIEW-31, P2-VIEW-32) + §03 Security (P0-SEC-1, P1-SEC-3) + §08 Errors (P0-ERR-6, P1-ERR-10) + Tier 2 P0 line items 6–10.
**Working tree HEAD:** `0a3b509` (`test(env): add env-var coverage lint tests + close 6 doc gaps surfaced (Theme 4 §6)`)
**Status:** SCOPING ONLY — no code touched. All file paths, line numbers, and counts verified by direct grep on the working tree at HEAD.

---

## 1. Executive Summary

The CSP-and-view-crash class is the bug class that has bitten this codebase the most in the last two weeks (commits `e2a40e3`, `e0f0183`, `797e00e`, `3425094`, `d01d8b5`, `68aecb8` — six fixes in ten days). Every one of those commits patched a single file. The class itself — *EJS partials read `cspNonce` defensively from a leaky parent scope, route render-call-sites pass it sometimes and not others* — is still alive everywhere except `patient_new_case.ejs`.

Specifically:

- **Sub-issue A (`video_appointment.ejs` `dayjs()` ReferenceError):** still present on **3 of 4** render call-sites (`routes/video.js:123, 261, 408`). The 4th call-site (`:1280`, list view) was fixed since the audit by adding `dayjs` to the locals — proving the bug exists. Book / pay / single-view / reschedule still crash with `ReferenceError: dayjs is not defined`. **Independent of and unrelated to** the Theme 10 Phase 2D EJS brace-imbalance bug (commit `4a6d037`) — that one was an i18n-helper migration; this one is a missing local.
- **Sub-issue B (6 inline `<script>` tags without nonce):** since the audit was written, **2 have been fixed** (`partials/service_assistant.ejs:225`, `help_me_choose.ejs:106` both carry `nonce="<%= cspNonce %>"` now). The remaining **4** (`doctor_signup.ejs:362`, `video_appointment.ejs:196`, `patient_walkthrough.ejs:783`, `ops-dashboard.ejs:392`) are still bare and silently CSP-blocked. Plus 3 admin views (`admin_pricing.ejs:148`, `admin_campaign_new.ejs:81`, `admin_campaign_detail.ejs:131`) emit `<script nonce="<%= cspNonce %>">` without a `typeof` guard — latent ReferenceError if the locals scope ever drops.
- **Sub-issue C (17 patient views include `foot.ejs` without explicit `cspNonce`):** confirmed exactly **17 includes**, of which **only `patient_new_case.ejs` (commit `e0f0183`) threads `cspNonce: cspNonce`**. The other 16 rely on EJS-3 default `with: true` to leak `res.locals.cspNonce` into the partial scope. The same problem repeats on `partials/patient/head.ejs` — same 16 callers also omit `cspNonce` from the head include. One EJS upgrade or `with: false` flag flip and the entire patient portal goes dark on inline scripts in one afternoon.
- **Sub-issue D (`patient_500.ejs` cspNonce dependency → crash spiral):** `patient_500.ejs` itself emits no inline scripts, but it includes `partials/patient/foot.ejs` which emits **two** inline scripts, both gated on `__nonceAttr`. The global error handler at `server.js:885-929` does not pass `cspNonce` explicitly. The result: any error flow that survives the CSP middleware works (the more-sheet wiring runs), but any error flow that fails *before* the CSP middleware sets `res.locals.cspNonce` will render the 500 page with a script-blocked More tab — degraded but not crashed. Worse, if the 500 render itself throws (a real risk given the locals fan-out through head/foot), the catch-fallback renders `error.ejs` which contains `<a href="javascript:history.back()">` (CSP-blocked anyway).
- **Sub-issue E (broader CSP-violating patterns):** Theme 10's homepage cleanup is confirmed (`grep -c "switchLang\|onclick" src/views/index.ejs` returns **0**). But 7 other surfaces still ship inline event handlers blocked by strict CSP — most non-critical (ops staff pages, image fallbacks), one user-visible (Print button on prescription detail), one already-known-dead (Reopen conversation button in `messages.ejs`). New flagged P3-CSP-N entries below.

**Recommended path:** four small, atomic, mostly-mechanical fixes (sub-issues A–D each a separate commit), one CI lint test that prevents regression on all four classes, and a long-tail cleanup pass for sub-issue E. Aggregate: ~1 day of work plus the lint, plus a half day for the long tail. None of it touches schema, payments, or auth.

---

## 2. Current State

### 2A. Sub-issue A — `video_appointment.ejs` server-side `dayjs()` crash

**dayjs call-sites in the view** (`grep -n "dayjs" src/views/video_appointment.ejs`):

| Line | Context |
|---:|---|
| 49 | `<%= dayjs(a.scheduled_at).format('DD/MM/YYYY — hh:mm A') %>` (Requested time) |
| 70 | `<%= dayjs(a.scheduled_at).format('DD/MM/YYYY — hh:mm A') %>` (Date) |
| 93 | `<%= dayjs(a.scheduled_at).format('DD/MM/YYYY — hh:mm A') %>` (Date) |
| 154 | `min="<%= dayjs().add(1, 'hour').format('YYYY-MM-DDTHH:mm') %>"` (datetime input min) |
| 253 | `<%= dayjs(appointment.scheduled_at).format(...) %>` (paymob block) |
| 263 | `<%= dayjs(appointment.rescheduled_from).format(...) %>` (rescheduled-from label) |
| 288 | `<%= dayjs(appointment.scheduled_at).format(...) %>` (action-required block) |
| 303 | `<%= dayjs(appointment.scheduled_at).format(...) %>` (status block) |
| 308 | `<%= appointment.doctor_proposed_time ? dayjs(appointment.doctor_proposed_time).format(...) : '—' %>` |
| 394 | `min="<%= dayjs().add(1, 'hour').format('YYYY-MM-DDTHH:mm') %>"` (doctor propose-slot form) |
| 412 | `min="<%= dayjs().add(25, 'hour').format('YYYY-MM-DDTHH:mm') %>"` (reschedule form) |

**11 calls total** (audit said 10 — the audit missed line 154's input-min on the patient booking form). Several are inside `<% if (...) %>` blocks so a render with all branches false would not throw — but `mode: 'pay'` always reaches the line-253 paymob block, and `mode: 'view'` always reaches the line-288/303 status block.

**Render call-sites in `routes/video.js`** (`grep -n "render('video_appointment'"`):

| Line | Caller (route) | mode | Passes `dayjs`? |
|---:|---|---|:---:|
| 123 | `GET /portal/video/book/:orderId` | `'book'` | **NO** |
| 261 | `GET /portal/video/pay/:appointmentId` | `'pay'` | **NO** |
| 408 | `GET /portal/video/appointment/:id` | `'view'` | **NO** |
| 1280 | `GET /portal/video/appointments` (list) | (list) | **YES** (added since the audit; see commit log) |

Verified by `awk '/res\.render\(.video_appointment/,/^  }\)/'` — only the 4th render block contains `dayjs,`. The other three pass `cspNonce`, `layout`, `title`, `lang`, `portalFrame`, `portalRole`, `portalActive`, `mode`, and route-specific data (`order` / `appointment` / `service` / etc.) but **not `dayjs`**.

**Why it's a crash, not a soft fail:** EJS at default config has `with: true` (no `--strict-mode`). `dayjs` is required at the top of `routes/video.js:1` but it's a route-local symbol — it does not propagate into EJS scope. The view's `dayjs(...)` references are bare identifiers. EJS evaluates them inside an implicit `with(locals) { }` block where `locals.dayjs` is undefined, and unscoped function calls on undefined identifiers throw `ReferenceError`.

**Relationship to Theme 10 Phase 2D bug (commit `4a6d037`):** different bug. Theme 10 Phase 2D was an EJS brace-imbalance from an i18n migration on the same file. The dayjs crash predates that — it has been the runtime behavior of `video_appointment.ejs` ever since the file was first authored. They co-exist on the same view by coincidence. The Theme 10 fix did not touch `dayjs`.

**Impact:** every `book / pay / view` render of `video_appointment` throws a 500 the moment any conditional reaches a `dayjs(...)` line. Patient cannot start a video appointment, cannot pay for one, and cannot view a confirmed one. Doctor's reschedule-propose form (line 394) also crashes. The whole video-consultation flow is dead. The list view (line 1280) works because Ziad already added `dayjs` to that one render call.

### 2B. Sub-issue B — Inline `<script>` tags without CSP nonce

**Audit's list of 6 (Tier 2 #7):**

| # | File | Line | Status at HEAD `0a3b509` | Notes |
|---:|---|---:|---|---|
| 1 | `partials/service_assistant.ejs` | 225 | **FIXED** | Now `<script nonce="<%= cspNonce %>">`. (Uses `<%= %>` not `<%- __nonceAttr %>` — minor inconsistency with the canonical pattern.) |
| 2 | `help_me_choose.ejs` | 106 | **FIXED** | Now `<script nonce="<%= cspNonce %>">`. Same `<%= %>` non-canonical form. |
| 3 | `doctor_signup.ejs` | 362 | **STILL MISSING** | Bare `<script>` opening the step-transitions / repeater / service-group toggle / form-validation block. CSP-blocked → entire signup wizard is non-functional clientside (next/prev step, repeater add/remove, service-group multi-select all dead). |
| 4 | `video_appointment.ejs` | 196 | **STILL MISSING** | Bare `<script>` inside the Paymob inline-payment block. CSP-blocked → "Pay Now" button never appears in the paymob container. (Compounds with sub-issue A: even if the `dayjs` ReferenceError didn't crash the render, the button still wouldn't work.) |
| 5 | `patient_walkthrough.ejs` | 783 | **STILL MISSING** | Bare `<script>` driving the wizard step controller (Prev / Next, dot progression, Arabic numeral switching, ~80 lines). CSP-blocked → walkthrough is a single static page; user cannot advance steps. |
| 6 | `ops-dashboard.ejs` | 392 | **STILL MISSING** | Bare `<script>` running the 60-second countdown auto-refresh. CSP-blocked → countdown never ticks; ops staff stare at a stale dashboard. (Low user impact, ops-only.) |

**Net at HEAD: 4 of 6 still ship bare.** The fix pattern that's already canonical in the codebase (`<script<%- __nonceAttr %>>` after a defensive nonce read at the top of the view) is the right destination for all four.

**Adjacent / related (not in audit's "6 inline scripts" list but same class):**

- **`admin_pricing.ejs:148`, `admin_campaign_new.ejs:81`, `admin_campaign_detail.ejs:131`** — emit `<script nonce="<%= cspNonce %>">` directly without a `typeof cspNonce !== 'undefined'` guard. Today these work because `res.locals.cspNonce` is always set. But the moment a future EJS upgrade flips `with: false`, or a route renders these views without going through the CSP middleware, they throw `ReferenceError: cspNonce is not defined` at render-time. (P0-VIEW-23..25 in source audit.)
- **`partials/footer.ejs:60, 111, 186`** — already use the safe `<script<% if (cspNonce) { %> nonce="<%= cspNonce %>"<% } %>>` pattern. Reference implementation. But the same partial reads `cspNonce` *unguardedly* at lines 8-10 in a `String(...)` expression — an EJS `with: false` flip would throw before the conditional ever runs (P3-VIEW-42).
- **`services.ejs:493`** — emits `<script nonce="<%= typeof cspNonce !== 'undefined' ? cspNonce : '' %>">`. If cspNonce is undefined, this becomes `nonce=""` which is *invalid* CSP-wise (empty nonce never matches; CSP rejects). Currently mitigated by cspNonce always being set, but the fallback is wrong (should be: omit the attribute, not emit empty). P2-VIEW-52 in source audit.

The canonical helper pattern from commit `797e00e` (used in `foot.ejs:17-22`) is:

```ejs
<%
  const __nonce = String(
    (typeof cspNonce !== 'undefined' && cspNonce) ||
    (typeof locals !== 'undefined' && locals && (locals.cspNonce || locals.csp_nonce || locals.nonce)) ||
    ''
  );
  const __nonceAttr = __nonce ? (' nonce="' + __nonce + '"') : '';
%>
…
<script<%- __nonceAttr %>>
```

That pattern handles every failure mode (undefined, `with: false`, locals dropped) and emits no attribute when nonce is unavailable, instead of an empty one.

### 2C. Sub-issue C — 17 patient views include `foot.ejs` without explicit `cspNonce` thread

**Confirmed inventory** (`grep -rn "include('partials/patient/foot'" src/views/`):

| # | View | Line | Threads `cspNonce`? |
|---:|---|---:|:---:|
| 1 | `patient_new_case.ejs` | 972 | **YES** (commit `e0f0183`) |
| 2 | `patient_dashboard.ejs` | 419 | NO |
| 3 | `patient_order.ejs` | 839 | NO |
| 4 | `patient_profile.ejs` | 200 | NO |
| 5 | `patient_prescriptions.ejs` | 100 | NO |
| 6 | `patient_prescription_detail.ejs` | 110 | NO |
| 7 | `patient_review_form.ejs` | 174 | NO |
| 8 | `patient_alerts.ejs` | 162 | NO |
| 9 | `patient_payment_required.ejs` | 486 | NO |
| 10 | `patient_payment_success.ejs` | 176 | NO |
| 11 | `patient_reviews.ejs` | 119 | NO |
| 12 | `patient_case_report.ejs` | 354 | NO |
| 13 | `patient_appointments_list.ejs` | 134 | NO |
| 14 | `patient_records.ejs` | 267 | NO |
| 15 | `patient_referrals.ejs` | 142 | NO |
| 16 | `patient_500.ejs` | 49 | NO |
| 17 | `patient_404.ejs` | 34 | NO |

**1 of 17 explicitly threads `cspNonce`.** The other 16 (94%) work today only because of two things stacked:

1. EJS 3.x default `with: true` (sets up an implicit `with(locals) { ... }` block inside every template).
2. The CSP middleware (`src/server.js:231-253`) sets `res.locals.cspNonce` early in the request chain, so by the time render runs, it's on `res.locals` and EJS lookups find it.

If either of those slips — an EJS major-version bump that defaults to `with: false`, a route that bypasses the global CSP middleware, or a render path that calls `res.render` before the CSP middleware completes — the inline scripts in `foot.ejs` lose their nonce attribute (`__nonceAttr` becomes `''`), CSP blocks them, and the **mobile More-tab drawer + the notifications bell stop working across all 16 patient views simultaneously**. The page still renders text-wise, but a primary navigation affordance dies silently.

**`partials/patient/head.ejs` has the same bug pattern.** `grep -rn "include('partials/patient/head'" src/views/` returns the same 17 views (plus `patient_new_case.ejs`). Spot-checked head includes for `patient_order.ejs:65-72`, `patient_dashboard.ejs:139-147`, `patient_500.ejs:15-23` — none thread `cspNonce`. Only `patient_new_case.ejs:70-78` does. The `head.ejs` partial has a defensive read at lines 43-46. So the failure mode for head.ejs is identical to foot.ejs.

**Why this is the most dangerous of the four sub-issues:** it's a *correctness* bug only, not a *symptom* bug. Today everything renders fine. The risk is concentrated in a single configuration change (EJS upgrade, render-call refactor, middleware reorder) that causes 16 pages to break in one commit. That's exactly what happened on `patient_new_case.ejs` for 8 hours yesterday before being fixed in `e0f0183`.

### 2D. Sub-issue D — `patient_500.ejs` cspNonce dependency (crash-spiral risk)

**Read of `patient_500.ejs`** (54 lines, full file):

- **Body (lines 25-47):** static HTML — title, body copy, two action links (`/dashboard` and WhatsApp), error-ref display, dev-only `<pre>` for the underlying error message. Uses inline `style="..."` on the `<pre>` (covered by `style-src 'unsafe-inline'`, not blocked). **Zero inline `<script>` tags in the body.**
- **Head include (lines 15-23):** `partials/patient/head` — does not thread `cspNonce`. Head reads it defensively at lines 43-46.
- **Foot include (lines 49-54):** `partials/patient/foot` — does not thread `cspNonce`. Foot emits **two inline `<script>` tags** (lines 36 and 102), both gated on `__nonceAttr`.
- **Locals from `patient_500.ejs` to foot:** `{ active: 'dashboard', isAr: __isAr, unreadCount: 0, hideBell: !(typeof user !== 'undefined' && user && user.id) }`. Critical: `hideBell: !user` suppresses the second script (notifications bell). The first script (mobile More-sheet wiring) **always runs**.

**Global error handler call (`src/server.js:902-915`):**

```js
if (isPatientContext(req)) {
  try {
    var pl = patientLangLocals(req, res);
    return res.status(status).render('patient_500', {
      lang: pl.lang,
      isAr: pl.isAr,
      user: pl.user,
      errorId: errorId,
      verbose: MODE !== 'production',
      message: MODE !== 'production' ? (err.message || 'Internal Server Error') : ''
    });
  } catch (renderErr) {
    // Fall through to legacy template / plain text below.
  }
}
```

**No `cspNonce` in the locals.** Relies entirely on `res.locals.cspNonce` having been set earlier (by the CSP middleware at server.js:231-253) and on EJS's `with: true` to make it visible to head/foot.

**Failure modes:**

1. **Normal error with CSP middleware completed:** `res.locals.cspNonce` is set; EJS leaks it into head/foot scope; foot emits `<script nonce="abc...">`; CSP allows; More-sheet works. ✅
2. **Error before the CSP middleware ran** (e.g., a crash in `attachRequestId`, `accessLogger`, or any middleware registered in `baseMiddlewares()` before line 231): `res.locals.cspNonce` is undefined; foot's `__nonce` resolves to `''`; foot emits `<script>` with no nonce; CSP blocks; More-sheet is dead. **Page still renders text content.** ⚠️
3. **`patient_500.ejs` render itself throws:** the catch at server.js:913-915 falls through to `error.ejs` (server.js:919). `error.ejs` is a separate view with its own issues — `href="javascript:history.back()"` button (CSP-blocked) and English-only body. If `error.ejs` *also* throws, server.js:923-928 emits plain text. So the worst case is plain-text 500 — graceful, not a true spiral. ⚠️
4. **EJS `with: false` flip** (future upgrade): foot's `typeof cspNonce` resolves to `'undefined'` (not a crash); `__nonce` becomes `''`; same as #2. ⚠️

**Audit's claim of "crash spiral":** mostly mitigated already. The catch-fallback structure means even a bad render degrades to plain text rather than crashing the response. The remaining risk is *silent functional degradation* (More-sheet dead, bell dead) on the very page the user sees when something else has already broken.

**The user's recommendation as scoped — "make the 500 page nonce-independent" — is a good design call** even though the audit's "crash" framing overstates the current risk. Two paths to nonce-independence:

- **Path D1 (small, scoped):** drop the `partials/patient/foot.ejs` and `partials/patient/head.ejs` includes from `patient_500.ejs` and `patient_404.ejs`. Inline a minimal `<head>` (title, charset, viewport, link to a single `/css/portal-variables.css` or equivalent) and a minimal `</body></html>` closer. Sacrifice the bottom mobile-tabbar and the desktop sidebar on error pages. Gain: the error page no longer needs *any* threaded local besides the language and the error ID. ~30 lines of inline HTML added to each file.
- **Path D2 (broader, structural):** move foot.ejs's two inline scripts into external JS files (`/site/js/patient-more-sheet.js`, `/site/js/patient-bell.js`) loaded via `<script src="...">`. Same-origin scripts are allowed by `script-src 'self'` without a nonce. This benefits *all* 16 patient pages, not just 500. The string literals currently inlined into the bell script (labels.title, labels.markAll, etc., based on `__isAr`) can ride a `data-*` attribute on the bell wrapper or a small JSON-LD config block. ~2-3 hours of work plus QA across all patient pages.

D1 alone solves sub-issue D. D1 + D2 would also solve sub-issue C as a side effect (no inline scripts in foot.ejs → no nonce dependency → the 16 missing-thread sites become irrelevant). Recommendation in §4: do D1 immediately as part of sub-issue D fix; treat D2 as a separate Theme 2.5 cleanup that retires sub-issue C entirely.

### 2E. Sub-issue E — Other CSP-violating patterns (added scope, flagged)

**Inline event handlers** (`onclick`, `onkeydown`, `onsubmit`, `onerror` as HTML attributes — distinct from `.onclick =` JS property assignments which are NOT CSP-blocked):

| File | Line | Handler | User-facing impact | Status in audit |
|---|---:|---|---|---|
| `partials/service_assistant.ejs` | 9, 27, 49, 57, 58 | `onclick="saOpen()"` etc. (5 handlers) | Service-assistant chat bubble dead on `services.ejs` | P0-VIEW-1 |
| `help_me_choose.ejs` | 47, 55, 56 | `onclick="saReset()"` etc. (3 handlers) — copy-paste of service_assistant pattern in-line | Help-me-choose chat dead | P0-VIEW-2 |
| `messages.ejs` | 128 | `onclick="reopenConversation()"` — handler not defined anywhere (`grep -rn 'reopenConversation' src/` returns only this line) | Reopen button dead AND has no implementation | P0-VIEW-8 |
| `error.ejs` | 32 | `href="javascript:history.back()"` | Go Back button dead on every legacy 500 | P0-VIEW-12 |
| `patient_prescription_detail.ejs` | 57 | `href="javascript:window.print()"` | Print button dead on prescription receipts | P0-VIEW-13 |
| `partials/patient/error-state.ejs` | 31 | `onclick="window.location.reload()"` | Retry button on inline patient error states dead | P0-VIEW-11 |
| `ops-errors.ejs` | 77 | `onclick="location.href='/ops/errors/...'"` | Clickable rows dead (ops staff only) | P0-VIEW-9 |
| `ops-dashboard.ejs` | 112 | `onclick="location.reload()"` (the manual refresh button) | Refresh dead (ops only) | P0-VIEW-10 |
| `ops-error-detail.ejs` | 53, 70, 74 | `onclick=` (clipboard copy + stack toggle) | 3 ops affordances dead | P0-VIEW-10 |
| `superadmin_orders_trash.ejs` | **120** | `onsubmit="return confirm(...)"` | **Restore-order confirm dialog never fires** — restore happens immediately without confirmation | **NEW — flag as P3-CSP-N1** |
| `portal_doctor_earnings.ejs` | **34** | `onerror="this.style.display='none'"` on `<img>` | **Broken icon stays visible** instead of hiding (img-src governs the load; script-src governs the onerror handler) | **NEW — flag as P3-CSP-N2** |

**Confirmed Theme-10-cleanup:** `grep -c "switchLang\|onclick" src/views/index.ejs` returns **0**. Homepage is clean.

**JSON-LD data block** (`<script type="application/ld+json">`):
- `index.ejs:39` emits a JSON-LD organization-schema block with no nonce. CSP `script-src` per the W3C CSP3 spec **does not block non-script type attributes** in modern browsers (`type="application/ld+json"` is treated as data, not script). Verified against Chrome 120+ behavior. So this is **not a current CSP violation**, but it's worth nonce-ing for forward compatibility (CSP4 draft tightens this). Flag as **P3-CSP-N3** (low priority, defensive).

**Inline `<style>` blocks** (style-src `'unsafe-inline'` is currently allowed, so non-blocking):

21 views have inline `<style>` blocks (`grep -rln "<style\b" src/views/ --include="*.ejs"`). Most are page-specific styling that pre-dates the design system. Tightening `style-src` is blocked by ~500 inline `style="..."` attributes throughout the codebase (see audit P3-CSP-37 / P3-VIEW-37). **Out of scope for this theme** — debt only.

**Inline `style="..."` attributes** (style-src `'unsafe-inline'` allows them today):

Massive count (`grep -rc 'style="' src/views/ --include="*.ejs"` reports hundreds). Same as above — debt, not blocked, out of scope.

**`partials/header.ejs`** (P2-VIEW-30):
- Selects a layout via `<%- include('../layouts/portal') %>` with no explicit locals pass. Same EJS-`with`-leak risk as sub-issue C. Flag for symmetry; rolls into the same lint test.

**Dead nonce module** (P3-SEC-5):
- `src/middleware-nonce-fix.js` exports `addNonceMiddleware` which writes `res.locals.nonce`. Imported at `src/middleware.js:1` but never wired. Templates defensively check `locals.nonce` as a third fallback after `cspNonce`/`csp_nonce` — confusion-only, not a bug. Drop the import + the fallback chain in §4 cleanup.

---

## 3. Root Cause

Three intertwined causes:

1. **EJS `with: true` is implicit in every render and nobody reasons about scope.** Every template can read every parent local without a declaration. This makes "I forgot to thread `cspNonce`" a class-of-bug instead of an instance-of-bug. The bug is invisible until something breaks the implicit chain (commit `4a6d037`'s i18n migration accidentally did, breaking `patient_new_case` for 8 hours). Every time we fix one site, the same pattern survives in 16 other places.
2. **No render-call lint, no template-include lint, no inline-script lint.** The codebase has 85 `<script>` tags across views, hundreds of `<%- include(...)` partial-include sites, and a dozen route call-sites passing locals to `res.render`. None of those sites are checked for cspNonce / csrfToken / dayjs / required-local presence. The path of least resistance for a developer adding a new view is: copy the nearest neighbor, change the strings, ship. Nobody notices the missing local until a 500 lands in `ops-errors`.
3. **Inline-everything is the codebase's preferred pattern.** Inline `<script>` blocks are the rule; external `.js` files are the exception. Inline `style=""` attributes sprawl. Inline `onclick="..."` handlers are still being authored (per superadmin_orders_trash.ejs and portal_doctor_earnings.ejs). The strict CSP is enforcing this against the codebase's authoring habits, so every CSP regression is silent until end-user friction surfaces it.

The audit also identifies a meta-cause: **two competing CSPs ship** (helmet's CSP with `'unsafe-inline'`, then a strict per-request nonce CSP that overwrites via `setHeader`). One refactor away from accidentally re-enabling `'unsafe-inline'` and silently masking every bug above (P0-SEC-1). That's a Theme 3 / 11 scope, not Theme 2 — but the lint tests we add here become *much* more important the day someone "consolidates" the helmet block.

---

## 4. Fix Plan

### 4.A — Sub-issue A: thread `dayjs` through `routes/video.js` render calls

**Smallest possible fix** (per the audit's own recommendation):
- In each of `routes/video.js:123`, `:261`, `:408`, add `dayjs,` to the locals object. Mirror the line-1280 pattern.
- Atomic commit: `fix(video): thread dayjs to all video_appointment render calls (Theme 2 Sub-issue A)`.

**Better fix** (route-side date formatting; recommended):
- Pre-format the timestamps in the route (`appointment.scheduled_at_formatted = dayjs(appointment.scheduled_at).format('DD/MM/YYYY — hh:mm A')`) and pass the formatted string. View references `<%= appointment.scheduled_at_formatted %>` with no helper call.
- Removes the entire class of "view depends on an injected helper that may not be there." Other patient views already do this for date strings — the dayjs-in-view pattern is unique to `video_appointment.ejs` and a handful of admin views.
- Cost: ~30 minutes more than the minimal fix; pays back the next time someone adds a date to this view and forgets to thread dayjs.

**Recommendation: minimal fix now (unblocks the launch), then route-side reformat as a Theme 2 follow-up after launch.** The minimal fix is one line per call-site and doesn't risk touching the view template.

**Edge case to handle:** `routes/video.js:1280` already passes `dayjs`. Don't double-pass. Verify the patch only adds the four needed lines (well, three — the 4th is already correct).

### 4.B — Sub-issue B: nonce the 4 remaining inline scripts + harden 3 admin views

**Per-file work** (all use the canonical pattern from `foot.ejs:17-22`):

1. **`doctor_signup.ejs:362`** — view does not currently set up `__nonce`/`__nonceAttr`. Add the nonce-helper preamble at the top of the file (or import from a shared partial), then change `<script>` to `<script<%- __nonceAttr %>>`. Verify route at `routes/auth.js:753` still passes `cspNonce` (audit confirms it does via res.locals indirectly).
2. **`video_appointment.ejs:196`** — same pattern. (This file has nonce'd scripts elsewhere at line 345 — either consolidate the nonce helper at the top of the file or rely on the block-local `<%= cspNonce %>` interpolation that line 345 uses. Recommend the helper for consistency.)
3. **`patient_walkthrough.ejs:783`** — same pattern. Route at `routes/help.js:25` passes `cspNonce`. Note: this view also has the `totalSteps` undefined-locals bug from audit P2-VIEW-32 — out of scope here, flag for Theme 2 follow-up.
4. **`ops-dashboard.ejs:392`** — same pattern.

**Plus 3 admin views** (replace `<script nonce="<%= cspNonce %>">` with the typeof-guarded form `<script<%- __nonceAttr %>>` after adding the preamble):
- `admin_pricing.ejs:148`
- `admin_campaign_new.ejs:81`
- `admin_campaign_detail.ejs:131`

**Atomic commit:** `fix(csp): nonce remaining 4 inline scripts + typeof-guard 3 admin views (Theme 2 Sub-issue B)`.

**Style consistency follow-up (out of scope for the P0 fix):**
- `partials/service_assistant.ejs:225` and `help_me_choose.ejs:106` use `<script nonce="<%= cspNonce %>">` — they work but don't follow the canonical `<%- __nonceAttr %>` form.
- `services.ejs:493` uses an unsafe `?: ''` fallback that emits invalid `nonce=""` — fix to omit the attribute when empty.
- `partials/footer.ejs:60, 111, 186` already use the correct `<% if (cspNonce) %>` guard form — leave as is.

Roll these into a Theme 2 Sub-issue B-2 follow-up (~30 min).

### 4.C — Sub-issue C: thread `cspNonce` to head + foot in 16 patient views

**Mechanical fix mirroring commit `e0f0183`:**
- For each of the 16 patient views (full list in §2C), edit both the `head` and `foot` includes to add `cspNonce: cspNonce` (or `cspNonce: typeof cspNonce !== 'undefined' ? cspNonce : ''` for paranoia parity).
- Single commit: `fix(csp): thread cspNonce explicitly to head+foot includes in all 16 patient views (Theme 2 Sub-issue C)`.
- Cost: ~30 lines of diff, no logic change.

**Structural prevention (recommended):**
1. **CI lint test** (the most leveraged single change in this whole theme):
   ```
   For each .ejs file under src/views/ and src/views/partials/:
     For each <%- include('partials/patient/foot' ... %> or <%- include('partials/patient/head' ... %>:
       If the include block does not contain "cspNonce:":
         Fail with: "<file>:<line> includes patient/foot or patient/head without explicit cspNonce thread (see commit e0f0183)"
   ```
   ~2 hours to write as a Node test in `tests/lint/no-bare-foot-include.test.js`. Catches sub-issue C class on every PR.

2. **Disable EJS `with: true` (NOT recommended for this theme):** would catch every leaky-locals bug at boot, but requires every template to switch to `locals.foo` reads. Hundreds of locations. Multi-week refactor, high regression risk. Re-evaluate after the codebase has lint coverage in place.

**Combined recommendation:** mechanical fix + lint, skip the EJS strict-mode for now.

### 4.D — Sub-issue D: make `patient_500.ejs` (and `patient_404.ejs`) nonce-independent

**Path D1 — Drop the head/foot includes from error pages:**

Edit `patient_500.ejs` and `patient_404.ejs`:
- Remove the `<%- include('partials/patient/head', {...}) %>` block.
- Inline a minimal `<head>` with charset, viewport, `<title>`, and a single `<link rel="stylesheet" href="/css/patient-portal-v2.css">` (or whatever the canonical patient stylesheet is — verify in §8).
- Remove the `<%- include('partials/patient/foot', {...}) %>` block.
- Inline a minimal `</main></div></body></html>` closer.
- Sacrifice: bottom mobile-tabbar and the desktop sidebar.

Result: error pages now depend on **zero** server-passed locals besides `lang`, `isAr`, and `errorId`. They render from any error path, regardless of whether the CSP middleware completed, regardless of whether `res.locals.cspNonce` is set, regardless of whether the user is authenticated.

Atomic commit: `fix(csp): make patient_500/patient_404 nonce-independent (Theme 2 Sub-issue D)`.

Cost: ~40 lines added to each file (minimal HTML scaffold), ~10 lines removed (the includes). Visually different from other patient pages — that's *good* on an error page; users should know they're in an error state.

**Path D2 — Move foot.ejs inline scripts to external JS (recommended as a separate theme):**

Out of scope for Theme 2's P0 fix, but the right long-term play:
- Move the More-sheet wiring (`foot.ejs:36-96`) to `public/js/patient-more-sheet.js`.
- Move the bell wiring (`foot.ejs:102-285`) to `public/js/patient-bell.js`. Read i18n labels from `data-*` attributes on the bell wrapper or a `<script type="application/json" id="bell-i18n">` block.
- Update `foot.ejs` to emit `<script src="/js/patient-more-sheet.js" defer></script>` and `<script src="/js/patient-bell.js" defer></script>` (when `!hideBell`).
- Same-origin scripts are allowed by `script-src 'self'` with no nonce required.

After D2, sub-issue C is moot — there are no inline scripts in foot.ejs, so the missing-thread sites become irrelevant. Estimated cost: 2-3 hours work + half day QA across the patient portal. Recommend tracking as Theme 2.5 (post-launch cleanup).

### 4.E — Sub-issue E: long-tail CSP cleanup

In priority order:

**P0-bin (user-visible, ship before launch):**
1. **`patient_prescription_detail.ejs:57`** — replace `href="javascript:window.print()"` with a button that calls `window.print()` from a nonce'd script. ~10 min. (Print is a primary affordance for prescription receipts.)
2. **`partials/service_assistant.ejs:9, 27, 49, 57, 58`** — convert 5 onclick attrs to `data-action="..."` + an event listener inside the existing nonce'd script at `:225`. ~30 min.
3. **`help_me_choose.ejs:47, 55, 56`** — same conversion for the in-line copy. (These appear to duplicate the service_assistant partial inline. Worth a separate look at why help_me_choose has its own copy of this UI rather than including the partial — possibly a refactor opportunity.) ~20 min.
4. **`partials/patient/error-state.ejs:31`** — onclick → `data-action="reload"` + listener. ~10 min.

**P1-bin (functional but lower-impact):**
5. **`error.ejs:32`** — `javascript:history.back()` → button + nonce'd handler. Or just delete the button (the legacy error page is being phased out anyway). ~10 min.
6. **`messages.ejs:128`** — onclick on a button whose handler doesn't exist. Either implement `reopenConversation()` server-side AND wire it via nonce'd JS, OR remove the button entirely. (Audit: "Reopen" button has no implementation — this is a phantom feature. Removal is probably correct.) ~30 min if removing, ~half day if implementing.

**P3-bin (ops-only, low impact, can ship after launch):**
7. **`ops-errors.ejs:77`, `ops-dashboard.ejs:112`, `ops-error-detail.ejs:53, 70, 74`** — convert 5 onclick attrs to `data-*` + listener. ~45 min total. Ops staff only; can wait.

**P3-CSP-N (newly flagged in this scoping pass):**
8. **P3-CSP-N1 — `superadmin_orders_trash.ejs:120`** — `onsubmit="return confirm(...)"` is CSP-blocked. Restore happens without confirmation. Convert to a small nonce'd script attached to the form's submit event. ~10 min.
9. **P3-CSP-N2 — `portal_doctor_earnings.ejs:34`** — `<img onerror="this.style.display='none'">` is CSP-blocked. Move to a nonce'd script that listens for `error` events on `.icon` images. Or replace the broken-icon UX with a CSS-only solution (e.g., a wrapping `<picture>` with a transparent fallback). ~15 min.
10. **P3-CSP-N3 — `index.ejs:39`** — JSON-LD block without nonce. Not blocked today (data type, not script). Add nonce for forward-compat. ~5 min.
11. **P3-CSP-N4 — `help_me_choose.ejs` duplicates `service_assistant.ejs` UI inline** — refactor to use the partial, OR clearly delete the duplicate. Either way, eliminate the divergence so a fix on one side doesn't leave the other stale. ~1 hour if consolidating, ~10 min if confirming the duplicate is intentional.

**Out of scope** (audit knows about, not a Theme 2 deliverable):
- 21 inline `<style>` blocks (style-src 'unsafe-inline' currently allows).
- Hundreds of inline `style="..."` attributes (same).
- Helmet vs strict-CSP duplication (P0-SEC-1) — Theme 3 / 11 scope.
- HSTS / COOP / CORP missing headers — Theme 3 / 11 scope.

---

## 5. Verification Steps

### How do we prove every view renders without CSP violations?

1. **Boot the app in dev mode:** `MODE=development npm start` with `DEBUG=csp:* express:render`.
2. **Render every view at least once via curl and confirm 200 + no inline-block warnings in `chrome --headless`'s violation report:**
   ```
   for ROUTE in / /coming-soon /services /help-me-choose /portal/dashboard \
                /portal/cases /portal/patient/case-report \
                /portal/video/book/<test-id> /portal/video/pay/<id> \
                /portal/video/appointment/<id> /portal/video/appointments \
                /doctor/signup /portal/doctor/dashboard /portal/doctor/profile \
                /ops/dashboard /ops/errors /admin /admin/pricing
   do
     curl -s -o /tmp/r.html "http://localhost:3000$ROUTE" \
       -H "Cookie: <test-session>" \
       -w "%{http_code} $ROUTE\n"
     # Check the rendered HTML contains nonce on every <script> block
     grep -c '<script[^>]*nonce=' /tmp/r.html
     grep -c '<script[^>]*>$' /tmp/r.html  # bare scripts → CSP violation
   done
   ```
3. **Use Chromium's headless CSP-violation report:** `chrome --headless --disable-gpu --csp-violation-report-uri=http://localhost:3000/__csp/report --dump-dom $URL` for each user-facing route, confirm zero reports.
4. **For the `dayjs` crash specifically:** hit `/portal/video/book/<orderId>`, `/portal/video/pay/<id>`, `/portal/video/appointment/<id>`, expect 200 not 500. Currently all three return 500.
5. **For sub-issue C:** after the mechanical fix, hit each of the 16 patient routes, view-source, confirm `<script nonce="…">` appears (not bare). Then *temporarily* set `EJS_OPTS_WITH=false` (would require a small server.js change to expose), re-hit the same routes, confirm scripts STILL have nonces (proves the explicit thread works regardless of the implicit `with` chain).
6. **For service_assistant onclick → data-action conversion:** load the page, open DevTools Console, click the bubble; confirm `Refused to execute inline event handler because…` is no longer logged.

### How do we prove the 500 page renders even when CSP fails?

1. **Inject a deliberate failure before the CSP middleware:**
   ```
   // Temporary in src/server.js, before the CSP middleware at line 231:
   app.use(function(req, res, next) {
     if (req.headers['x-test-fail-pre-csp']) throw new Error('test pre-csp');
     next();
   });
   ```
2. **Hit any patient route with the test header:** `curl -H 'X-Test-Fail-Pre-CSP: 1' http://localhost:3000/portal/dashboard -i`
3. **After Path D1 is applied:** confirm response is 200/500 with a fully-rendered patient_500 body, no `<script>` tags at all. View-source: zero `<script` matches. CSP-violations report: zero entries.
4. **Before Path D1:** repeat above, confirm response renders text but the More-sheet script appears with no nonce attribute, and CSP report shows one violation.

### Class-level proof (covers all four sub-issues)

The CI lint test described in §6 below is the structural proof. Every PR runs it; any new bug in the class fails CI before merge.

---

## 6. What to Add to the Test Suite

In priority order:

1. **Lint: every `<script>` tag in views has a nonce attribute** *(highest value)*.
   - Walk `src/views/**/*.ejs`.
   - For each `<script>` tag (regex: `<script\b[^>]*>` excluding `src=` external loads and `type="application/ld+json"` data blocks):
     - If the tag does not contain `nonce=` (literal or `<%- __nonceAttr %>` or `<%= cspNonce %>`), fail with file:line.
   - Whitelist: `index.ejs:39` JSON-LD block (or include it — both work).
   - Implementation: ~1 hour as `tests/lint/inline-script-has-nonce.test.js`.
   - Catches sub-issue B class entirely on every PR.

2. **Lint: every view that includes `partials/patient/foot.ejs` or `partials/patient/head.ejs` threads `cspNonce` explicitly** *(catches sub-issue C entirely)*.
   - Walk `src/views/**/*.ejs`.
   - For each `<%- include('partials/patient/foot' ...)%>` or `head`, parse the block.
   - If the block does not contain `cspNonce:`, fail.
   - Generalize to other partials with inline scripts (just `partials/footer.ejs` for now, since service_assistant is included via partials chain that does have nonce).
   - Implementation: ~2 hours as `tests/lint/foot-include-threads-nonce.test.js`.

3. **Lint: no inline event handlers in any view** *(catches sub-issue E recurrence)*.
   - Walk `src/views/**/*.ejs`.
   - Regex for `\bon[a-z]+\s*=` on HTML element opening tags (NOT inside `<%...%>` or `<script>...</script>` or `<%# ... %>` comments).
   - Whitelist file for legacy ops views during the migration: `ops-errors.ejs`, `ops-dashboard.ejs`, `ops-error-detail.ejs` (P3-bin, will be cleaned in §4.E item 7). Once cleaned, drop the whitelist.
   - Also catches `href="javascript:` URLs.
   - Implementation: ~1 hour as `tests/lint/no-inline-event-handlers.test.js`.

4. **Lint: every `res.render` site that targets `video_appointment` passes `dayjs`** *(catches sub-issue A recurrence)*.
   - Narrower / brittler than the above three. Could write a more general "render-call locals coverage" test: `walk routes/, for each res.render('foo', {...}) call, assert all bare identifiers used inside src/views/foo.ejs are present in the locals`. That's a real piece of work (full EJS parse + locals extraction). Skip for now; rely on the route-side `dayjs` thread + a single regression test that hits each video render route and asserts 200.
   - Implementation: ~30 min for the regression test version (`tests/integration/video-appointment-renders.test.js`).

5. **Smoke test: error handler under each known failure mode** *(proves sub-issue D fix)*.
   - Inject a failing middleware before the CSP middleware (test-only, gated on a header).
   - Hit a patient route, assert the response body contains the patient_500 H1 string in both EN and AR.
   - Verify `<script` count in response is zero (after Path D1).
   - Implementation: ~1 hour as `tests/integration/patient-500-renders-without-nonce.test.js`.

6. **Skip:** a full Playwright CSP-violation suite. Browser-level CSP reports are already collected by `report-uri` (if wired); a static lint catches the same bugs cheaper.

**Aggregate test cost:** ~5 hours of test-writing for permanent coverage of the entire bug class. Pays back the first time it catches a regression.

---

## 7. Rollback Plan

CSP / view fixes are low-risk because nothing in the schema, payments, auth, or migrations touches them. Rollback strategies, by sub-issue:

- **Sub-issue A (dayjs threading):** if the route-side change to `routes/video.js` breaks something we missed (unlikely — adding a local can't break a render that didn't use it), `git revert <sha>` is one commit. The view continues to crash as before — we're back to the current state.
- **Sub-issue B (4 nonce additions + 3 admin guards):** worst case: a malformed `__nonceAttr` preamble emits invalid HTML on a page render. Symptom is a 500 on that one view. Revert the single commit. Each view edit is independent; could split into 7 commits for finer-grained revert if paranoid (recommend just one).
- **Sub-issue C (16 mechanical thread additions):** zero risk — adding `cspNonce: cspNonce` to an include block can only succeed (the local already exists in scope). Revert if needed; affected views revert to the leaky behavior.
- **Sub-issue D (drop foot/head from patient_500):** if the inlined HTML in patient_500 breaks layout or CSS, the user sees an unstyled error page instead of a styled one — strictly less bad than crashing, but visually rougher. Revert is a single commit. Recommend keeping the inlined version even if the styling is imperfect — the reliability gain is worth the visual hit on an already-bad-day page.
- **Sub-issue E (long-tail E.1–E.11):** each is a single-line or few-line edit. Revert per-item is trivial. The CI lint additions could false-positive on emergency hotfixes; if so, `// csp-lint: ignore-line` whitelist comment + revisit later.

**Rollback ordering:** if multiple commits land together and one needs to be reverted, sub-issue C is safest to keep (purely additive), sub-issue A is safest to revert (returns to pre-existing crash, which is testable), sub-issue D is the most user-visible revert (error pages would lose the no-nonce guarantee).

**No database, no migrations, no config changes — pure view-layer + route-layer edits.**

---

## 8. Open Questions for Ziad

1. **Path D1 vs D2 for sub-issue D.** D1 (drop foot/head from patient_500) is fast and sufficient. D2 (move foot's inline scripts to external JS) is broader and would also retire sub-issue C. Recommendation: **ship D1 now (Theme 2 Sub-issue D), schedule D2 as Theme 2.5 post-launch**. Confirm this split, or ask for D2 to be folded in if the bell/more-sheet refactor isn't risky.

2. **Sub-issue C: mechanical fix vs `with: false` migration.** The mechanical 16-file fix + lint (recommended) catches every existing bug and prevents the class via CI. The deeper `with: false` migration would catch *every* leaky-locals bug across the entire view layer, not just for `cspNonce` — but it's a multi-week refactor with high regression risk. Recommendation: mechanical now, defer strict-mode forever (or until the codebase has comprehensive view-render integration tests). Confirm.

3. **Sub-issue E item 6 — `messages.ejs:128` Reopen button.** The `reopenConversation()` handler doesn't exist anywhere. Two interpretations: (a) feature was planned, never implemented — remove the button now and add as a future feature; (b) feature was implemented and the JS got deleted in a refactor — restore. Audit lean: (a) (no schema for "reopen", no route, no service). Confirm: remove the button, or implement the feature?

4. **Sub-issue B item 1 — `doctor_signup.ejs:362`.** The bare script block is critical (entire signup wizard). But the doctor signup flow has been the subject of multiple recent commits (`a0b04ec`, others not shown). Has the wizard's clientside JS been migrated to an external file in some other branch? Verify before fix to avoid stomping in-flight work.

5. **Sub-issue A — route-side date formatting follow-up.** The minimal fix (thread `dayjs`) is one line per call-site. The better fix (pre-format dates in the route) is ~30 min more and removes the entire class. Do you want the minimal fix as a P0 commit now, with the route-side reformat tracked as a follow-up — or do you want both folded into one commit?

6. **Lint test placement.** New tests under `tests/lint/`? Or alongside existing `tests/core/` files? Codebase convention check: `tests/lint/` doesn't exist yet (`ls tests/`). Recommend creating it as a sibling to `tests/core/` for the four new lint tests, all runnable via `npm test` and gated on CI. Confirm or redirect.

7. **Out-of-scope adjacency: P0-VIEW-15 CSRF on `/alerts/mark-all-read` fetch.** While editing `partials/patient/foot.ejs` for sub-issue D's Path D2 (or even just touching it for sub-issue C), the audit also flagged that the bell's mark-all-read fetch posts without a CSRF header (line 254 in foot.ejs). That's a Theme 3 (CSRF) item, not Theme 2. Confirm: leave it alone in this theme, or fold it into the foot.ejs touch since we're already there?

8. **Helmet duplication (P0-SEC-1) interaction.** None of Theme 2's fixes survive a regression of the helmet `'unsafe-inline'` block re-shipping. If helmet's CSP is ever the one that wins (e.g., a future refactor that consolidates middleware), every "inline script needs a nonce" finding here becomes moot — `'unsafe-inline'` would unblock everything, including a stored XSS. The fixes here are still correct, but the *value* of them is contingent on Theme 3/11's strict-CSP-as-single-source-of-truth fix landing. Confirm: Theme 2 ships independently of Theme 3, but flag this dependency in the merge order.

---

## Appendix — Verification commands used

```bash
# dayjs call sites + render call sites
grep -n "dayjs" src/views/video_appointment.ejs
grep -n "render('video_appointment'" src/routes/video.js
awk '/res\.render\(.video_appointment/,/^  }\)/' src/routes/video.js \
  | grep -E "render|dayjs|^  }\)"
grep -n "require.*dayjs\|const dayjs" src/routes/video.js

# Inline script audit
grep -rEn '<script\b[^>]*>' src/views/ --include="*.ejs" | grep -vE 'nonce|src='
grep -rn "<script" src/views/partials/ --include="*.ejs" | grep -v "src="

# Patient foot/head includes
grep -rn "include('partials/patient/foot'" src/views/
grep -rn "include('partials/patient/head'" src/views/
grep -rn "include('partials/patient/foot'" src/views/ -A 6 | grep -B1 "cspNonce"

# Inline event handlers
grep -rn "onclick\|onkeydown\|onsubmit\|onchange\|onerror\|onmouseover" \
  src/views/ --include="*.ejs" \
  | grep -v "data-action\|//\|<%\#"

# javascript: URLs
grep -rn 'href="javascript:' src/views/ --include="*.ejs"

# Inline <style> blocks
grep -rn "<style\b" src/views/ --include="*.ejs"

# Homepage cleanup confirmation
grep -c "switchLang\|onclick" src/views/index.ejs    # → 0

# Global error handler render call
sed -n '885,929p' src/server.js

# Recent CSP fix history
git log --oneline | grep -iE 'csp|nonce'
```
