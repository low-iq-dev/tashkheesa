# Theme 13 — Uploadcare → R2 Migration: Fix Plan

**Status:** Scoping only. No code changes in this commit.
**Reference:** `docs/audits/UPLOAD_PROVIDER_AUDIT.md` (uncommitted at scoping time; commit SHA TBD).
**Sister themes:** Theme 2 (CSP view crashes — partial overlap with §E here), Theme 4 (env vars — overlap with §F), Theme 8 (ops blindness — relies on the same `error_logs` plumbing for cutover monitoring), Theme 9 (third-party silent degradation — the Uploadcare lane was the one row marked "n/a" in Theme 9 §2 because there is no server-side Uploadcare client; this theme makes that row obsolete).
**Closes:** Side issue **#52** (DEFERRED, P2): "Migrate Uploadcare File Uploader 3.x → Blocks v1.x." This theme supersedes — instead of migrating to Blocks v1.x, we remove the dependency entirely.
**Scope:** Replace the two remaining Uploadcare lanes (patient wizard widget + mobile API contract) with the existing R2 + multer pipeline already used by `order_flow.js`, `prescriptions.js`, and `doctor.js`. Includes CSP cleanup, env var deprecation, i18n string cleanup, AI image-quality validator path swap, regression tests. **Backfill of historical Uploadcare CDN URLs is explicitly deferred** to a follow-up phase (rationale in §4 sub-issue J).

---

## 1. Executive Summary

Tashkheesa's storage architecture is mid-migration. **R2 already handles 80% of the upload surface** (doctor profile photos, doctor signatures, prescription PDFs, all server-generated reports, and the `order_flow.js` patient case-files writer). The remaining 20% is the patient-facing Uploadcare widget on `patient_new_case.ejs:879` + `patient_order.ejs:646` and the mobile API's `uploadcareUuid` contract at `src/routes/api/cases.js:236-244`. Those two lanes pull in three secondary problems: a publicly-addressable CDN that bypasses our authn (`ucarecdn.com/<uuid>/` is reachable without a session — confirmed at audit §6a), a `'unsafe-eval'` line in CSP that exists only because Uploadcare's File Uploader 3.x compiles its templates via `new Function()` (`server.js:349-354`), and a documented-but-unimplemented `UPLOADCARE_SECRET_KEY` env var that has been surfaced as "set in Render" without a single reader anywhere in the repo (`server.js:89-96`, audit §6a).

**The migration target is not greenfield work.** Every primitive needed exists today and is exercised by code that has been in production for months: `src/storage.js` (R2 client + signed URLs + bucket head-check at boot), `src/middleware/upload.js` (the shared `multer.memoryStorage()` instance with the union of allowed MIME / extension rules from across the existing routes), `/files/:id` in `server.js:469-525` (auth-gated unified reader that **already disambiguates between legacy `https://ucarecdn.com/...` URLs and R2 keys via an `^https?://` regex** — no route change needed). The work is one new POST endpoint, two view rewrites (~50 LOC each), one mobile API contract change (dual-mode accept), four cleanup commits (CSP / env / i18n / docs), and a regression test pass.

**The dominant risk is not the migration itself — it is cutover.** Patient case file uploads are payment-blocking: a patient who cannot attach an MRI cannot submit a case, cannot pay, cannot transact. A bad deploy here doesn't just degrade UX, it zeros out new-case throughput. §7 specifies a feature-flag-gated coexistence period (`UPLOAD_R2_DIRECT_ENABLED` plus a survival fallback `UPLOADCARE_FALLBACK_ENABLED`), explicit cutover criteria (success-rate floor + per-surface error counts), and a single-flag rollback path that does not require a deploy.

**Sub-issue grouping (11 total):** A–D are the migration core (endpoint + two views + mobile contract). E–G are cleanup that should land as separate commits **after** A–D have soaked in production. H is the regression test pass. I is a quiet but worthwhile correctness fix (AI image-quality validator switches from "fetch CDN URL" to "use the buffer we already have"). J is the legacy-row backfill — **deferred to a follow-up theme** because it is independent of cutover and is more naturally scoped as a one-shot script than a code change. K is documentation (INTEGRATIONS.md, public form copy, side issue #52 closure).

**Overall recommendation:** Land A → B → D in a sub-theme (the core wizard cutover gated behind the feature flag), then land C, then E–G as cleanup once cutover is verified, then H as the test backstop. I rides with A. J is post-theme. The plan stays in flag-gated coexistence for ≥14 days before cleanup begins.

---

## 2. Current State

### 2a. Storage backend allocation today (verified at file open)

| Lane | Bytes flow | Persisted as | Status |
|---|---|---|---|
| Doctor profile photo | multer → R2 (`doctor-photos/<id>/<ts>.<ext>`) | `users.profile_photo_url` (R2 key) | ✅ Already on R2 — `src/routes/doctor.js:2870-2960` |
| Doctor signature | multer → R2 (`doctor-signatures/<id>/<ts>.<ext>`) | `users.signature_url` (R2 key) | ✅ Already on R2 — `src/routes/doctor.js:3032-3110` |
| Prescription PDF (doctor upload) | multer → R2 (`prescriptions/<uuid>.<ext>`) | `prescriptions.pdf_url` (R2 key) | ✅ Already on R2 — `src/routes/prescriptions.js:142-149` |
| Server-generated PDF reports | server → R2 (`reports/<key>`) | `orders.report_url`, `report_exports.file_path`, `medical_records.file_url` | ✅ Already on R2 — `src/report-generator.js:561, 774, 930` |
| Patient case files via portal `order_flow.js` `/order/:id/upload` | multer → R2 (`orders/<orderId>/<uuid>.<ext>`) | `order_files.url` (R2 key) | ✅ Already on R2 — `src/routes/order_flow.js:71-85` |
| **Patient case files via portal wizard `patient_new_case.ejs`** | **browser → Uploadcare CDN → form post of CDN URL** | **`order_files.url` (full `https://ucarecdn.com/<uuid>/` URL)** | **❌ Uploadcare — Theme 13 target** |
| **Patient case files via portal additional-files (`patient_order.ejs`)** | **browser → Uploadcare CDN → form post of CDN URL** | **`order_files.url` (full CDN URL)** | **❌ Uploadcare — Theme 13 target** |
| **Patient case files via mobile API `POST /api/v1/cases`** | **mobile app → Uploadcare CDN directly → POST `{ files: [{ uploadcareUuid }] }` to API** | **`order_files.uploadcare_uuid` (TEXT, separate column from `url`)** | **❌ Uploadcare — Theme 13 target** |
| Instagram post images (DALL-E → permanent host) | server → Cloudinary | `instagram_posts.image_urls` (JSONB) | 🟡 Cloudinary (single-purpose, isolated, **out of Theme 13 scope** — Cloudinary's image-pipeline is positioned for transforms, not arbitrary blob storage with auth, so swapping it is a separate decision) |

### 2b. The unified `/files/:id` route — the load-bearing piece

`src/server.js:469-525` is the auth-gated reader that every patient/doctor/admin uses to fetch any case file. It is **already dual-mode** (verified at file open):

```javascript
// server.js:507-510
// Legacy: rows where url is an HTTP URL (Uploadcare etc.) — redirect directly.
if (isHttpUrl(urlOrPath)) {
  return res.redirect(302, urlOrPath);
}

// server.js:512-524
// Otherwise treat as an R2 storage key; generate a short-lived signed URL.
try {
  var storage = require('./storage');
  var downloadName = safeFilename(file.label || path.basename(urlOrPath));
  var signedUrl = await storage.getSignedDownloadUrl(urlOrPath, 3600, { downloadName: downloadName });
  return res.redirect(302, signedUrl);
} catch (err) { /* logged */ }
```

The `isHttpUrl` helper at `server.js:444-447` is a simple `startsWith('http://') || startsWith('https://')` check. **This means**:

1. Existing `order_files` rows holding `https://ucarecdn.com/<uuid>/` continue to work via the legacy branch — no migration of historical rows is required for cutover.
2. New rows holding R2 keys like `orders/<orderId>/<uuid>.pdf` route through the R2 branch.
3. **The route does not need to change.** The migration is purely "stop writing the CDN URL into `url`; write an R2 key instead."

This is the single most important load-bearing fact for the entire theme. It means cutover risk is contained to the **writer** side (the new POST endpoint + view changes); the **reader** side has been stable since Phase 2 of the original R2 migration (`9914f54 feat: migrate order_flow.js writer + /files/:id route to Cloudflare R2 — phase 2`).

### 2c. The mobile API contract — different shape, same principle

`src/routes/api/cases.js:117-138` (read path) and `:236-244` (write path) use a **separate column** — `order_files.uploadcare_uuid` — distinct from `order_files.url`. The schema at `src/migrations/043_codify_mobile_api_schema.sql:68-73` adds the column as `TEXT`, nullable. The read path constructs the CDN URL on the fly:

```javascript
// cases.js:135-138
files.forEach(f => {
  f.cdnUrl = f.uploadcareUuid ? `https://ucarecdn.com/${f.uploadcareUuid}/` : null;
  f.url = `/files/${f.id}`;
});
```

`url` here points at the unified `/files/:id` route (which then redirects to the CDN, since `order_files.url` for these rows is presumably also the CDN URL — needs DB confirmation; see Open Question Q3 in §8). `cdnUrl` is the legacy-mobile-app direct CDN field. The write path at `:236-244` accepts `{ files: [{ uploadcareUuid, filename, mimeType, size }] }` and INSERTs both `uploadcare_uuid` and (implicitly via the same value or via parallel insert path) `url`.

**Open Question Q3 in §8 surfaces this:** when the mobile API write path INSERTs into `order_files`, does it set `url` to anything? Reading `cases.js:240-243` the INSERT only specifies `id, order_id, uploadcare_uuid, filename, mime_type, size, ai_quality_status, created_at`. So `url` is NULL for mobile-uploaded rows today. That's a small wrinkle for Sub-issue D — mobile API needs to write to `url` (not `uploadcare_uuid`) once it ships R2 support.

### 2d. CSP today — two configs, both running, only one effective

This is more brittle than the audit conveyed. Both:

| Mount | File | Lines | Effective? |
|---|---|---|---|
| Helmet `contentSecurityPolicy` directive | `src/middleware.js:14-72` | full helmet config including `script-src` with `https://ucarecdn.com` etc. | ❌ **Dead for CSP** — see explanation below |
| Manual `res.setHeader('Content-Security-Policy', csp)` middleware | `src/server.js:335-362` | manual CSP string with `'unsafe-eval'`, nonce, and the same ucarecdn allowlist | ✅ **The effective CSP** |

Express middleware order is `baseMiddlewares()` (helmet runs at `server.js:326`, sets the helmet-CSP header) → then the manual CSP middleware at `server.js:335-362` runs and **overwrites the header** via `setHeader`. Last-write-wins on response headers means the manual one is what the browser sees. Helmet's other directives (X-Frame-Options, X-Content-Type-Options, etc.) still apply because helmet sets multiple headers, but its `contentSecurityPolicy` directive is shadowed.

**Implication for Sub-issue E:** the CSP cleanup must edit *both* locations (or delete the helmet CSP directive entirely as part of the cleanup), otherwise a future maintainer reading `middleware.js` will think the allowlist is still required when in fact `server.js` is the only one being used. Leaving the helmet block in place creates exactly the kind of "two sources of truth" footgun that Theme 1 was about.

### 2e. Inventory of every file the migration touches

| # | File | Today | Sub-issue |
|---|---|---|---|
| 1 | `src/routes/api/cases.js` (or new `src/routes/api/case_files.js`) | mobile API receives `uploadcareUuid` | A (new endpoint), D (dual-mode accept) |
| 2 | `src/routes/patient.js` | renders `uploadcareLocals` into 7 call sites | B (drop locals), G (i18n) |
| 3 | `src/views/patient_new_case.ejs` | `:877-930` Uploadcare 3.x widget mount | B |
| 4 | `src/views/patient_order.ejs` | `:646-668` Uploadcare 3.x widget mount | C |
| 5 | `src/views/public_case_new.ejs` | `:119-126` paste-Uploadcare-link copy | K (copy only) |
| 6 | `src/server.js` | `:84-96` env var validator, `:335-362` CSP, `:469-525` /files/:id (no change) | E (CSP), F (env validator) |
| 7 | `src/middleware.js` | `:14-72` dead helmet CSP block | E |
| 8 | `src/i18n.js` | `:122, 380` "UPLOADCARE_PUBLIC_KEY not set" warning string | G |
| 9 | `src/routes/verify.js` | `:99-125` `/verify` admin readiness key panel | F (drop the Uploadcare key panel) |
| 10 | `src/routes/ops.js` | `:976-978` `/ops/...` exposes uploadcare key state | F (drop) |
| 11 | `.env.example` | UPLOADCARE_PUBLIC_KEY + UPLOADCARE_SECRET_KEY documented but unused | F |
| 12 | `docs/INTEGRATIONS.md` | "Uploadcare (file CDN) — WIRED & ACTIVE" section | K (rewrite to reflect retirement) |
| 13 | `docs/audits/SIDE_ISSUES_BACKLOG.md` row #52 | DEFERRED → RESOLVED | K |
| 14 | `src/ai_image_check.js` (`validateImageFromUrl` callers in `cases.js`) | fetches `https://ucarecdn.com/<uuid>/` to inspect bytes | I (buffer-direct path) |
| 15 | `src/routes/api/cases.js` AI worker block (`:249-287`) | `setImmediate` worker fetches the CDN URL | I |
| 16 | `tests/core/` | no upload-direct tests today (audit §6c) | H |

### 2f. What the cutover does **not** touch

For clarity (these have been confused in prior themes):

- `src/storage.js` — no change. R2 client is fine as-is.
- `src/middleware/upload.js` — no change. The shared multer instance with the union allowlist is exactly what the new endpoint needs.
- `/files/:id` in `src/server.js` — no change. Already dual-mode.
- `src/routes/order_flow.js` — no change. It was ahead of the curve.
- `src/routes/prescriptions.js`, `doctor.js`, `report-generator.js` — no change. Already on R2.
- The `order_files.uploadcare_uuid` column — **kept**. Dropping it requires a migration; we leave it in place so legacy rows continue to render in the mobile app's `cdnUrl` field. Mark for removal in J/K post-cleanup.
- Cloudinary (Instagram-only) — out of scope.

---

## 3. Root Cause

The architecture didn't drift — it was incrementally **migrated, then paused mid-stream**. Reading the git log on storage paths:

| SHA | Subject | What it did |
|---|---|---|
| `0cb2e9e` | feat: add R2 storage module and memory upload middleware — phase 1 of multer migration | Introduced `src/storage.js` + `src/middleware/upload.js`. **No callers cut over yet.** |
| `9914f54` | feat: migrate order_flow.js writer + /files/:id route to Cloudflare R2 — phase 2 | First writer cutover (the `order_flow.js` `attachFileToOrder()` path). Reader becomes dual-mode. |
| `01d135a` | feat(doctor-profile): wire up profile photo upload / remove / serve | Added doctor photo + signature on R2. Bypassed Uploadcare entirely for these surfaces. |
| `742b464` | fix(patient): retire standalone /portal/patient/orders/:id/upload uploader | Removed a redundant patient upload route — but **left the wizard's Uploadcare widget in place**. |
| (recent cluster) | `c3bf0bf`, `e0f0183`, `3425094`, `23616a9`, `e2a40e3`, `17aae43` | Multiple CSP-nonce fixes for the patient wizard's Uploadcare script tag rendering. |

The pattern: every server-originated upload was migrated as it became a problem. **The patient wizard never became a problem severe enough to migrate** — until the recent CSP-nonce churn, which was treating the symptom (the widget wasn't loading because of nonce mismatches) without addressing the underlying carrier (the widget should be replaced, not patched).

The mobile API path is a separate sub-history: the `uploadcare_uuid` column was added in migration **043** (`src/migrations/043_codify_mobile_api_schema.sql:68-73`, "codify_mobile_api_schema"). The mobile app team was, by all evidence, pointed at Uploadcare's mobile SDK as a quick path to direct-upload-from-device without writing a server endpoint. That was the right call at the time — the alternative would have been blocking the mobile launch on a server-side direct-upload endpoint that didn't exist yet. Theme 13 is now writing that endpoint.

**Three contributing factors prevented the cleanup from happening earlier:**

1. **Side issue #52 was scoped wrong.** It framed the work as "migrate Uploadcare 3.x → Blocks v1.x" — a like-for-like SDK upgrade. That framing accepted Uploadcare as a permanent dependency and treated the CSP issue as the only motivator. The audit reframes: we don't need Uploadcare at all, because R2 already does the job.
2. **The `'unsafe-eval'` CSP cost was cheap to live with.** It's an annoyance, not a breach. The privacy-gap cost (publicly-addressable CDN URLs) was higher but undocumented until the audit.
3. **The mobile API contract is sticky.** Changing the wire format requires a coordinated server + client deploy, which is more friction than "add the new field as optional alongside the old one." Sub-issue D handles this.

The drift wasn't accidental — it was a deliberately partial migration that ran out of momentum. The work in this theme is the second half of work that started 6+ months ago.

---

## 4. Fix Plan

### Sub-issue A — Server-side POST endpoint for patient wizard uploads

**Goal:** Add a single new endpoint that accepts a multipart upload, runs it through the existing multer + R2 pipeline, and returns the file metadata the client needs to attach it to a draft case (and that the wizard's existing form submission can post back to the case-create handler).

**Endpoint shape (proposed):**

```
POST /portal/patient/files
  Content-Type: multipart/form-data
  Field: file (single file per request — match Uploadcare widget's UPLOADCARE_MULTIPLE = false)
  Auth: requireAuth + requireRole('patient') (mirrors existing wizard auth)
  CSRF: required (the wizard already has a CSRF token via csrfField())
  Returns: { ok: true, file: { id, key, filename, mimeType, size } } on success
           { ok: false, error: '...' } on multer rejection or R2 failure
```

The endpoint **does not insert into `order_files`**. It uploads the bytes to R2 (folder `orders/draft/<userId>/<uuid>.<ext>` — see §A scoping decision below) and returns the R2 key. The wizard's existing form submission (already POSTs the URL into a hidden field on submit) is updated to post the R2 key instead. The case-create handler is the one that INSERTs into `order_files (url=<R2 key>)`. This preserves the current "draft state lives in form fields, persisted only on final submit" model and avoids orphaned R2 objects from abandoned wizards (well, almost — see "orphan handling" below).

**Why a separate endpoint, not extending `/api/v1/cases` or `order_flow.js`:**

- The wizard runs as authenticated portal user (cookie session), not API key — `/api/v1/*` is the mobile-API surface.
- `order_flow.js` is per-order (`/order/:orderId/upload`); the wizard uploads files **before** an order ID exists.
- Keeping the new endpoint isolated lets us mount the rate limiter and feature flag independently.

**Scoping decisions inside Sub-issue A:**

1. **Folder convention for pre-submit uploads.** Options:
   - (a) `orders/draft/<userId>/<uuid>.<ext>` — easy to clean up by user, but inflates R2 object count
   - (b) `orders/_pending/<uuid>.<ext>` — flat, harder to clean
   - (c) Same `orders/<orderId>/...` convention but skip the upload until orderId exists (would require Uploadcare-style direct-upload-then-attach, defeats the purpose)
   - **Recommend (a)** — matches the doctor-photos pattern (`doctor-photos/<doctor_id>/...`) which has worked well, and a cleanup script can sweep `orders/draft/<userId>/` for objects older than 24h once we observe the orphan rate.

2. **Orphan handling.** Patients who abandon the wizard between upload and submit leave R2 objects with no DB row. Options:
   - (a) Accept it. R2 storage cost is trivial; sweep on a schedule (J's domain).
   - (b) Track a `pending_uploads` table with a TTL, delete objects + rows after 24h.
   - (c) Use R2's lifecycle rules to auto-expire objects in `orders/draft/` after 7d.
   - **Recommend (c)** — pure infra config, no app code to maintain. Confirm with Cloudflare R2 lifecycle docs (Open Question Q5 in §8).

3. **Rate limit.** `middleware.js:181-188` already limits `/api/cases` at 10 per 15min per IP. The wizard endpoint serves authenticated portal traffic, so per-user limits are more appropriate than per-IP. Recommend: 30 uploads / 15 min / user, mounted as `/portal/patient/files`. Blocks abuse without breaking patients with multi-image scans (typical case has 2-5 attachments).

4. **MIME / size enforcement.** Already covered by `src/middleware/upload.js` — 50 MB per file, full ext + MIME allowlist. **No change needed.** The new endpoint just `require('../middleware/upload')` and uses `upload.single('file')`.

5. **Feature flag.** The endpoint is mounted **only if `UPLOAD_R2_DIRECT_ENABLED === 'true'`** in env. This lets us deploy code first and turn it on per-environment. Default `false` until cutover.

6. **Error response shape.** Mirror what the wizard's JS already expects — return JSON with `{ ok: bool, error?: string, file?: { id, key, filename, mimeType, size } }`. Multer rejections produce 400; auth failures 401; rate limit 429; R2 failures 500 with generic message (no key/bucket leakage).

**Sub-issue A files affected:**

- `src/routes/patient.js` (or new `src/routes/patient_files.js` if scope warrants — recommend new file for isolation, mounted next to `patient.js` in `server.js`)
- `src/middleware.js` (one new rate-limit registration, can also live in the new route file — recommend route file for cohesion)
- No changes to `src/storage.js`, `src/middleware/upload.js`, or `/files/:id`.

**Estimated diff:** ~80–120 LOC for a new file `src/routes/patient_files.js` plus one mount line in `src/server.js`.

### Sub-issue B — Rewrite `patient_new_case.ejs` widget to FormData

**Goal:** Replace the Uploadcare widget at `src/views/patient_new_case.ejs:877-930` with a vanilla `fetch(POST /portal/patient/files, { body: FormData })` flow that posts to Sub-issue A's endpoint. UX parity: drag-and-drop, click-to-pick, progress message, file-row rendering on success, error rendering on failure. Same hidden-field submit on case-create.

**Behavior to preserve (verified at file open of `:877-930`):**

- Drag-and-drop into the form area (`.addEventListener('drop', ...)`)
- Click-to-pick via the existing `<input type="file" id="native_file">`
- Status messages (uploading/loading/failed) in the existing `#upload-progress` div
- File-row append into `#files-list` after successful upload
- Validation polling: fetches the case status every 5s while any file is in `checking` state — **this stays unchanged** (it's reading the AI quality result, not Uploadcare-specific)
- Hidden field `#file_url_input` populated with the upload result, then `form.submit()` triggers the case-create form post

**What changes:**

- Drop the `<script src="https://ucarecdn.com/libs/widget/3.x/uploadcare.full.min.js">` tag at line 879.
- Drop the `window.UPLOADCARE_*` config block at `:881-884`.
- Replace `window.uploadcare.fileFrom('object', file).done(info => { hidden.value = info.cdnUrl; ... })` with:
  ```javascript
  function doUpload(file) {
    if (!file) return;
    showProgress(statusMsg.uploading);
    var formData = new FormData();
    formData.append('file', file);
    formData.append('_csrf', getCsrfToken()); // read from existing meta tag or hidden field
    fetch('/portal/patient/files', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin'
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.ok && data.file) {
        hidden.value = data.file.key; // R2 key, not a URL
        form.submit();
      } else {
        showProgress(data && data.error ? data.error : statusMsg.failed);
      }
    })
    .catch(function() { showProgress(statusMsg.failed); });
  }
  ```
- Drop the `waitFor(...)` polling helper (no script to wait for).
- Keep the validation polling block (`:932-` onward) unchanged.

**Server-side change in `src/routes/patient.js`:**

The case-create handler at `:1956-2244` (the POST that consumes the wizard's submit) currently reads `req.body.file_url` (or whatever the hidden field name is) and stores it into `order_files.url`. After Sub-issue B, the value is an R2 key, not a URL. The handler needs no logic change because it just persists the value as-is — but we should rename the hidden field from `file_url` → `file_key` to make the semantic shift visible to future readers. Sub-issue B includes the EJS rename + the route-handler read-side rename.

**Feature flag wiring in the EJS:**

Render branches on a new local `__r2DirectEnabled = process.env.UPLOAD_R2_DIRECT_ENABLED === 'true'` (added to `uploadcareLocals` factory in `patient.js:75-77`, renamed appropriately). When `true`, render the new FormData path. When `false`, render the existing Uploadcare widget path. **Both paths coexist in the same EJS file during the migration window** so flipping the flag is a config change, not a deploy. (See §7 for rollback details.)

**Sub-issue B files affected:**

- `src/views/patient_new_case.ejs` (~50 LOC delta — replace the script/config block + the doUpload function)
- `src/routes/patient.js` (rename `uploadcareLocals` → `uploadLocals`; add `r2DirectEnabled` boolean; rename hidden field handling on the case-create POST)

**Estimated diff:** ~80 LOC across the two files.

### Sub-issue C — Rewrite `patient_order.ejs` widget to FormData

**Goal:** Same as Sub-issue B but for the additional-files-upload widget on the patient order detail page (`src/views/patient_order.ejs:646-668`). This widget uses `window.uploadcare.openDialog(...)` rather than `fileFrom('object', ...)`, and it lives on a different page with different surrounding context (the patient is viewing an existing order, so `orderId` is available).

**The endpoint is different:** because `orderId` exists, we can post to the existing `order_flow.js` `POST /order/:orderId/upload` route — which already does multer + R2 + INSERT into `order_files`. So Sub-issue C's server-side work is **zero** (the route already exists and works); the change is purely client-side.

**Sub-issue C files affected:**

- `src/views/patient_order.ejs` (~30 LOC delta — replace the openDialog flow with a FormData POST to `/order/<orderId>/upload`)
- `src/routes/patient.js` (`renderOrderDetail` may need to drop `uploadcareLocals` from this surface if it's used)

**Estimated diff:** ~40 LOC.

**Cutover ordering:** C should ship in the same deploy as A+B but can be feature-flagged independently (`UPLOAD_R2_DIRECT_ENABLED_ORDER_DETAIL = 'true'`) for a more granular rollout if needed. **Recommend single flag** for both surfaces — the surfaces are conceptually identical (patient uploads case files) and a per-surface flag adds operational complexity without proportional safety.

### Sub-issue D — Mobile API contract: dual-mode accept

**Goal:** `POST /api/v1/cases` (`src/routes/api/cases.js:236-244`) accepts both shapes:

- **Legacy:** `files: [{ uploadcareUuid, filename, mimeType, size }]` — keep working forever (or until Sub-issue J's backfill completes and we deprecate)
- **New:** `files: [{ fileId, filename, mimeType, size }]` where `fileId` is an R2 key returned from a new `POST /api/v1/files` endpoint (mobile equivalent of Sub-issue A)

**Implies a new endpoint:** `POST /api/v1/files` — the mobile-API equivalent of Sub-issue A. Same multer + R2 plumbing, different auth (API key + JWT instead of session cookie), different rate limit (per API key + per user), different folder (`orders/draft/<userId>/...` — same convention).

**Wire-format change to `POST /cases`:**

```javascript
// cases.js:236-244 — modified
for (const file of files) {
  const fileId = randomUUID();
  const isImage = isImageExtension(file.filename) || /^image\//i.test(file.mimeType || '');
  const initialStatus = isImage ? 'pending' : 'skipped';

  // Dual-mode: accept fileId (R2 key, new) OR uploadcareUuid (legacy)
  const r2Key = file.fileId || null;             // new mobile clients send this
  const ucUuid = file.uploadcareUuid || null;    // legacy mobile clients send this
  if (!r2Key && !ucUuid) {
    return res.fail('File missing fileId or uploadcareUuid', 400, 'INVALID_FILE');
  }

  await safeRun(`
    INSERT INTO order_files (id, order_id, url, uploadcare_uuid, filename, mime_type, size, ai_quality_status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
  `, [fileId, orderId, r2Key, ucUuid, file.filename, file.mimeType, file.size, initialStatus]);

  insertedFiles.push({ id: fileId, r2Key, uploadcareUuid: ucUuid, isImage, filename: file.filename });
}
```

**Read path also updates** — `cases.js:117-138` constructs `cdnUrl` from `uploadcareUuid`. After Sub-issue D, rows may have `url` set instead. The read path becomes:

```javascript
files.forEach(f => {
  // cdnUrl: only meaningful for legacy Uploadcare rows (kept for backward compat with old mobile builds)
  f.cdnUrl = f.uploadcareUuid ? `https://ucarecdn.com/${f.uploadcareUuid}/` : null;
  // url: portal-issued path that 302-redirects to a short-lived signed R2 URL OR the legacy CDN URL
  f.url = `/files/${f.id}`;
});
```

**Mobile client coordination (Open Question Q4 in §8):** the mobile app team needs to know when the new endpoint ships so they can update the upload SDK from "use Uploadcare's mobile SDK" to "POST to our `/api/v1/files` endpoint." This is a coordinated release. Recommend: server ships dual-mode acceptance first, mobile app ships its update on its own cadence. Server stays in dual-mode until telemetry shows zero new `uploadcareUuid` POSTs for 30 days, then deprecates.

**Sub-issue D files affected:**

- `src/routes/api/cases.js` (~20 LOC delta in the POST handler + ~5 LOC in the GET handler)
- `src/routes/api/files.js` (new file, ~80 LOC) — mobile-API equivalent of Sub-issue A's endpoint
- `src/server.js` (one mount line for the new route file)

**Estimated diff:** ~110 LOC across three files.

### Sub-issue E — Drop `'unsafe-eval'` + `ucarecdn.com` from CSP

**Goal:** Once A–D have soaked in production for ≥14 days and telemetry shows zero new Uploadcare widget loads (verified by `error_logs` having no CSP-violation reports referencing Uploadcare hosts, and by no new rows in `order_files` with `url LIKE 'https://ucarecdn.com/%'`), remove the Uploadcare-specific CSP carve-outs.

**What changes (`src/server.js:341-357`):**

| Directive | Before | After |
|---|---|---|
| `script-src` | `'self' 'unsafe-eval' 'nonce-X' https://ucarecdn.com https://cdn.jsdelivr.net https://media.twiliocdn.com https://unpkg.com` | `'self' 'nonce-X' https://cdn.jsdelivr.net https://media.twiliocdn.com https://unpkg.com` |
| `style-src` | `'self' 'unsafe-inline' https://ucarecdn.com https://fonts.googleapis.com` | `'self' 'unsafe-inline' https://fonts.googleapis.com` |
| `img-src` | `'self' data: blob: https://ucarecdn.com https://res.cloudinary.com https://api.qrserver.com` | `'self' data: blob: https://res.cloudinary.com https://api.qrserver.com` |
| `font-src` | `'self' data: https://ucarecdn.com https://fonts.gstatic.com` | `'self' data: https://fonts.gstatic.com` |
| `connect-src` | `'self' https://upload.uploadcare.com https://api.uploadcare.com https://ucarecdn.com` | `'self'` |
| `frame-src` | `'self' https://uploadcare.com https://ucarecdn.com` | `'self'` |

**Comment block at `:349-353`** (explaining why `'unsafe-eval'` is required) is deleted. Replace with a one-liner explaining that the previous Uploadcare carve-outs were removed in Theme 13 and listing the SHA range of A–D so a future maintainer can git-blame the context.

**What also changes (`src/middleware.js:14-72`):**

Delete the entire `contentSecurityPolicy` directive block from the helmet config. Helmet's other defaults (X-Frame-Options, etc.) stay. **Reasoning:** the manual middleware in `server.js` is the source of truth (proven in §2d). The helmet block is dead for CSP and confuses readers. Removing it eliminates the two-sources-of-truth footgun.

**The cross-portal-links audit (`docs/audits/cross-portal-links-audit.md`)** may have CSP-related entries that need updating — out of scope for this sub-issue but flagged in K.

**Sub-issue E files affected:**

- `src/server.js` (CSP string, ~5 LOC delta)
- `src/middleware.js` (delete `contentSecurityPolicy` block, ~50 LOC delta)

**Estimated diff:** ~55 LOC removed.

### Sub-issue F — Env var cleanup

**Goal:** Remove the dead Uploadcare env-var infrastructure now that nothing reads them.

**Boot-time validator (`src/server.js:84-96`):**

The boot doc-table includes detailed prose for `UPLOADCARE_PUBLIC_KEY` (validated, with a long explanation referencing the patient wizard) and an explicit non-validation comment for `UPLOADCARE_SECRET_KEY` (audit §6a flagged this as a gap; Theme 13 closes the gap by deleting the var entirely instead of implementing it). After Sub-issue E, both come out:

- Drop the `UPLOADCARE_PUBLIC_KEY` entry from `REQUIRED_ENVS_DOCS` table.
- Drop the multi-line comment block at `:89-96`.
- Confirm no other code path reads `process.env.UPLOADCARE_*` (audit confirmed only `verify.js` and `ops.js` — both addressed below).

**`/verify` admin readiness page (`src/routes/verify.js:99-149`):**

The "Keys" panel explicitly renders the Uploadcare public key state. Drop the panel row + the variable read.

**`/ops/...` (`src/routes/ops.js:976-978`):**

Drop the `uploadcare_public_key_set/length/prefix` fields from the response.

**`.env.example`:**

Remove `UPLOADCARE_PUBLIC_KEY` and `UPLOADCARE_SECRET_KEY` lines. Add a one-line comment in their place: `# Uploadcare retired in Theme 13 (<SHA>); patient uploads now go to R2 directly.`

**`.env.production`:**

Already does not contain R2_* vars (set in Render dashboard). Confirm `UPLOADCARE_PUBLIC_KEY` is not in committed production env (audit confirmed it is — should be deleted from .env.production too).

**Render dashboard cleanup:**

After production deploys are stable, delete `UPLOADCARE_PUBLIC_KEY` and `UPLOADCARE_SECRET_KEY` from Render's env panel. **Outside-repo task; flagged in §5 verification steps.**

**Sub-issue F files affected:**

- `src/server.js` (env validator block)
- `src/routes/verify.js` (key panel)
- `src/routes/ops.js` (key fields)
- `.env.example`, `.env.production`

**Estimated diff:** ~30 LOC removed.

### Sub-issue G — i18n string cleanup

**Goal:** Remove the "UPLOADCARE_PUBLIC_KEY not set in .env" warning strings now that they're unreachable.

**`src/i18n.js:122` (EN):**
```
'patient.upload.warning_not_configured_body': 'Files cannot be uploaded until UPLOADCARE_PUBLIC_KEY is set in .env and the server is restarted.',
```

**`src/i18n.js:380` (AR):**
```
'patient.upload.warning_not_configured_body': 'لا يمكن رفع الملفات حتى يتم إضافة UPLOADCARE_PUBLIC_KEY في ملف .env ثم إعادة تشغيل السيرفر.',
```

Both strings are referenced by the wizard's `if (!__uploaderConfigured) { /* show warning */ }` branch. After Sub-issue B, `__uploaderConfigured` becomes `__r2DirectEnabled` (or is dropped entirely if we drop the off-state). Either way, the string is unreachable.

**Recommendation:** delete the keys + the EJS branch that reads them. If a future maintainer needs to gate the upload widget on env, they can add a more accurate string at that time. **Sub-issue G files affected:**

- `src/i18n.js` (2 lines deleted, plus any companion `_title` key)
- `src/views/patient_new_case.ejs` (the warning branch)

**Estimated diff:** ~15 LOC removed.

### Sub-issue H — Regression tests

**Goal:** Add a `theme13-*.test.js` suite under `tests/core/` that locks down the migration's invariants. Test density should match Theme 7 / Theme 8 (~5–10 tests per phase).

**Proposed test list:**

| # | Test name | What it asserts |
|---|---|---|
| 1 | `theme13-r2-endpoint-rejects-when-flag-off.test.js` | When `UPLOAD_R2_DIRECT_ENABLED !== 'true'`, `POST /portal/patient/files` returns 404 (route not mounted) |
| 2 | `theme13-r2-endpoint-happy-path.test.js` | Flag on; POST a small JPG; expect 200, `{ok:true, file: {key, ...}}`; key matches `orders/draft/<userId>/<uuid>.jpg` pattern |
| 3 | `theme13-r2-endpoint-rejects-bad-mime.test.js` | Flag on; POST an .exe; expect 400, multer-rejection error |
| 4 | `theme13-r2-endpoint-rate-limited.test.js` | Flag on; POST 31 files in 15min from same user; expect 31st to 429 |
| 5 | `theme13-r2-endpoint-requires-auth.test.js` | No session cookie; expect 401 redirect to /login |
| 6 | `theme13-mobile-api-dual-mode.test.js` | `POST /api/v1/cases` accepts both `{files:[{uploadcareUuid:...}]}` and `{files:[{fileId:...}]}`; both INSERT correctly with the right column populated |
| 7 | `theme13-mobile-api-rejects-neither-id.test.js` | `POST /api/v1/cases` with `{files:[{filename:'x.jpg'}]}` (no fileId, no uploadcareUuid); expect 400 |
| 8 | `theme13-files-route-handles-r2-key.test.js` | Insert order_files row with `url='orders/draft/.../x.pdf'`; GET `/files/<id>`; expect 302 to a signed URL containing the bucket name |
| 9 | `theme13-files-route-handles-legacy-uploadcare-url.test.js` | Insert order_files row with `url='https://ucarecdn.com/abc/'`; GET `/files/<id>`; expect 302 to that URL verbatim |
| 10 | `theme13-csp-no-unsafe-eval.test.js` | After Sub-issue E ships, GET `/portal/patient/new-case`; assert CSP header contains no `'unsafe-eval'` and no `ucarecdn.com` |
| 11 | `theme13-no-uploadcare-env-readers.test.js` | grep-style: assert no `process.env.UPLOADCARE_*` reads remain in `src/` |

Tests 1–9 land with A+B+D. Test 10 lands with E. Test 11 lands with F.

**Sub-issue H files affected:**

- 11 new files under `tests/core/theme13-*.test.js`
- Possibly `tests/run.js` if the runner needs to be told about the new files (existing runner appears to glob, so no change needed; verify)

### Sub-issue I — AI image-quality validator: buffer-direct path

**Goal:** Stop fetching `https://ucarecdn.com/<uuid>/` from the AI worker. Use the buffer we already have in memory at upload time.

**Today (`src/routes/api/cases.js:249-287`):**

The fire-and-forget `setImmediate` worker calls `validateImageFromUrl('https://ucarecdn.com/<uuid>/', ...)`. After Sub-issue D, mobile-uploaded files won't necessarily have a CDN URL (they may have an R2 key + signed URL). Two options:

- (a) **Switch to `validateImageFromUrl(signedR2Url, ...)`** — works because `validateImageFromUrl` is generic, but introduces a dependency on signed-URL expiry timing. The AI check is `setImmediate`, so it runs within milliseconds; 1-hour signed URL is plenty of headroom. **But** it adds a network round-trip we don't need.
- (b) **Switch to `validateMedicalImage(buffer, mimeType, expectedScanType)`** — bypasses the URL fetch entirely. The buffer must be captured before the multer/R2 handler returns; pass it through the case-create POST flow.

**Recommendation:** (b). The buffer is already in memory; using it is faster and avoids the (admittedly unlikely) signed-URL-expiry edge case. Implementation: the new `POST /api/v1/files` endpoint returns `{file: {id, key, filename, mimeType, size, _internalBuffer: undefined}}` to the client, but **caches the buffer server-side with a short TTL keyed by `file.id`** (e.g., in-memory Map with 60s expiry). The case-create handler then retrieves the buffer for the AI check before the cache expires.

**Caveat:** server-side buffer caching adds memory pressure and complicates horizontal scaling (cache is per-process). For a single-Render-instance deployment, this is fine. For multi-instance, the cache misses cause fallback to (a). **For Theme 13 scope, recommend (a)** — switch to signed R2 URL — as the simpler, scale-safe path. Revisit (b) if AI check latency becomes a bottleneck.

**Revised recommendation: (a) — pass signed R2 URL to `validateImageFromUrl`.**

**Sub-issue I files affected:**

- `src/routes/api/cases.js` (worker block, ~10 LOC)
- `src/ai_image_check.js` (no change — already URL-generic)

**Estimated diff:** ~10 LOC.

### Sub-issue J — Backfill historical Uploadcare CDN URLs to R2 (DEFERRED to follow-up)

**Goal (deferred):** A one-shot script that walks every `order_files` row where `url LIKE 'https://ucarecdn.com/%'` OR `uploadcare_uuid IS NOT NULL`, downloads the file from the CDN, uploads it to R2 under the appropriate folder, and updates the row to point at the R2 key. Runs once, idempotent, dry-run-able, batchable.

**Why deferred:** independent of cutover. Cutover (A–D) is "stop writing new Uploadcare URLs." Backfill is "rewrite the historical ones." The two have orthogonal failure modes. Combining them in one theme increases the rollback surface (a backfill bug shouldn't be able to roll back the cutover).

**Why eventually necessary:** without backfill, we cannot deprovision the Uploadcare account — every legacy URL becomes a 404. As a CDN-side dependency that ages, this gets worse over time.

**Estimated scope (for the follow-up theme):**

- `scripts/backfill_uploadcare_to_r2.js` — paginated downloader/uploader with `--dry-run`, `--limit`, `--continue-from-id` flags
- 1 new test (`theme13-followup-backfill-script-idempotent.test.js`)
- Coordinate with R2 storage cost forecast (multiply current Uploadcare object count × avg size)

**Open Question Q6 in §8:** what's the historical row count? `SELECT COUNT(*) FROM order_files WHERE url LIKE 'https://ucarecdn.com/%' OR uploadcare_uuid IS NOT NULL` from production.

### Sub-issue K — Documentation + side-issue closure

**Goal:** Update the project's narrative documents to reflect the migration.

**Files:**

- `docs/INTEGRATIONS.md` — rewrite the "Uploadcare (file CDN)" section to reflect retirement (or delete entirely once Sub-issue J completes).
- `src/views/privacy.ejs` — already says "Cloudflare R2" (audit §2c); confirm still accurate after migration.
- `src/views/public_case_new.ejs:119-126` — change copy from "If your files are too big, you can paste secure links (Uploadcare/Drive...)" to "If your files are too big, you can paste secure links (Drive, Dropbox, etc.)." Functional behavior unchanged (the field accepts any URL string).
- `docs/audits/SIDE_ISSUES_BACKLOG.md` row #52 — change status from `DEFERRED` to `RESOLVED`; add resolution note pointing at Theme 13's commit range.
- `CLAUDE_CODE_BRIEF_PHOTO_UPLOAD_DEBUG.md` — already historical; no change required (the doctor photo path was always R2; this brief is about a different bug).
- `docs/audits/UPLOAD_PROVIDER_AUDIT.md` — append a "RESOLVED" header at the top after Theme 13 ships.

**Estimated diff:** ~50 LOC across documentation files.

### Sub-issue summary table

| # | Sub-issue | Sub-theme phase | Lands with | Lines (est.) | Risk |
|---|---|---|---|---|---|
| A | New POST endpoint (portal) | Phase 1 (cutover) | A+B+D+I+H₁₋₉ | ~110 | High (new payment-blocking surface) |
| B | Wizard view rewrite | Phase 1 | with A | ~80 | High (patient-facing UX change) |
| C | Order detail view rewrite | Phase 1 | with A+B | ~40 | Medium (smaller patient surface) |
| D | Mobile API dual-mode | Phase 1 | with A | ~110 | Medium (mobile coordination required) |
| E | CSP cleanup | Phase 2 (cleanup, ≥14d after cutover) | E | -55 | Low if cutover stable |
| F | Env var cleanup | Phase 2 | with E | -30 | Low |
| G | i18n string cleanup | Phase 2 | with E | -15 | Low |
| H | Regression tests | mostly Phase 1 (1–9), Phase 2 (10–11) | A+B+D / E+F | ~250 | None |
| I | AI validator path swap | Phase 1 | with D | ~10 | Low |
| J | Legacy backfill | DEFERRED to Theme 13B | — | ~120 | Medium (data integrity) |
| K | Documentation | Phase 2 | with E+F+G | ~50 | None |

**Total Theme 13 diff (excluding J):** ~640 LOC added/changed, ~100 LOC removed → net ~+540 LOC. Tests are ~40% of that.

---

## 5. Verification Steps

### 5a. Pre-deploy (local)

1. `npm test -- --grep theme13` — all 11 new tests pass.
2. Boot server with `UPLOAD_R2_DIRECT_ENABLED=true`; verify `[R2] Connected to <bucket>` log line still fires (no regression in storage.js bootcheck).
3. `curl -X POST -F file=@test.jpg http://localhost:3000/portal/patient/files` with a valid session cookie + CSRF token; verify 200 + JSON response.
4. `curl -X POST` with an `.exe` extension; verify 400 + multer-rejection error.
5. Open `/portal/patient/new-case` in a browser; verify the FormData widget renders (no `ucarecdn.com` script tag in DOM); upload a file; verify it appears in the file list and submits the form.
6. Open `/portal/patient/orders/<id>` for an existing order; upload an additional file; verify it appears.
7. Mobile-API smoke: `curl -X POST` to `/api/v1/files` with API key + JWT; verify 200 + `{file: {key}}`. Then `curl -X POST` to `/api/v1/cases` with `{files: [{fileId: <key>, ...}]}`; verify 201 + case created. Then `curl -X POST` to `/api/v1/cases` with the legacy `{files: [{uploadcareUuid: 'fake-uuid', ...}]}` shape; verify 201 (dual-mode acceptance).
8. Boot server with `UPLOAD_R2_DIRECT_ENABLED=false`; verify wizard renders the legacy Uploadcare widget (UPLOADCARE_FALLBACK_ENABLED implicit-true behavior).

### 5b. Pre-cutover (staging / production with feature flag off)

1. Deploy with `UPLOAD_R2_DIRECT_ENABLED=false`. Verify zero behavior change vs prior version.
2. Smoke-test wizard upload (still goes through Uploadcare).
3. Confirm `error_logs` shows no new `r2_bucket` or `patient_upload` rows (no traffic to the new endpoint).

### 5c. Cutover (production, flag flip)

1. Set `UPLOAD_R2_DIRECT_ENABLED=true` in Render dashboard. Restart.
2. Within 5 minutes: open production wizard in incognito; complete a real test case submission.
3. Within 1 hour: query `SELECT COUNT(*) FROM order_files WHERE created_at > NOW() - INTERVAL '1 hour' AND url NOT LIKE 'https://%'`. Expect non-zero (R2 keys flowing in).
4. Within 1 hour: query `SELECT COUNT(*), error_message FROM error_logs WHERE created_at > NOW() - INTERVAL '1 hour' AND category IN ('patient_upload','r2_bucket') GROUP BY error_message`. Expect zero or near-zero.
5. Within 24 hours: rate of new-case submissions should match pre-cutover baseline (compare same-day-of-week historical median).

### 5d. Cleanup (Phase 2, ≥14 days after cutover)

1. After 14 days of clean cutover telemetry: ship E+F+G+K commits.
2. After Sub-issue E: open production page, inspect CSP header, confirm no `'unsafe-eval'` and no `ucarecdn.com`.
3. After Sub-issue F: delete `UPLOADCARE_PUBLIC_KEY` and `UPLOADCARE_SECRET_KEY` from Render env panel. Restart. Confirm app boots.
4. Confirm `/verify` and `/ops/...` no longer reference Uploadcare keys.

### 5e. Backfill phase (J, separate theme)

Out of Theme 13 scope; covered by Theme 13B / J's own verification plan.

### 5f. Test gating in CI

The `tests/core/theme13-*` suite must be added to CI. If `tests/run.js` globs `tests/**/*.test.js` it picks them up automatically. Verify on first commit.

---

## 6. Test Coverage Required

(Test list moved here from §4 H for cohesion.)

**Phase 1 (lands with A+B+D+I):**

- T1: New endpoint 404s when feature flag off
- T2: New endpoint happy-path (jpg → R2 key returned)
- T3: New endpoint rejects bad MIME (.exe → 400)
- T4: New endpoint rate-limited (31st req from same user → 429)
- T5: New endpoint requires auth (no session → 401 redirect)
- T6: Mobile API dual-mode accept (both `uploadcareUuid` and `fileId` work)
- T7: Mobile API rejects request with neither field
- T8: `/files/:id` handles R2 key (302 to signed URL)
- T9: `/files/:id` handles legacy Uploadcare URL (302 verbatim)

**Phase 2 (lands with E+F):**

- T10: CSP header has no `'unsafe-eval'` and no `ucarecdn.com`
- T11: No `process.env.UPLOADCARE_*` readers remain in `src/`

**Test density rationale:** matches Theme 7 / Theme 8 (5–10 per phase). Could go higher if needed:

- T12 (suggested): Idempotency — same file uploaded twice produces two distinct R2 keys (UUID-based key)
- T13 (suggested): Concurrency — 5 simultaneous uploads from same user all succeed (no R2 client connection-pool starvation)
- T14 (suggested): Large file at the boundary — exactly 50MB (current limit) succeeds; 50MB + 1 byte fails

**Open Question Q7 in §8:** test density preference — 11 tests (parity with prior themes) or 14 (with the suggested extras)?

**Manual UAT (not automated):**

- Upload a real DICOM file (the multer allowlist accepts `.dcm`)
- Upload a real PDF lab report (the typical patient case)
- Upload a HEIC photo from an iPhone (browser misreports as `application/octet-stream`; multer's `OCTET_STREAM_TOLERANT_EXTS` should accept)
- Drag-and-drop a file onto the wizard
- Click-to-pick a file via the native file dialog
- Cancel an upload mid-progress (close the tab); verify the orphaned R2 object exists and gets cleaned up by the lifecycle rule (verify within 7 days)

---

## 7. Rollback Plan

**Patient case file uploads are payment-blocking.** This section is the single most operationally critical part of the theme. Three rollback layers, in increasing order of cost.

### 7a. Layer 1 — Feature flag flip (zero deploy, ~30 sec to recover)

`UPLOAD_R2_DIRECT_ENABLED=false` in Render → restart → wizard renders the legacy Uploadcare widget. New uploads flow back through Uploadcare. No code change, no deploy, no commit revert.

**Pre-requisite:** the legacy Uploadcare widget code path must remain in `patient_new_case.ejs` and `patient_order.ejs` during the migration window. Sub-issue B and C **must not delete the legacy code path** in their initial commit — they add the FormData path alongside, gated on the flag. The legacy path is deleted in Phase 2 (Sub-issue G), only after the flag has been on for ≥14 days with clean telemetry.

**Recovery time:** ~30 seconds (Render env-var restart).

**Triggers:** any of the following observed within 24h of cutover:

- `error_logs` rows with `category IN ('patient_upload','r2_bucket')` count > 5/hour
- New-case submission rate drops > 30% vs same-day-of-week historical baseline
- Ops manually flips the flag in response to a user complaint

### 7b. Layer 2 — Fallback flag (`UPLOADCARE_FALLBACK_ENABLED=true`)

If the legacy path itself has bit-rot (e.g., the Uploadcare account expires before backfill is done, or the CDN URLs become unreachable), Layer 1 doesn't help. Layer 2: render **both widgets** on the wizard simultaneously, each labeled, and let the user pick. This is uglier UX but preserves the ability to ship cases.

**Implementation:** `UPLOADCARE_FALLBACK_ENABLED=true` (default `false`) renders an "Alternative upload method" toggle on the wizard. Toggling shows the Uploadcare widget instead of the FormData path. Server-side accepts both submission shapes (the case-create handler already does — the hidden field is the same regardless of how it was populated).

**Recovery time:** ~30 seconds (env flag flip, no deploy).

**Triggers:** R2 outage (rare — Cloudflare R2 SLA is high) or a regression in `src/storage.js` that breaks signed-URL generation.

### 7c. Layer 3 — Code revert (full deploy, ~10 min to recover)

`git revert <theme-13-A-B-D-commit-range>` and re-deploy. Resets the wizard to pre-Theme-13 state. Slow, hard-to-target if the bad commit is in the middle of a stack.

**Recovery time:** ~10–15 minutes (CI build + deploy).

**Triggers:** layers 1 and 2 don't apply (e.g., cutover passes initial telemetry, then a latent bug surfaces 7 days later that requires a real fix).

### 7d. Cutover criteria (when to remove the rollback safety net)

Sub-issue G (delete the legacy widget path from EJS) only ships when **all** of:

1. `UPLOAD_R2_DIRECT_ENABLED=true` has been live in production for ≥14 days.
2. `error_logs` `category IN ('patient_upload','r2_bucket')` count is < 1/day for the last 7 days.
3. New-case submission rate is within ±10% of the 30-day pre-cutover baseline.
4. Mobile API: zero new POSTs with `uploadcareUuid` for ≥30 days (this is more lenient because mobile rollouts are slower).
5. Ziad explicit go-ahead.

If any criterion fails: extend the soak period; do not ship E+F+G.

### 7e. Worst-case scenario walkthrough

**Scenario:** Cutover on Day 0. Day 1, R2 starts intermittently 503-ing. Patient uploads start failing. New-case submissions drop 80% in 10 minutes.

**Response:**

- T+5min: ops notices the drop in the new-case rate dashboard.
- T+6min: ops checks `error_logs`, sees `category='r2_bucket'` rows.
- T+7min: ops flips `UPLOAD_R2_DIRECT_ENABLED=false` in Render. Restart triggered.
- T+8min: server up; wizard reverts to Uploadcare. Patients retrying succeed.
- T+15min: post-mortem starts; R2 Status page checked; if Cloudflare-side, wait it out; if our-side, debug.

**Total customer impact:** 7 minutes of broken uploads. Patients who attempted in that window get a "try again" message. **No data loss** — failed uploads never made it to the DB.

### 7f. Rollback explicitly does NOT cover

- A bug in the existing `order_flow.js` R2 path (out of Theme 13 scope; that path is unchanged).
- A bug in `/files/:id` (out of Theme 13 scope; route is unchanged).
- A bug in the multer middleware (out of Theme 13 scope).
- An R2 bucket-permissions misconfiguration (Render env variable rotation issue, predates Theme 13).

These would have been broken before Theme 13 too; rollback to pre-Theme-13 state would not help.

---

## 8. Open Questions for Ziad

Eight decisions need your sign-off before Step 3 implementation can begin. Each has a recommended answer and a brief rationale; redirect freely.

### Q1 — Cutover strategy

**Question:** Single feature flag for both wizard surfaces (B + C ship together, flip together) or two flags (`UPLOAD_R2_DIRECT_ENABLED_WIZARD` + `UPLOAD_R2_DIRECT_ENABLED_ORDER_DETAIL`)?

**Recommendation:** **Single flag.** The two surfaces are conceptually identical (patient uploads case files); per-surface flags add operational complexity without proportional safety. If the wizard has a bug, the order-detail surface almost certainly has the same bug.

**Cost of being wrong:** if a bug is surface-specific, single-flag forces an all-or-nothing rollback. Two flags would let us roll back just the broken surface. Given the surfaces share ~95% of the code (same endpoint, same multer, same R2 path), a surface-specific bug is unlikely.

### Q2 — Mobile API contract migration

**Question:** Same `POST /api/v1/cases` endpoint with dual-mode acceptance (recommended), OR new `/api/v2/cases` endpoint, OR header-based content negotiation (`X-Tashkheesa-Upload-Mode: r2|uploadcare`)?

**Recommendation:** **Dual-mode accept on `/api/v1/cases`.** Simplest for mobile, no version negotiation, no client-side feature flag in the mobile app. Mobile code starts sending `fileId` when its update ships; old `uploadcareUuid` field stays as fallback. Deprecate after telemetry shows zero new `uploadcareUuid` POSTs for 30 days.

**Cost of being wrong:** if dual-mode introduces latent inconsistency (e.g., a row with both `url` and `uploadcare_uuid` set causes ambiguous reads), we'd need a follow-up cleanup. Mitigation: enforce in the INSERT that exactly one of the two is non-null.

### Q3 — Legacy backfill — in this theme or follow-up?

**Question:** Should Sub-issue J (backfill historical Uploadcare CDN URLs to R2) ship in Theme 13, or as a follow-up Theme 13B?

**Recommendation:** **Follow-up Theme 13B.** Cutover and backfill have orthogonal failure modes; combining them increases the rollback surface. Backfill is a one-shot script that doesn't need to coordinate with the cutover deploy.

**Cost of being wrong:** delaying backfill means the Uploadcare account stays alive, costing money each month, and the publicly-addressable CDN URLs (audit §6a) remain a privacy gap for legacy cases. If Uploadcare's monthly cost is meaningful, you may want backfill in this theme to reduce time-to-shutoff.

**Sub-question:** what is the historical row count? `SELECT COUNT(*) FROM order_files WHERE url LIKE 'https://ucarecdn.com/%' OR uploadcare_uuid IS NOT NULL` from production. If the answer is < 1000, backfill is trivial and could ride with this theme. If > 100k, definitely follow-up.

### Q4 — Mobile app team coordination

**Question:** Who tells the mobile app team about the new `/api/v1/files` endpoint and the new `fileId` field on `POST /cases`? Is there a versioning / release-coordination doc?

**Recommendation:** Server ships dual-mode acceptance first. Mobile app team adopts on its own cadence using the new endpoint when ready. No coordination required for cutover (server stays backward-compatible). I can add an entry to `docs/INTEGRATIONS.md` and/or create a one-page "Mobile API: R2 Direct Upload" doc if useful.

**What I need from you:** confirm the mobile app team's contact + preferred handoff channel (Slack, GitHub, email).

### Q5 — R2 lifecycle rule for orphaned drafts

**Question:** Use Cloudflare R2's bucket lifecycle rule to auto-expire objects in `orders/draft/` after 7 days, OR app-level scheduled sweep?

**Recommendation:** **R2 lifecycle rule.** Pure infra config, no app code to maintain. Cloudflare supports lifecycle rules on R2 (via the dashboard or API).

**What I need from you:** confirm you're OK with me proposing a Cloudflare-side config change (or do you want to apply it yourself / via Terraform / etc.)?

### Q6 — Pre-cutover historical row count

**Question:** Run this query against production and share the result:
```sql
SELECT
  COUNT(*) FILTER (WHERE url LIKE 'https://ucarecdn.com/%') AS legacy_url_rows,
  COUNT(*) FILTER (WHERE uploadcare_uuid IS NOT NULL) AS legacy_uuid_rows,
  COUNT(*) FILTER (WHERE url IS NULL AND uploadcare_uuid IS NULL) AS null_rows,
  COUNT(*) AS total_rows
FROM order_files;
```

**Why I need it:** sizes the backfill effort (Q3 above), confirms the dual-mode column theory in §2c, and surfaces any null-row anomalies. Cheap query (single table scan; small table).

### Q7 — Test density

**Question:** 11 tests (parity with Theme 7 / 8) or 14 (adding T12 idempotency, T13 concurrency, T14 50MB boundary)?

**Recommendation:** **11.** Parity with prior themes; the extras are valuable but more easily added in a follow-up if a bug surfaces. Don't pre-emptively engineer.

### Q8 — `'unsafe-eval'` removal — same commit as cutover or separate?

**Question:** Drop `'unsafe-eval'` + ucarecdn carve-outs from CSP in the same commit as the new R2 endpoint (defense-in-depth: rollback also rolls back CSP), OR separate commit ≥14 days later (independent rollback surface)?

**Recommendation:** **Separate commit ≥14 days after cutover.** CSP changes can break in subtle ways across browsers (Safari, in-app webviews, mobile OS-managed Chromium). Land R2 first, monitor, then drop `'unsafe-eval'` as Phase 2. This matches my Sub-issue ordering in §4.

**Cost of being wrong:** if the cutover ships and someone forgets to do the CSP cleanup, we live with `'unsafe-eval'` longer than necessary. Mitigation: add a TODO with a date and an owner.

---

## §8 surfacing summary

The eight questions, ranked by what blocks Step 3 implementation:

| Q | Blocks | Default if you don't reply | Risk if default is wrong |
|---|---|---|---|
| Q1 (single vs per-surface flag) | A+B+C wiring | single flag | one extra rollback path needed |
| Q2 (mobile API contract) | D wiring | dual-mode on v1 | small — easy to add v2 endpoint later |
| Q3 (backfill in/out of theme) | scope total | follow-up Theme 13B | cost: Uploadcare bill keeps running |
| Q4 (mobile team coord) | D ship | I add an INTEGRATIONS.md note + ping you to forward | small |
| Q5 (R2 lifecycle rule) | A scoping (orphan handling) | propose lifecycle rule, you apply | small |
| Q6 (historical row count) | J scoping (deferred) | proceed without it; sized when J starts | none for Theme 13 |
| Q7 (test density) | H scope | 11 tests | small — easy to add later |
| Q8 (CSP cleanup timing) | E ship | separate commit ≥14d after cutover | small — already the safer path |

**None of these block scoping. All of them block Step 3 implementation.** Q1, Q2, Q3, Q5, Q8 are decision-driven; Q4, Q6 are info-gathering. Q7 is a preference.
