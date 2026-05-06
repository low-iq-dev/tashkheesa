# Theme 3 — CSRF holes & public-surface auth: scoping & fix plan

**Date:** 2026-05-06
**Author:** Claude (scoping only — no code changes in this commit)
**Reference:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` §Tier 3 (items 11–14), §P0-ROUTE-1..4, §P0-SEC-7..8, §P1-SEC-9..10
**Scope:** four sub-issues (A) `/api/cases/intake` CSRF block, (B) marketing fetch() calls missing CSRF token, (C) `/public/orders` open mass-signup, (D) `/ops/agent/*` no-auth surface.

> ⚠️ **ALERT — pre-section-1**
> Sub-issue D confirms two **unauthenticated state-mutating routes** exposed on the public internet: `POST /ops/agent/ping` and `POST /ops/agent/log-tokens`. Anyone can insert rows into `agent_heartbeats` and `agent_token_log` with arbitrary text fields (200–2000 char caps). This is a live security issue but matches the existing audit finding (P1-SEC-9 / P0-ROUTE-4) — no scope expansion. Continuing with scoping only.

---

## 1. Executive summary

Theme 3 collects the four production-blocking holes in the CSRF / public-route layer. (A) The marketing landing-page intake `POST /api/cases/intake` 403s in production because `/api/cases/*` is missing from the CSRF exempt list — the route is a cross-origin server endpoint that cannot complete the cookie-token round-trip. Fix is a single line in `src/middleware/csrf.js` plus a dedicated rate limiter. (B) Three marketing pages (`help_me_choose.ejs`, `app_landing.ejs`) call `fetch()` without an `x-csrf-token` header even though their host pages render with a usable `csrfToken` local — they just don't read it. Fix is the existing `coming_soon.ejs:372–375` pattern, repeated four times. (C) `POST /public/orders` is an orphan duplicate of `/api/public/orders` (which already has API-key auth); no view, JS, or HTML in this repo references it. Recommended action: delete the route. (D) `/ops/agent/ping` and `/ops/agent/log-tokens` are the only two routes under `/ops/agent/*` that lack `requireOpsAuth`; the rest are gated. Add a shared-secret header (`OPS_AGENT_KEY`) checked with `timingSafeEqual`; agents are server-side so a header is trivial. Total fix scope: ~80 lines across 6 files. Estimated effort: ½ day. No DB migration needed.

---

## 2. Current state

### Sub-issue A — `/api/cases/intake` CSRF blocked

| Item | Value |
|---|---|
| Handler | `src/routes/api/cases_intake.js:36` (`router.post('/intake', …)`) |
| Mount | `src/server.js:732` — `app.use('/api/cases', require('./routes/api/cases_intake'))` |
| Effective path | `POST /api/cases/intake` |
| Auth on the handler | None — handler header literally says `// Anonymous (no auth)` |
| CSRF exemption matched? | **No.** `src/middleware/csrf.js:80` exempts only `/api/v1/*`. No clause matches `/api/cases/*`. |
| Rate limiter | None specific. Falls through to global 100/min/IP at `src/middleware.js:77–84`. |
| Caller in this repo | None. Grep `/api/cases/intake` across `src/views`, `public/`: zero hits. The audit doc states the caller is the external marketing site (likely `tashkheesa.com` or a separate static deploy). |
| What it inserts | one `users` row (or enriches an existing one) + one `orders` row + one `cases` row, all in a single transaction (lines 56–117). |
| Behaviour in `enforce` mode | 403 "Forbidden (CSRF)" before the handler runs. |

**Type of issue:** misconfiguration. The route was never meant to require a CSRF token because the caller is cross-origin (and cannot read the `httpOnly` `csrf_token` cookie that lives on the *portal's* domain).

### Sub-issue B — Marketing `fetch()` calls don't read the (httpOnly) CSRF cookie

The CSRF cookie at `src/middleware/csrf.js:36–43` is set with `httpOnly: true`. **JS cannot read it.** The site uses a *server-rendered double-submit* pattern: the middleware also exposes `res.locals.csrfToken` (line 104) so EJS can echo the value into a JS variable, and the JS sends it back via the `x-csrf-token` header. The handler at line 110–117 checks `header === cookieValue`.

The pattern works correctly in `coming_soon.ejs` (line 372–375) and in many portal views (`patient_review_form.ejs`, `patient_payment_required.ejs`, `messages.ejs`, etc., grep confirms ~30 sites). The marketing pages do **not** apply it.

| File | Line | Endpoint hit | `Content-Type` | `x-csrf-token`? | CSRF-enforced on the route? |
|---|---|---|---|---|---|
| `src/views/help_me_choose.ejs` | 137 | `POST /api/help-me-choose` | `application/json` | **NO** | Yes (`src/routes/ai_assistant.js:89`, no exemption) |
| `src/views/partials/service_assistant.ejs` | 271 | `POST /api/help-me-choose` | (same body) | **NO** | Yes |
| `src/views/app_landing.ejs` | 171 | `POST /app/waitlist` | `application/json` | **NO** | Yes (`src/routes/app_landing.js:70`) |
| `src/views/app_landing.ejs` | 228 | `POST /app/analytics` | `application/json` | **NO** | Yes (`src/routes/app_landing.js:112`) |
| `src/views/coming_soon.ejs` | 373 | `POST /api/pre-launch-interest` | `application/json` | **YES** ✓ — model to copy | Yes |
| `public/js/site-form.js` | 111–113 | (form-driven) | varies | reads `data-csrf` attr — but `contact.ejs` form does **not** set `data-csrf`. Plain HTML submit currently uses hidden `_csrf` field, so it works today (silent footgun if the page ever JS-submits). |

**Caller-resolution:** All four pages are rendered by routes inside the portal (so they ARE same-origin and DO have `res.locals.csrfToken` populated). The fix is purely client-side.

- `help_me_choose.ejs` rendered by `src/routes/static-pages.js:72` (`GET /help-me-choose`)
- `app_landing.ejs` rendered by `src/routes/app_landing.js:51` (`GET /app`)
- `service_assistant.ejs` is a partial included by `help_me_choose.ejs` (and others) — fix once at the partial.

### Sub-issue C — `POST /public/orders` open mass-signup

| Item | Value |
|---|---|
| Handler | `src/routes/public.js:8–147` |
| Mount | `src/server.js:663` — `app.use('/', publicRoutes)` |
| Effective path | `POST /public/orders` |
| Auth on the handler | **None.** No `requireRole`, no API key, no captcha. |
| Rate limit | **None specific.** Only the global 100/min/IP at `src/middleware.js:77–84`. |
| CSRF in path? | Yes, middleware applies (no exemption). But CSRF only stops *browser* cross-site abuse; a server-side bot can `GET /` first, parse `Set-Cookie: csrf_token=…`, then echo that value in a header on the next POST. The `httpOnly` flag is irrelevant to a bot — it only restricts JS in a *browser*. |
| What body fields can the caller control? | `patient_name`, `patient_email`, `patient_phone`, `service_id`, `service_code`, `specialty_id`, `sla_type`, `reason` (lines 11–19) |
| What the route writes per request | 1× `users` insert (with `password_hash = ''`) if email is new + 1× `orders` insert + 1× `order_events` insert + queues 1 internal notification (lines 28–135) |
| Side-channel | If the email already exists, the handler reuses the existing row and still creates a fresh order (lines 26–34). Distinct response surfaces for new vs. existing emails — usable for **email enumeration**. |
| Callers in this repo | **Zero.** Grep across `src/views/**`, `public/**`, and all `*.js` finds no reference. Confirmed at `src/routes/public.js:8` (handler) and `src/routes/public_orders.js:45` (the *neighbor* `/api/public/orders` route, which IS API-key gated). The handler appears to be a duplicate from before the API-key gate was added. |

**Quantified abuse risk** (steady-state, single attacker IP):
- Global limiter: 100 req/min/IP
- Per-request DB writes: 3 INSERTs minimum (4 if new patient)
- Hourly: **6 000 patient/order rows from one IP**, 144 000/day. From 100 IPs (commodity bot pool): 600 000/hour, ~14M/day.
- Disk: `orders` table grows ~1KB/row → 6 GB/day from a single 100-IP botnet, plus `notifications` queue saturation.
- Side effects: phone-spam queue (the `queueNotification` calls), email-spam if any worker downstream emails patients on order creation.

### Sub-issue D — `/ops/agent/*` no auth, no CSRF

Mount: `src/server.js:684` → `app.use('/ops', opsRoutes)`. CSRF-exempt blanket at `src/middleware/csrf.js:86–87` (`p.startsWith('/ops/agent/')`).

Routes under `/ops/agent/*` (`src/routes/ops.js`):

| Method + path | Line | Handler purpose | Auth | Risk |
|---|---|---|---|---|
| `POST /ops/agent/toggle` | 596 | Toggle `agent_config.is_enabled` for a named agent | `requireOpsAuth` ✓ | LOW — auth-gated |
| `GET  /ops/agent/status` | 629 | Run `pgrep -f openclaw` over SSH and return state | `requireOpsAuth` ✓ | LOW — read-only, auth-gated. (But: SSH command construction at `sshExec` line 29 — out-of-scope for Theme 3.) |
| `POST /ops/agent/ping` | 655 | INSERT into `agent_heartbeats` with caller-supplied `agent_name`, `status`, `current_task`, `token_cost_usd`, `meta` (capped 200/200/500/2000 chars) | **NONE** | **HIGH — unauth'd state mutation** |
| `POST /ops/agent/log-tokens` | 687 | INSERT into `agent_token_log` with `agent_name`, `tokens_used`, `cost_usd`, `task_label` (capped 200/500 chars) | **NONE** | **HIGH — unauth'd state mutation** |
| `POST /ops/agent/cleanup` | 710 | DELETE FROM `agent_heartbeats` older than 30 days | `requireOpsAuth` ✓ | LOW — auth-gated |

**Read-only vs state-mutating split:** 1 read-only (`status`), 4 state-mutating (`toggle`, `ping`, `log-tokens`, `cleanup`). Of the 4 mutators, 2 (`ping`, `log-tokens`) are entirely unauth'd.

**Effective threat:** a bot can write rows at the global rate-limit ceiling (100/min/IP) into both tables. With 200–2000 char fields, that's ≈100 KB/min/IP raw of pollution, and the ops dashboard at `src/views/ops-dashboard.ejs` will read these rows and may render attacker-supplied text (separate XSS audit not in this theme).

---

## 3. Root cause

| Sub-issue | Root cause |
|---|---|
| A | The CSRF exemption table in `src/middleware/csrf.js:80–99` was extended for `/api/v1/*`, `/payments/callback*`, `/portal/video/payment/callback*`, and the `/ops/agent/*` block, but `/api/cases/*` was added later (server.js:732) without a matching exemption. Cross-origin POSTs cannot complete the same-origin cookie-token round-trip, so they 403 unconditionally in `enforce` mode. |
| B | The CSRF cookie is `httpOnly` (`csrf.js:37`). The team correctly chose the *server-render-into-template* variant of double-submit (echo `res.locals.csrfToken` into a JS variable, send via header). The marketing pages were authored before — or by — someone who didn't know the pattern existed; they kept the bare `Content-Type: application/json` headers. |
| C | A historical version of the public order intake (`/public/orders`) was superseded by `/api/public/orders` (which added API-key gating in `src/routes/public_orders.js:45–56` with `timingSafeEqual`). The old route was never deleted. No view references it; it is dead code that happens to still write to the production DB. |
| D | The `/ops/agent/*` namespace was carved out for *server-to-server* agent telemetry, so the team blanket-exempted it from CSRF. Three of the five endpoints were then individually gated with `requireOpsAuth`, but the two telemetry endpoints (`ping`, `log-tokens`) were left open — the (implicit) reason being that "the agents themselves are server-side and we trust them," forgetting that the route is reachable from the public internet and there is no IP allowlist. |

---

## 4. Fix plan

> **All diffs below are PROPOSED only. No code is being changed in this commit.**

### Sub-issue A — Exempt `/api/cases/*` from CSRF and add a dedicated rate limiter

**File 1:** `src/middleware/csrf.js` — add an exemption clause alongside the existing `/api/v1` clause (around line 80).

```diff
     if (req.originalUrl && req.originalUrl.startsWith('/api/v1')) {
       return next();
     }
+    // Public marketing-site intake endpoint. The caller is cross-origin and cannot
+    // read the httpOnly csrf_token cookie. Auth/abuse-defense lives in the rate
+    // limiter at src/middleware.js (and any future API-key check on /api/cases).
+    if (req.originalUrl && req.originalUrl.startsWith('/api/cases/')) {
+      return next();
+    }
     if (p === '/callback' || p.startsWith('/portal/video/payment/callback') || p.startsWith('/payments/callback')) {
       return next();
     }
```

**File 2:** `src/middleware.js` — add a dedicated rate limiter for `/api/cases` near the other public limiters (around line 174).

```diff
   app.use('/api/pre-launch-interest', rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 10,
     validate: false,
     standardHeaders: true,
     legacyHeaders: false,
     message: 'Too many submissions. Please wait 15 minutes and try again.'
   }));

+  // Public website intake (marketing landing page → /api/cases/intake).
+  // The route is CSRF-exempt because it is cross-origin; rate-limit-then-fail-closed.
+  app.use('/api/cases', rateLimit({
+    windowMs: 15 * 60 * 1000,
+    max: 10,
+    validate: false,
+    standardHeaders: true,
+    legacyHeaders: false,
+    message: 'Too many case submissions. Please wait 15 minutes and try again.'
+  }));
+
   // App waitlist — 10 submissions per IP per hour
```

**Optional hardening (out of base fix; flagged for §8):** add an HMAC-SHA256 header check (`x-tsh-signature`) signed with a shared secret known to the marketing site, mirroring the Paymob webhook pattern at `src/routes/payments.js:198-237`. Recommend deferring until the marketing site is also under our control.

### Sub-issue B — Add server-rendered CSRF token to four marketing fetches

The pattern (copy of `coming_soon.ejs:372–375`):

```ejs
<script nonce="<%= cspNonce %>">
  var csrfToken = '<%= typeof csrfToken !== "undefined" && csrfToken ? csrfToken : "" %>';
  fetch('/api/help-me-choose', {
    method: 'POST',
-   headers: { 'Content-Type': 'application/json' },
+   headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ messages: history, lang: LANG })
  })
```

**Files to touch (one diff per call site):**

1. `src/views/help_me_choose.ejs:137` — declare `csrfToken` once near the top of the script block, add header to fetch.
2. `src/views/partials/service_assistant.ejs:271` — same. Note: this partial is included by `help_me_choose.ejs`; if both fixes go in, deduplicate the JS variable to avoid `Identifier 'csrfToken' has already been declared` runtime error. Plan: keep the declaration in the partial (which has the fetch) and remove from the parent if duplicated.
3. `src/views/app_landing.ejs:171` — declare and use.
4. `src/views/app_landing.ejs:228` — share the same `csrfToken` variable as #3 (same `<script>` block).

Render-side check: confirm `res.locals.csrfToken` is populated before each render. It is — the CSRF middleware (`csrf.js:101–106`) sets it on every non-asset, non-exempted GET, and the routes `GET /help-me-choose` (`src/routes/static-pages.js:72`) and `GET /app` (`src/routes/app_landing.js:51`) are non-exempted.

### Sub-issue C — Delete `/public/orders`

**File:** `src/routes/public.js` — delete the entire file. Then drop the require + mount in `src/server.js`:

```diff
-var publicRoutes = require('./routes/public');
 var publicOrdersRoutes = require('./routes/public_orders');
 …
-app.use('/', publicRoutes);
 app.use('/', publicOrdersRoutes);
```

**Justification for deletion (vs. add-API-key):**
- No view, JS file, or HTML in this repo references `/public/orders` (verified by grep).
- The neighbor route `/api/public/orders` already provides the same functionality with API-key auth, request logging, and `timingSafeEqual` comparison.
- Keeping a duplicate route increases the security surface and divergence risk (e.g., if the schema changes, only one of the two will be updated).

**Fallback if Ziad confirms an external caller exists** (see §8 OQ-3): port the API-key check verbatim from `src/routes/public_orders.js:45–56`:

```diff
 router.post('/public/orders', async (req, res) => {
   try {
+    // P0-ROUTE-3 — gate behind PUBLIC_ORDER_API_KEY (mirrors /api/public/orders)
+    const apiKey = process.env.PUBLIC_ORDER_API_KEY;
+    const provided = String(req.body && req.body.api_key || '');
+    if (!apiKey || !provided) return res.status(401).json({ ok: false, error: 'unauthorized' });
+    const a = Buffer.from(apiKey);
+    const b = Buffer.from(provided);
+    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
+      return res.status(401).json({ ok: false, error: 'unauthorized' });
+    }
     const body = req.body || {};
```

### Sub-issue D — Shared-secret gate on `/ops/agent/ping` and `/ops/agent/log-tokens`

**File:** `src/routes/ops.js` — define a small helper next to `requireOpsAuth` (line 120) and apply it to the two unauth'd handlers.

```diff
 function requireOpsAuth(req, res, next) {
   …existing…
 }

+function requireAgentKey(req, res, next) {
+  var expected = process.env.OPS_AGENT_KEY;
+  if (!expected) {
+    // Fail-closed: with no key configured the route is unreachable rather than open.
+    return res.status(503).json({ ok: false, error: 'agent_key_not_configured' });
+  }
+  var provided = String(req.get('x-ops-agent-key') || '');
+  if (!provided) return res.status(401).json({ ok: false, error: 'unauthorized' });
+  var a = Buffer.from(expected);
+  var b = Buffer.from(provided);
+  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
+    return res.status(401).json({ ok: false, error: 'unauthorized' });
+  }
+  return next();
+}

 …

-router.post('/agent/ping', async function (req, res) {
+router.post('/agent/ping', requireAgentKey, async function (req, res) {
 …

-router.post('/agent/log-tokens', async function (req, res) {
+router.post('/agent/log-tokens', requireAgentKey, async function (req, res) {
```

**Env wiring:** add `OPS_AGENT_KEY=<32+ char random>` to `.env.example`, prod and staging Render env, and to whichever agent runner ships heartbeats (likely `bin/openclaw` or similar — out-of-scope to identify here, see §8 OQ-4).

**Side note on CSRF for `/ops/agent/*`:** the blanket `startsWith('/ops/agent/')` exemption can stay — agents won't carry a CSRF cookie. The risk closed by this fix is *unauth'd writes*, not CSRF.

---

## 5. Verification steps

> All commands assume `STAGING=https://staging.tashkheesa.com` (or the actual staging host). Replace as appropriate. **Run only after the fix is deployed to staging.**

### Sub-issue A (post-fix)

```bash
# Cross-origin POST without any cookie or token — should now succeed (200) for the first 10
# attempts and 429 thereafter.
curl -i -X POST "$STAGING/api/cases/intake" \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"CSRF Test","email":"csrf-test+1@example.com","test_type":"oncology"}'
# expect: HTTP/1.1 200, body has reference_id "TSH-2026-...".

# Eleventh attempt within 15 min from same IP:
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$STAGING/api/cases/intake" \
    -H 'Content-Type: application/json' \
    -d "{\"full_name\":\"x\",\"email\":\"e$i@example.com\",\"test_type\":\"other\"}"
done
# expect: 200,200,200,200,200,200,200,200,200,200,429
```

### Sub-issue B (post-fix)

```bash
# Browser-emulation: GET to seed the cookie, capture both the Set-Cookie value and
# the inlined csrfToken JS variable from the rendered page.
curl -is -c /tmp/c.jar "$STAGING/help-me-choose" > /tmp/page.html
TOKEN=$(grep -oE "var csrfToken = '[a-f0-9]{16,}'" /tmp/page.html | head -1 | sed -E "s/.*'([a-f0-9]+)'.*/\1/")
echo "$TOKEN"  # expect 64-char hex

# POST with both the cookie AND the token in the header — should succeed.
curl -i -X POST "$STAGING/api/help-me-choose" \
  -b /tmp/c.jar \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $TOKEN" \
  -d '{"messages":[{"role":"user","content":"hi"}],"lang":"en"}'
# expect: 200 with JSON ok:true (or rate-limit 429 after 20/min)

# Same POST with cookie but NO token — must still 403, proving CSRF middleware
# still protects the route (regression check).
curl -i -X POST "$STAGING/api/help-me-choose" \
  -b /tmp/c.jar \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"lang":"en"}'
# expect: 403 "Forbidden (CSRF)"
```

Repeat for `/app/waitlist` and `/app/analytics` (seed cookie via `GET /app`):

```bash
curl -is -c /tmp/c2.jar "$STAGING/app" > /tmp/page2.html
TOKEN2=$(grep -oE "var csrfToken = '[a-f0-9]{16,}'" /tmp/page2.html | head -1 | sed -E "s/.*'([a-f0-9]+)'.*/\1/")
curl -i -X POST "$STAGING/app/waitlist" -b /tmp/c2.jar \
  -H 'Content-Type: application/json' -H "x-csrf-token: $TOKEN2" \
  -d '{"email":"verify@example.com","platform":"android"}'
# expect: 200 ok:true
```

### Sub-issue C (post-fix; if route deleted)

```bash
curl -i -X POST "$STAGING/public/orders" \
  -H 'Content-Type: application/json' \
  -d '{"patient_name":"x","patient_email":"x@y.com","specialty_id":"radiology"}'
# expect: 404 (route no longer mounted) — proves removal. If your error page is
# the patient-context one, you'll get the 404 EJS template; the status line is
# what matters.
```

### Sub-issue D (post-fix)

```bash
# Without the agent key — must reject.
curl -i -X POST "$STAGING/ops/agent/ping" \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"verify-test"}'
# expect: 401 unauthorized

curl -i -X POST "$STAGING/ops/agent/log-tokens" \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"verify-test","tokens_used":1}'
# expect: 401 unauthorized

# With the agent key — must accept.
curl -i -X POST "$STAGING/ops/agent/ping" \
  -H 'Content-Type: application/json' \
  -H "x-ops-agent-key: $OPS_AGENT_KEY" \
  -d '{"agent_name":"verify-test","status":"idle"}'
# expect: 200 ok:true

# Existing auth-gated routes must still work / fail-closed:
curl -i -X POST "$STAGING/ops/agent/toggle" \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"verify-test"}'
# expect: 302 redirect to /ops/login (requireOpsAuth still in effect)
```

DB-side spot check (run on staging psql):

```sql
SELECT count(*) FROM agent_heartbeats WHERE agent_name = 'verify-test';   -- should be exactly 1 after the keyed ping
SELECT count(*) FROM agent_token_log  WHERE agent_name = 'verify-test';   -- should be 0 (we didn't call log-tokens with key)
```

---

## 6. What to add to the test suite

Place under `tests/` (or wherever the project keeps its supertest/jest harness — confirm path during implementation, see §8 OQ-5).

1. **`tests/csrf-exemptions.test.js`** — table-driven test asserting the exempt list:
   - `GET /api/v1/anything` → no 403
   - `POST /api/cases/intake` *without* token → 200 (or 4xx for validation, but **not** 403/CSRF)
   - `POST /payments/callback` without token → not 403
   - `POST /ops/agent/ping` without key → 401 (proves the new gate)
   - `POST /ops/agent/ping` with key → 200
   - `POST /api/help-me-choose` *without* token → 403 (regression: must stay protected)
   - `POST /portal/...` without token → 403 (sample of normal CSRF still works)

2. **`tests/views/marketing-csrf.test.js`** — render each marketing page through Express `res.render()` and assert the resulting HTML string contains:
   - `var csrfToken = '` + at least 32 hex chars + `'`
   - `'x-csrf-token': csrfToken` (case-insensitive)
   - For `app_landing.ejs`: both occurrences (waitlist + analytics).

3. **`tests/routes/public-orders-removed.test.js`** — assert that `POST /public/orders` returns 404 *and* that no `users` row was created with `password_hash = ''` after the request. (Regression guard against accidental restoration.)

4. **`tests/routes/ops-agent-key.test.js`** — start the server with `OPS_AGENT_KEY=test-key-1234` and assert:
   - `POST /ops/agent/ping` with no header → 401
   - … with wrong header → 401 (timing-safe; just check status)
   - … with `x-ops-agent-key: test-key-1234` → 200
   - With `OPS_AGENT_KEY` *unset*, the route returns 503 (fail-closed assertion).

5. **`tests/rate-limit.test.js`** — extend an existing rate-limit test (or create) to cover the new `/api/cases` limiter: 11 fast POSTs from the same IP → eleventh is 429.

All five suites should run in CI on every PR; if no Jest harness exists yet, gate this on §8 OQ-5.

---

## 7. Rollback plan

Each sub-issue is a small, self-contained set of diffs and rolls back independently. Use `git revert` per commit, in reverse order.

| Sub-issue | Files touched | Rollback method | Side effects of rollback |
|---|---|---|---|
| A | `src/middleware/csrf.js` (1 line block), `src/middleware.js` (10-line limiter) | `git revert <sha>` | Reverts to current state: `/api/cases/intake` 403s in production. Marketing landing page lead-capture broken again. Restart not required (CSRF middleware re-loads on next process start; rolling Render deploy will pick it up). |
| B | 3 EJS view files: `help_me_choose.ejs`, `partials/service_assistant.ejs`, `app_landing.ejs` | `git revert <sha>` | Three marketing fetches go back to 403'ing in `enforce` mode. No DB or migration impact. View changes ship the moment the EJS template cache is cleared (next process start). |
| C | `src/routes/public.js` (deleted), `src/server.js` (2 lines) | `git revert` restores the file and the require/mount lines. | Restores the open-mass-signup route. **No data loss** — we are only removing a write surface, not deleting historical rows. If C-fallback (API-key gate) was used instead, rollback restores the unauth'd handler. |
| D | `src/routes/ops.js` (~25 lines: helper + 2 middleware insertions) | `git revert <sha>` | Two `/ops/agent/*` routes go back to being unauth'd. Heartbeat agents would still work without `x-ops-agent-key` header. |

**Cross-cutting:** none of the four fixes alter database schema, migrations, or stored data. Rollback is purely code-level. The `OPS_AGENT_KEY` env var, once set, can be left in place after a rollback (unused).

**If staging deploys but a production rollback is needed:** `git revert` the four commits, push to `main`, redeploy. Confirm by re-running the §5 verification commands and expecting the *pre-fix* responses (403 / 200 unauth on /ops/agent/ping / etc.).

---

## 8. Open questions for Ziad

1. **OQ-1 (Sub-issue A — HMAC?):** The marketing-site caller is currently un-authenticated and only rate-limited. Do you want me to add an HMAC-SHA256 signature header (`x-tsh-signature`) using a shared secret with the marketing site? This requires coordinated deployment with whoever owns `tashkheesa.com`. **Default if no answer:** ship without HMAC; rely on the rate limiter and the fact that the only damage is rows in `users`/`orders`/`cases` (we can re-run a cleanup query).

2. **OQ-2 (Sub-issue B — what about `site-form.js`?):** The audit also flags `public/js/site-form.js:111` (`P1-ROUTE-14`) — the JS reads `data-csrf` from the form attribute, but `contact.ejs` doesn't set it. Plain HTML POST works today via hidden `_csrf`. **In scope for Theme 3?** I treated it as out-of-scope (no view *currently* JS-submits); flag as "yes, fold into Theme 3" and I'll add it.

3. **OQ-3 (Sub-issue C — delete or gate?):** Confirm there is no external caller of `POST /public/orders` (a webhook integration, a partner script, anything outside this repo). Grep was clean inside the repo, but I cannot see external callers. If yes-someone-uses-it: I'll port the API-key check from `/api/public/orders` instead of deleting. If no-one: deletion is recommended.

4. **OQ-4 (Sub-issue D — agent runner location):** Where does the agent that calls `/ops/agent/ping` live, and how do we set its env var? I see `bin/openclaw` referenced by SSH-exec at `src/routes/ops.js:43, 630`, but the actual ping client is not in this repo (I assume it's either an external systemd unit or a sidecar). I need to know where to add `OPS_AGENT_KEY` in *its* environment so we can roll the key together.

5. **OQ-5 (Test suite):** Does this repo have an existing test runner (Jest? Mocha? Supertest?), and if so where is the entry-point? I didn't find a top-level `test/` or `__tests__/` directory in my scan. If no harness exists, I will scope test-suite work to a follow-up PR rather than block the fix on bringing one up.

6. **OQ-6 (Sub-issue D — keep CSRF blanket exemption?):** The `/ops/agent/*` namespace is currently CSRF-blanket-exempt because agents don't have a browser session. After we gate `ping`/`log-tokens` with `OPS_AGENT_KEY`, do you want to *also* CSRF-protect `/ops/agent/toggle` and `/ops/agent/cleanup` (the ops-dashboard-driven routes)? They run inside an authenticated ops session, so adding CSRF is defense-in-depth (matches `P2-VIEW-75`). I treated this as out-of-scope for Theme 3 — flag if you want it folded in.

---

*End of Theme 3 scoping. No source files were modified.*
