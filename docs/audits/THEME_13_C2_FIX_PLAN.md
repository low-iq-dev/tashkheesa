# Theme 13 Sub-issue C2 — Messages-Attach Migration: Fix Plan

**Status:** Scoping only. No code changes in this commit.
**Reference:**
- `docs/audits/THEME_13_R2_MIGRATION_FIX_PLAN.md` §4 Sub-issue C2 (the original deferral note)
- `docs/audits/UPLOAD_PROVIDER_AUDIT.md` (the source-of-truth provider inventory)
- Working code: `src/views/patient_order.ejs:645-693` (widget), `src/routes/patient.js:3094-3181` (handler), `src/views/partials/patient/file-tile.ejs` (display), `src/server.js:469-525` (`/files/:id` reader)

**Scope shift:** Theme 13 was originally on **Path A** (defer C2 to post-cutover). Ziad has retroactively flipped to **Path B** — full Uploadcare retirement before the wizard cutover flag flips. C2 is now the next phase (Phase 6) before Phase 7 (E + F + G cleanup) and Phase 8 (flag flip).

**Sister sub-issues:** A (portal endpoint, shipped), B (wizard view, shipped), C (locals consistency, shipped), D (mobile API + AI worker, shipped), H (regression backstop, shipped). C2 closes the last remaining Uploadcare lane.

---

## 1. Executive Summary

The messages-attach widget at `patient_order.ejs:645-693` is the only Uploadcare-dependent surface still alive after Phases 1-5. It has a **different contract from the wizard upload** (Phase 2's Sub-issue B): the widget populates hidden form fields (`msg-file-url`, `msg-file-name`) on a message-reply form that posts to `/portal/patient/orders/:id/messages` (handler at `patient.js:3094-3181`). The handler stores the value verbatim into `messages.file_url` (TEXT) AND mirrors it into `order_additional_files.file_url` (also TEXT). The patient's display path renders `m.file_url` as a literal `<a href>` via `file-tile.ejs:16` — broken if the value is anything other than an absolute URL.

**Three contract changes are required, not one.** The original scoping doc (Theme 13 fix plan §4 C2) called out the messages.file_url shape but missed the `order_additional_files` mirror. C2 must touch both tables to keep the doctor's order-detail "Additional files" list functional after a patient sends a message-attached R2 file.

**The good news:** **production has zero data on every relevant table** (`messages: 0`, `conversations: 0`, `order_additional_files: 0` — verified by direct prod query 2026-05-14). This mirrors the Q6 finding for the wizard widget — the messages-attach feature has never been exercised in production. Backfill scope = nothing. Cutover risk profile = "feature works for first time," not "migration of existing data."

**The doctor side is silent:** there is no doctor-side messages-attach widget (no `paperclip` / `openDialog` / `UPLOADCARE` references in `doctor.js` or any `portal_doctor_*.ejs`), and `messages.ejs` (the unified thread view) **never displays `file_url`** — confirmed by `grep -n 'file' messages.ejs` returning zero matches in the file-related substring set. The doctor sees patient-attached files **only** through `order_additional_files` listed in the order-detail "Documents" tab. So C2's display fix needs to land in two places: `patient_order.ejs:591-595` (file-tile call) AND wherever the doctor displays `order_additional_files`.

**Recommended approach:** ship 7 sub-issues (C2.A through C2.G), all gated behind a new `MESSAGES_R2_ENABLED` env flag (independent of `UPLOAD_R2_DIRECT_ENABLED` for granular rollback). Reuse Sub-issue A's `POST /portal/patient/files` endpoint with a new optional `folder` form field instead of building a parallel endpoint. Extend the existing `/files/:id` reader to also resolve from `messages.file_key` and `order_additional_files.file_key` rather than spawning a new resolver route.

---

## 2. Current State

### 2a. The widget surface (single file, single block)

**`src/views/patient_order.ejs:645-693`** — the Uploadcare 3.x widget that drives the message-attach paperclip button. Mounted only when `__ucPk` (the trimmed UPLOADCARE_PUBLIC_KEY local) is truthy. Wires the `#msg-attach` button to `window.uploadcare.openDialog(null, { multiple: false, tabs: 'file url' })`. On `done(...)` it sets `msg-file-url.value = info.cdnUrl` and `msg-file-name.value = info.name`, then shows the preview chip "Attached: foo.pdf · clear".

The form itself is at `patient_order.ejs:606-626` — message reply form posting to `/portal/patient/orders/<orderId>/messages`. Fields:
- `<input type="hidden" name="file_url" id="msg-file-url" />`
- `<input type="hidden" name="file_name" id="msg-file-name" />`
- `<textarea name="content" id="msg-content">` (the message body)
- Submit button → standard form POST → server handler.

The form has CSRF (`csrfField()` at line 614). The page's `__ucPk` local is wired via `patient.js:2807` (which after Phase 3 spreads `...uploadcareLocals`, so `r2DirectEnabled` is also available — pre-staged for C2).

### 2b. The server handler (single file, single block)

**`src/routes/patient.js:3094-3181`** — `POST /portal/patient/orders/:id/messages`. Verified at file open:

```javascript
// :3099-3100
const fileUrl = String(body.file_url || '').trim();
const fileName = String(body.file_name || '').trim().slice(0, 200);
```

```javascript
// :3145 — mirror to order_additional_files (gated on http(s) — would silently skip R2 keys today)
if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
  try {
    await insertAdditionalFile(orderId, fileUrl, fileName || null, nowIso);
  } catch (e) { /* non-blocking */ }
}
```

```javascript
// :3164-3168 — primary message INSERT (accepts ANY string in fileUrl, no validation)
await execute(
  `INSERT INTO messages
     (id, conversation_id, sender_id, sender_role, content, message_type, file_url, file_name, created_at)
   VALUES ($1, $2, $3, 'patient', $4, $5, $6, $7, $8)`,
  [messageId, conversationId, senderId, content, messageType, fileUrl || null, fileName || null, nowIso]
);
```

The handler pre-resolves `messageType` at `:3162` (`'file' if fileUrl-only, 'text' otherwise`) and wraps text content with `(fileName || isAr_safe(req) ? 'ملف' : 'File')` if there's no body. The `insertAdditionalFile` helper at `patient.js:868-906` handles the schema-drift fallback for the `label` column (`order_additional_files.label` was added later — defensive `hasColumn` check on every call).

**No file shape validation** at the handler. Whatever the client sends as `file_url` lands verbatim in `messages.file_url`. The mirror to `order_additional_files` is the only place that gates on `^https?://` — and it gates the INSERT, not a return value, so an R2 key submitted today would silently skip the mirror but still land in `messages.file_url`. After C2 we want the opposite: route both columns to the right format with explicit validation.

### 2c. The display paths (two consumers, different routes)

**Patient side — `patient_order.ejs:591-595`**:
```ejs
<% if (m.message_type === 'file' || m.file_url) { %>
  <%- include('partials/patient/file-tile', {
    file: { id: m.id, name: m.file_name || tt('Attachment', ...), kind: 'file', url: m.file_url || ('/files/' + m.id) },
    compact: true, isAr: __isAr
  }) %>
```

`file-tile.ejs:16` then resolves the link target:
```ejs
const __href = __f.url ? __f.url : (__f.id ? ('/files/' + __f.id) : '#');
```

So when `m.file_url` is set, the tile renders a link directly to that URL. **Today that's a public Uploadcare CDN URL (audit §6a privacy gap). Tomorrow (with C2) it could be an R2 key like `orders/draft/<patient>/foo.pdf` — which the browser would interpret as a relative URL and 404 on click.** This is the load-bearing display problem.

The fallback `/files/<m.id>` at line 593 is **broken today**: `/files/:id` (`src/server.js:469-525`) looks up `order_files.id`, NOT `messages.id`. A message UUID would 404. The fallback works only because every file-typed message has `m.file_url` set; the OR short-circuits.

**Doctor side — patient_order.ejs:7 doc + patient.js:2649-2677**: the patient's order-detail page reads BOTH `order_files` (via `/files/<id>` proxy — R2-aware) AND `order_additional_files` (via raw `file_url AS url` SELECT — direct hyperlink). Same display module (`file-tile.ejs`) handles both. So the merged "Files" tab today renders:
- order_files entries: clicking → `/files/<id>` → auth + signed R2 URL ✅
- order_additional_files entries: clicking → raw `file_url` (Uploadcare CDN URL today) ⚠️ public-addressable

**For the doctor side specifically (Q6 resolved 2026-05-14):** the doctor has **no UI surface** that displays `order_additional_files`. Verified by exhaustive grep across `src/views/`:
- `portal_doctor_case.ejs` (the doctor case detail) — zero matches for any `additional_files` / `additionalFiles` / `addFiles` / `additional-files` variant.
- `admin_order_detail.ejs` + `superadmin_order_detail.ejs` matches are all to `additionalFilesRequest` (singular `Request`) — the doctor's REQUEST for more files (admin approval queue), not the file display.
- `partials/doctor/bell.ejs` — single match is a notification-kind label string (`additional_files_requested_patient: 'Additional files requested'`), not a file display.
- `doctor.js` SELECT-on-`order_additional_files` callsites: only one (`:4397`) and it's a `SELECT 1 AS ok` existence check for SLA computation, not a display read.

**Net effect on Sub-issue C2.D:** doctor-side scope is **0 LOC**. Only the patient-side display change is needed. The "doctor never sees patient-attached message files" finding is a pre-existing UX gap, not a C2 regression — logged as side issue **#63** for follow-up.

**The `messages.ejs` view — not affected.** Confirmed via `grep -n 'file\|attach\|file_url' src/views/messages.ejs` returning zero matches. This view is used by the doctor's general messages list (`messaging.js:103, 188` render call sites) and is text-only.

### 2d. The /files/:id route (current behavior)

`src/server.js:469-525` — auth-gated unified file reader. Already dual-mode (Phase 1's load-bearing fact):
- Looks up `order_files` by `id` only
- If `url` starts with `^https?://` → 302 redirect direct (legacy Uploadcare path)
- Else → treat as R2 key → `getSignedDownloadUrl(key, 3600)` → 302 to signed URL

For C2, this route needs to ALSO resolve from `messages.file_key` and (per recommendation in §8 Q3) from `order_additional_files.file_key`. The cleanest path: extend the route to walk three lookup tables in order — `order_files`, then `messages` (file-typed), then `order_additional_files` — and apply the same dual-mode branch on the `url` / `key` field returned. Auth check changes per source (see §2e).

### 2e. Auth model today + tomorrow

**Today's situation is the worst of both worlds:**

- `/files/:id` (for `order_files`) auth-gates by role:
  - admin/superadmin: always allowed
  - patient: only if `order.patient_id === req.user.id`
  - doctor: only if assigned to the order AND `order.accepted_at !== null`
- `messages.file_url` (Uploadcare CDN URL): **publicly addressable** to anyone who knows the URL. No auth at the CDN. The `/portal/patient/orders/:id/messages` form CSRF-protects the WRITE but not the READ.
- `order_additional_files.file_url` (also Uploadcare CDN URL): same — public.

So the CSP, the route auth, and the doctor's "I can only see this case's files" guarantee are all illusory for files that originated as Uploadcare uploads. The R2 migration is also a real privacy improvement, not just a cost / dependency cleanup.

**Tomorrow's auth model (proposed, see §8 Q4):**

- For `messages.file_key`: allow access if requester is in `(order.patient_id, order.doctor_id, admin, superadmin)`. Doctors don't need the `accepted_at` gate the way they do for `order_files` because messages-attached files are by definition shared after assignment (the conversation can't exist before assignment — see the limbo guard at `patient_order.ejs:503`).
- For `order_additional_files.file_key`: same auth as `order_files` (patient + assigned doctor + admin). Shared model.

### 2f. Schemas (verified by query 2026-05-14)

| Table | Relevant columns | Type | Nullable | Indexes |
|---|---|---|---|---|
| `messages` | `id` | TEXT | NO | PK |
| | `conversation_id` | TEXT | NO | likely indexed (FK) |
| | `file_url` | TEXT | YES | none (verified — no index) |
| | `file_name` | TEXT | YES | none |
| | `message_type` | TEXT | YES | none |
| `order_additional_files` | `id` | TEXT | NO | PK |
| | `order_id` | TEXT | YES | likely indexed |
| | `file_url` | TEXT | YES | none |
| | `label` | TEXT | YES | (added later, schema-drift) |
| `conversations` | `id`, `order_id`, `patient_id`, `doctor_id`, `status` | TEXT | mixed | n/a for C2 |

**No FK constraints on `file_url` columns.** App-level guards only. C2 schema migration adds `file_key TEXT NULL` to both `messages` and `order_additional_files` — no constraint changes needed.

### 2g. Production data baseline (verified 2026-05-14)

```
PROD:
  messages.total                          = 0
  messages.with_file                      = 0
  messages.uploadcare                     = 0
  conversations.total                     = 0
  order_additional_files.total            = 0
  order_additional_files.uploadcare       = 0
```

**Nothing to migrate. Zero historical data risk.** This mirrors the Q6 finding for the wizard widget. The messages-attach feature exists, has UI surfaces in production, but has never been exercised end-to-end. C2's cutover is "feature works for first time" — same low-risk profile as Phase 2-4.

### 2h. AI image-quality validator scope

`src/ai_image_check.js#validateImageFromUrl` is called from `src/routes/api/cases.js:259+` (the case-create POST flow) and `src/routes/order_flow.js`. **Zero references in `patient.js` and zero references in `messaging.js`** — confirmed by grep. So message-attached files do **not** go through the AI quality check today, and C2 does **not** need to extend the AI worker (Sub-issue I bundled in Phase 4 covered the only AI-validator surface).

### 2i. Existing test coverage for messages-attach

**Zero tests** touch the messages-attach flow. Confirmed by `find tests -name '*messag*'` returning only `tests/lint/no-bare-foot-include.test.js` (false positive — substring match on "include"). The current widget has shipped without a regression backstop. C2.F adds the missing tests.

---

## 3. Root Cause

C2 was missed in Theme 13 v1 scoping for three concrete reasons, all surfaced during the Phase 3 read-through:

1. **Audit §3a "additional file uploads" was wrong about the surface.** The audit table at `UPLOAD_PROVIDER_AUDIT.md` §3a row 4 says "Patient additional file upload (after case open): patient.js path uses Uploadcare too (`uploadcareLocals` spread into render contexts)." That row described the spread of `uploadcareLocals` correctly but mis-located the actual upload widget. The widget IS in `patient_order.ejs` but it's the **messages-attach paperclip**, not a freestanding "add files to my order" form. The fix plan §4 Sub-issue C inherited the misread and described C as a 40-LOC client-side rewrite that "posts to the existing `order_flow.js` route."

2. **Phase 3 caught the mistake but only documented half of it.** During Phase 3 implementation, I read patient_order.ejs and recognized the form-action target was `/portal/patient/orders/<id>/messages` (not `/.../upload`), and the file-tile display used the value as a literal hyperlink. I documented this in the Phase 3 deviation report and added a Sub-issue C2 placeholder to the THEME_13 fix plan §4. **But I missed the `order_additional_files` mirror.** That mirror means a doctor never sees patient-attached files via the message thread (messages.ejs is text-only) — they see them via the order's "Documents" tab, which reads `order_additional_files`. So C2 has to touch BOTH tables for the cutover to keep the doctor's view functional.

3. **`order_additional_files` schema is older and inconsistent.** It has `file_url` (TEXT), `uploaded_at` (not `created_at`), and a defensive `hasColumn` check on `label` — clear schema drift from the canonical `order_files`. Existing readers at `patient.js:2662` and the doctor-side equivalent rewrote `file_url AS url` and pass it straight to file-tile, bypassing the `/files/:id` proxy that was added with the original R2 migration (the load-bearing dual-mode reader in `server.js:507-510`). This means the proxy-vs-direct split has been silent since the Phase-2 R2 migration; C2 is the trigger to fix it.

The pattern is the same as the original Theme 13 root cause — **partial migration that ran out of momentum.** The first R2 migration handled `order_files` (the canonical case-files table) but didn't extend to `order_additional_files` because nothing was breaking. Now that we're retiring Uploadcare for the wizard, we have to retire it for messages too, which forces us to fix the additional-files reader as well.

---

## 4. Fix Plan

### Sub-issue C2.A — Schema migration (`messages.file_key` + `order_additional_files.file_key`)

**Goal:** Add a parallel `file_key TEXT NULL` column to both tables. Keep existing `file_url` column for backward compat (zero prod rows means the column could theoretically be dropped, but keeping it is cheaper than coordinating cross-deploy schema changes).

**Why a separate column, not repurposing `file_url`:** §8 Q5 — separate column means readers can disambiguate by which column is non-null. No regex on the column value, no implicit "scheme inference." Code reads cleaner and the dual-mode invariant is structurally enforceable in app-level guards.

**Migration file:** `src/migrations/055_messages_file_key.sql`

```sql
-- Migration 055: messages.file_key + order_additional_files.file_key
-- Theme 13 Sub-issue C2 — R2-direct messages-attach migration.
--
-- Adds nullable file_key column to both tables. Existing file_url column
-- is preserved for backward compat (currently 0 rows in prod, but the
-- migration is forward-compat-safe regardless).
--
-- Idempotent via IF NOT EXISTS. Safe to re-run.

BEGIN;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS file_key TEXT;

ALTER TABLE order_additional_files
  ADD COLUMN IF NOT EXISTS file_key TEXT;

-- App-level guard enforces exactly-one-of (file_url, file_key) per row.
-- No CHECK constraint here because that would block the rare edge case
-- where a backfill script needs to write both before the swap.

COMMIT;
```

**Sub-issue C2.A files affected:** 1 new migration file, ~25 LOC.

### Sub-issue C2.B — Server endpoint (reuse Sub-issue A)

**Goal:** The mobile/portal client posts a multipart file and gets back an R2 key. **No new endpoint** — reuse `POST /portal/patient/files` (the Sub-issue A endpoint at `src/routes/patient_files.js`). Add an optional `folder` form field that, when set to `messages`, routes the upload into `messages-attach/<patient-id>/<uuid>.<ext>` instead of the default `orders/draft/<patient-id>/<uuid>.<ext>`.

**Why reuse over a new endpoint:**
- Same auth model (cookie session + CSRF + requirePatient)
- Same multer middleware + R2 client + 50MB cap + MIME allowlist
- Same rate limiter (30/15min/user)
- The folder param is the smallest possible change (~10 LOC)
- One endpoint to monitor in `error_logs` post-cutover

**Why a folder param vs the same `orders/draft/` path:**
- R2 lifecycle rules can be scoped by prefix. `orders/draft/` gets the 7-day expiry (Q5 in original §8). `messages-attach/` shouldn't expire — once a patient sends a message, the file should persist for the conversation's lifetime. Different prefix = different lifecycle.
- Telemetry: easy to filter by folder in `error_logs` `context` field.

**Validation:** the folder param is allowlisted to a finite enum (`'orders/draft'` | `'messages-attach'`). Anything else 400s. The endpoint hardcodes the patient-id segment to `req.user.id` so the client can't path-traverse.

**Sub-issue C2.B files affected:** `src/routes/patient_files.js` (add ~15 LOC for folder validation + path construction), no new file.

### Sub-issue C2.C — Widget rewrite (`patient_order.ejs:645-693`)

**Goal:** Same shape as Sub-issue B (Phase 2 — wizard view rewrite). Branch on `__r2DirectEnabled && __messagesR2Enabled` (see §8 Q3 for the flag combination). When true, render the new FormData script that POSTs to `/portal/patient/files` with `folder=messages-attach`. When false, render the existing Uploadcare 3.x widget block (preserved byte-identical for rollback).

The new script populates `msg-file-key` (a NEW hidden input added next to `msg-file-url`) instead of `msg-file-url`, just like the wizard's Phase 2 dual-input pattern. The form posts both fields; server handler reads both.

**EJS edits:**
- Add `__messagesR2Enabled` typeof-guarded local at `:472` area (mirrors `__r2DirectEnabled`)
- Add `<input type="hidden" name="file_key" id="msg-file-key" />` next to `:615` `msg-file-url`
- Replace `:645-693` with `<% if (__r2DirectEnabled && __messagesR2Enabled) { %> [new] <% } else { %> [legacy] <% } %>`

**Why both flags AND-gated, not OR:** Belt-and-suspenders. Flipping `MESSAGES_R2_ENABLED=true` without first having `UPLOAD_R2_DIRECT_ENABLED=true` would be a misconfiguration (the wizard would still be on Uploadcare but messages-attach would be on R2 — inconsistent). AND-gating prevents that operator footgun.

**Sub-issue C2.C files affected:** `src/views/patient_order.ejs` (~80 LOC — new branch with FormData fetch script, mirror Phase 2 structure including duplicated polling block for byte-identical rollback). `src/routes/patient.js` (~5 LOC — add `messagesR2Enabled` to `uploadcareLocals` factory).

### Sub-issue C2.D — Display disambiguation

**Goal:** `file-tile.ejs:16` and the calling code at `patient_order.ejs:591-595` route through `/files/:id` whenever the file is sourced from a system table, regardless of column shape. **Always proxy. No raw `file_url` hyperlinks.**

**The change at the EJS callsite (`patient_order.ejs:591-595`):**
```ejs
<%# Before %>
url: m.file_url || ('/files/' + m.id)

<%# After %>
url: '/files/' + m.id   <%# Always go through the proxy. /files/:id resolves to whatever URL/key is stored. %>
```

**The change at file-tile.ejs (none — already supports the new shape):** `file-tile.ejs:16` already says `__f.url ? __f.url : ('/files/' + __f.id)`. Once the caller always passes `url: '/files/<id>'`, the OR short-circuits to that path. **Zero file-tile.ejs changes needed.**

**The change at patient.js:2662-2670 (additional files reader):**
```sql
-- Before
SELECT id, file_url AS url, ... FROM order_additional_files WHERE order_id = $1

-- After
SELECT id, ... FROM order_additional_files WHERE order_id = $1
-- Then in JS:
additionalFiles.forEach(f => { f.url = '/files/' + f.id; });
```

**Doctor-side equivalent (Q6 resolved): NONE NEEDED.** The doctor never displays `order_additional_files` (verified by exhaustive grep — see §2c). `doctor.js`'s `getAdditionalFilesUrlColumnName()` helper at `:4118` and existence check at `:4397` are SLA-computation infrastructure, not display reads. Logged as side issue #63 for the missing doctor-side display surface (pre-existing gap, out of C2 scope).

**Sub-issue C2.D files affected:** `src/views/patient_order.ejs` (1 line: drop the OR fallback). `src/routes/patient.js` (~5 LOC: rewrite the additional-files reader to use `/files/<id>`). **No `doctor.js` change.**

### Sub-issue C2.E — Auth-checked resolver (extend `/files/:id`)

**Goal:** `/files/:id` (currently looks up `order_files.id` only) walks three tables in order — `order_files`, `messages`, `order_additional_files` — and applies the dual-mode (`file_url` HTTP / `file_key` R2 key) reader to whichever table matched.

**Lookup order rationale:**
- `order_files` first: the canonical table, the highest-traffic surface, optimized for fast lookup
- `messages` second: per-conversation file-typed messages
- `order_additional_files` third: the post-doctor-request re-uploads + the messages-attach mirror

**Auth model per source (the `allowed` branch in `server.js:485-498`):**
- order_files: existing model (admin/superadmin always; patient if owner; doctor if assigned + accepted)
- messages: same as conversations — admin/superadmin always; patient or doctor if member of the conversation containing the message. Look up `conversations` row via `messages.conversation_id` to verify membership.
- order_additional_files: same as `order_files` — patient if owner, doctor if assigned + accepted.

**The dual-mode branch:** for whichever table matched, read both `file_url` and `file_key`. Apply:
- If `file_url` is set → 302 redirect direct (legacy Uploadcare path)
- Else if `file_key` is set → `getSignedDownloadUrl(file_key, 3600)` → 302 to signed URL
- Else → 404

**Sub-issue C2.E files affected:** `src/server.js` (the `/files/:id` route handler at `:469-525` grows by ~50 LOC to walk three tables + the messages auth check). No new route file.

**Performance note:** three sequential lookups means three round-trips on every file fetch. For low-traffic surfaces this is fine. If we observe latency, optimization options: (a) UNION ALL across the three tables in one query; (b) cache the lookup result; (c) prefix the `id` to indicate source. **Not in C2 scope** — measure first.

### Sub-issue C2.F — Server handler update (`patient.js:3094-3181`)

**Goal:** Accept `file_key` alongside `file_url`. Validate exactly-one-of-two. Mirror to `order_additional_files` correctly for both shapes (the current `^https?://` guard at `:3145` would silently drop R2 keys — fix it).

**The destructure change:**
```javascript
// Before
const fileUrl = String(body.file_url || '').trim();

// After
const fileUrl = String(body.file_url || '').trim();
const fileKey = String(body.file_key || '').trim();

// Theme 13 Sub-issue C2.F — exactly-one-of-two guard.
if (fileUrl && fileKey) return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=invalid_file`);
```

**The mirror change:**
```javascript
// Before — only mirrors http(s) URLs
if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
  await insertAdditionalFile(orderId, fileUrl, fileName || null, nowIso);
}

// After — mirrors both shapes; insertAdditionalFile gets a new variant
if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
  await insertAdditionalFile(orderId, fileUrl, fileName || null, nowIso, /*key=*/null);
} else if (fileKey && /^messages-attach\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(fileKey)) {
  await insertAdditionalFile(orderId, /*url=*/null, fileName || null, nowIso, /*key=*/fileKey);
}
```

**The INSERT change:**
```javascript
INSERT INTO messages
  (id, conversation_id, sender_id, sender_role, content, message_type, file_url, file_key, file_name, created_at)
VALUES ($1, $2, $3, 'patient', $4, $5, $6, $7, $8, $9)
```

(adds `file_key` column to the column list and `$7` to the values, shifts subsequent params)

**The `insertAdditionalFile` helper** at `patient.js:868-906` needs a new `key` parameter. Today it always writes to `file_url`; tomorrow it writes to whichever of `file_url` / `file_key` is non-null. Schema-drift fallback at `:885` (the `addHasLabel` check) extends to also check `file_key` column existence post-migration — defensive and idempotent.

**Sub-issue C2.F files affected:** `src/routes/patient.js` (~30 LOC across the messages handler + insertAdditionalFile helper).

### Sub-issue C2.G — Regression tests

**Goal:** Six new test files matching the Phase 5 auth-helper pattern (`tests/helpers/test-auth.js` shipped). Lock in the C2 invariants so a future refactor doesn't break the dual-format display.

| Test file | Asserts |
|---|---|
| `theme13-c2-handler-accepts-both-shapes.test.js` | POST messages with `file_key` succeeds; POST with `file_url` succeeds; POST with both 4xxs |
| `theme13-c2-handler-mirrors-both-shapes.test.js` | After POST with `file_key`, query `order_additional_files` row has `file_key` set, `file_url` NULL. Mirror works for both. |
| `theme13-c2-files-route-resolves-messages.test.js` | Seed messages row with `file_key`. GET `/files/<message-id>` → 302 to signed R2 URL. |
| `theme13-c2-files-route-resolves-additional.test.js` | Seed order_additional_files row with `file_key`. GET `/files/<additional-id>` → 302 to signed R2 URL. |
| `theme13-c2-widget-coexistence.test.js` | Pure-grep: both legacy Uploadcare branch and new FormData branch present in patient_order.ejs (rollback safety). |
| `theme13-c2-display-uses-proxy.test.js` | Pure-grep: patient_order.ejs message rendering uses `'/files/' + m.id` (not `m.file_url || /files/`). |

**Sub-issue C2.G files affected:** 6 new test files in `tests/core/`. Reuses `tests/helpers/test-auth.js` from Phase 5.

### Sub-issue summary

| # | Sub-issue | Lines (est.) | Files | Risk |
|---|---|---|---|---|
| C2.A | Schema migration (file_key column on 2 tables, single migration) | ~25 | 1 (new) | Low — additive only, IF NOT EXISTS |
| C2.B | Endpoint reuse (folder param on Sub-issue A endpoint) | ~15 | 1 (modified) | Low |
| C2.C | Widget rewrite + locals propagation | ~85 | 2 (modified) | Medium — patient-facing UI |
| C2.D | Display disambiguation, **patient-side only** (Q6: doctor has no display) | **~6** | **2 (modified)** | Low |
| C2.E | Resolver extension (3-table lookup) | ~50 | 1 (modified) | Medium — touches the load-bearing reader |
| C2.F | Handler dual-shape accept + mirror fix | ~30 | 1 (modified) | Medium — payment-blocking-adjacent |
| C2.G | Regression tests (8 assertions, 6 files) | ~250 | 6 (new) | None |

**Revised C2 total:** ~461 LOC added/changed (including tests), 0 LOC removed. **6 files modified** (was 7), **7 new files** (1 migration + 6 tests). The Q6 resolution dropped the `doctor.js` change and shrunk C2.D by ~6 LOC and one file.

---

## 5. Verification Steps

### 5a. Pre-deploy (local, after dev-DB fix from Phase 5 #61)

1. `npm test -- --grep theme13-c2` — all 6 new tests pass.
2. Boot server with `MESSAGES_R2_ENABLED=true` (and `UPLOAD_R2_DIRECT_ENABLED=true` per the AND-gate). Verify migration 055 ran cleanly. Verify `[R2] Connected to ...` boot log.
3. Open `/portal/patient/orders/<id>` for an existing test order in a browser. Compose a message + attach a file via the paperclip. Verify:
   - The new FormData widget renders (no `ucarecdn.com` script tag in DOM)
   - Upload succeeds; `msg-file-key.value` is populated with an `messages-attach/...` key
   - Submit posts the form; redirect lands on the order page
   - The new message appears in the thread with the file tile
   - Clicking the tile navigates to `/files/<message-id>` → 302 → signed R2 URL
   - The "Documents" tab also shows the file (mirror to `order_additional_files` worked)
4. Boot with `MESSAGES_R2_ENABLED=false` — verify the legacy Uploadcare widget renders unchanged.

### 5b. Pre-cutover (staging / production with flag off)

1. Deploy with `MESSAGES_R2_ENABLED=false`. Verify zero behavior change vs prior version. (Wizard cutover stays gated on its own flag.)
2. Smoke-test the legacy messages-attach widget path against a TestFlight account.
3. Confirm `error_logs` shows no new C2-related rows (no traffic to the new path).

### 5c. Cutover (production, flag flip)

1. Set `MESSAGES_R2_ENABLED=true` in Render. Restart.
2. Within 5 minutes: send a real test message-with-attachment via the paperclip. Verify the file persists, displays for the patient, and appears in the doctor view's Documents tab.
3. Within 1 hour: query `SELECT COUNT(*) FROM messages WHERE file_key IS NOT NULL` — should be ≥1 (the test message).
4. Within 24 hours: monitor `error_logs` for `category='patient_upload'` rows with the messages folder in context. Should be zero.

### 5d. Cleanup phase (Phase 7 — E + F + G)

After both `UPLOAD_R2_DIRECT_ENABLED=true` AND `MESSAGES_R2_ENABLED=true` are stable for ≥14 days:
1. Drop `'unsafe-eval'` + `ucarecdn.com` from CSP (Sub-issue E).
2. Drop `UPLOADCARE_PUBLIC_KEY` + `UPLOADCARE_SECRET_KEY` env vars (Sub-issue F).
3. Drop the i18n strings about Uploadcare configuration (Sub-issue G).
4. Drop the legacy Uploadcare widget code blocks from both EJS files (Sub-issues B+C cleanup).

---

## 6. Test Coverage Required

(Test list moved here from §4 C2.G for cohesion.)

**C2.G Phase 1 (lands with C2.A through C2.F):**

- C2.T1: Handler accepts `file_key` (returns 302 redirect, no error)
- C2.T2: Handler accepts `file_url` (legacy path still works)
- C2.T3: Handler rejects both-set with 4xx + redirect to `?err=invalid_file`
- C2.T4: Mirror to `order_additional_files` works for both shapes
- C2.T5: `/files/<message-id>` resolves messages.file_key (302 to signed R2 URL)
- C2.T6: `/files/<additional-id>` resolves order_additional_files.file_key (302 to signed R2 URL)
- C2.T7: Widget coexistence (both legacy + new branches present)
- C2.T8: Display uses `/files/<id>` proxy (no raw file_url hyperlink)

**Total:** 8 assertions across 6 files.

**Manual UAT (not automated):**

- Send a message with a real DICOM file via the new widget
- Send a message with a 50 MB PDF (boundary)
- Send a text-only message (no file) — verify it still works
- Doctor view: verify they see the patient's message-attached file in the Documents tab
- Cancel an upload mid-progress — verify the orphaned R2 object exists in `messages-attach/` and gets cleaned up by the lifecycle rule (per §8 Q5 confirmation needed)

---

## 7. Rollback Plan

Three layers, same shape as the original Theme 13 §7.

### 7a. Layer 1 — Feature flag flip (zero deploy, ~30 sec)

`MESSAGES_R2_ENABLED=false` in Render → restart → patient_order.ejs renders the legacy Uploadcare widget. The `MESSAGES_R2_ENABLED=false && UPLOAD_R2_DIRECT_ENABLED=true` state is **valid** — wizard on R2, messages-attach on Uploadcare. The handler stays dual-mode-accept (legacy file_url path always works), so any in-flight messages submitted with R2 keys would still post correctly, but new uploads route through the legacy path.

**Triggers (within 24h of cutover):**
- `error_logs` rows with `context LIKE 'patient.messages_%' AND category='patient_upload'` count > 5/hour
- A user-reported "I can't attach a file" complaint
- File-tile rendering broken in browser (visual regression)

**Recovery time:** ~30 seconds (Render env-var restart).

### 7b. Layer 2 — Both flags off

If Layer 1 doesn't help (e.g., a bug in the new handler dual-mode branch breaks even the legacy path), flip BOTH `MESSAGES_R2_ENABLED=false` AND `UPLOAD_R2_DIRECT_ENABLED=false`. Wizard reverts to Uploadcare, messages-attach reverts to Uploadcare. **Full pre-Theme-13 state.**

**Triggers:** any C2-related issue that isn't isolated to messages-attach (handler-level regression, schema migration failure, /files/:id route bug).

### 7c. Layer 3 — Code revert

`git revert <C2 commit range>` and re-deploy. Resets to pre-C2 state. The schema migration's `ADD COLUMN IF NOT EXISTS` is forward-compat-safe — leaving the column in place after revert is harmless (no readers will reference it).

**Recovery time:** ~10–15 minutes (CI build + deploy).

### 7d. Cutover criteria (when to remove the legacy code path)

Sub-issues E + F + G (the Uploadcare-removal cleanup) only ship when **all** of:
1. `MESSAGES_R2_ENABLED=true` has been live for ≥14 days
2. `error_logs` `category='patient_upload'` rows < 1/day for the last 7 days
3. New-message-with-file rate is positive (proves the feature is being used) — OR Ziad explicitly confirms low-volume is expected
4. Both wizard cutover AND messages-attach cutover are proven stable
5. Ziad explicit go-ahead

### 7e. Worst-case scenario walkthrough

**Scenario:** C2 cuts over Day 0. Day 1, a doctor reports they can't see patient-attached files in the Documents tab.

**Diagnosis path:**
- Check whether `order_additional_files.file_key` is populated for affected rows. If yes, the issue is in the doctor-side display rewrite (Sub-issue C2.D).
- Check whether `/files/<additional-id>` returns 200/302 vs 404. If 404, the resolver extension (Sub-issue C2.E) is missing the `order_additional_files` lookup branch.

**Response:**
- T+0: ops verifies via `error_logs` and direct DB query.
- T+10: revert C2.D / C2.E commits or flip MESSAGES_R2_ENABLED off (whichever is faster).
- Patient-attached files still exist in R2 (not lost); access just fails at the resolver. Once fix lands, files become accessible again.

**No data loss possible.** R2 retains the bytes; the layer at risk is the resolver routing.

### 7f. Rollback explicitly does NOT cover

- A bug in the existing wizard upload (`patient_files.js` from Sub-issue A) — different surface
- A bug in `/api/v1/files` (Sub-issue D) — different surface
- A bug in the unified `/files/:id` reader's existing `order_files` branch — pre-existing, not introduced by C2 (though C2 extends the route)

---

## 8. Open Questions for Ziad

Six decisions need sign-off before C2 implementation begins. Each has a recommended answer with rationale.

### Q1 — Endpoint strategy: reuse Sub-issue A or new endpoint?

**Question:** New `POST /portal/patient/messages/files` endpoint OR reuse `POST /portal/patient/files` (Sub-issue A) with an optional `folder` form field?

**Recommendation:** **Reuse with folder param.** One endpoint to monitor, one auth path, one rate limit. The folder param is a 15-LOC addition. New endpoint would be ~80 LOC of mostly-duplicate code with the same multer/R2/auth wiring.

**Cost of being wrong:** if a future requirement makes per-surface rate limits or per-surface auth diverge, we'd refactor to two endpoints. Cheap to undo.

### Q2 — Resolver strategy: extend `/files/:id` or new `/portal/patient/messages/files/:id`?

**Question:** Walk three tables (`order_files`, `messages`, `order_additional_files`) inside the existing `/files/:id` handler OR build a separate `/portal/patient/messages/files/:id` resolver?

**Recommendation:** **Extend `/files/:id`.** The route is already the unified file reader for the entire portal + mobile API + email link rewrites. Forcing message-attached files through a different URL would break (a) the existing `file-tile.ejs` partial which calls `/files/<id>`, (b) the email templates that link to attachments, (c) any client that has cached the URL pattern. The 50-LOC extension is contained — three sequential lookups + a per-source auth check — and stays in one file (`server.js:469-525`).

**Cost of being wrong:** if the three-lookup query becomes a latency bottleneck, optimize to a UNION query or a source-prefixed ID scheme. Not a structural concern at zero-prod-data baseline.

### Q3 — Feature flag: piggyback on `UPLOAD_R2_DIRECT_ENABLED` or new `MESSAGES_R2_ENABLED`?

**Question:** Reuse the wizard's flag OR add a parallel `MESSAGES_R2_ENABLED` for independent rollback?

**Recommendation:** **New `MESSAGES_R2_ENABLED`, AND-gated with `UPLOAD_R2_DIRECT_ENABLED`** (i.e., `messagesUseR2 = R2 && MESSAGES_R2`).

- AND-gate prevents the misconfiguration "messages on R2, wizard on Uploadcare" — would split the user experience inconsistently.
- New flag means messages-attach can be rolled back without rolling back the wizard cutover (and vice versa).
- Two flags means two cutover decisions, but they're orthogonal and both small.

**Cost of being wrong:** if we never need the granular rollback, the second flag is dead config. ~30 LOC of validation + UI render gates. Cheap.

### Q4 — Auth model for `messages.file_key` and `order_additional_files.file_key`

**Question:** Who can read message-attached and additional-uploaded files via `/files/:id`?

**Recommendation:**
- `messages.file_key`: admin/superadmin always; patient or doctor if member of the conversation containing the message (look up `conversations` row via `messages.conversation_id`)
- `order_additional_files.file_key`: same as today's `order_files` model (admin/superadmin always; patient if owner; doctor if assigned + accepted)

Both close the current privacy gap (Uploadcare CDN URLs are publicly addressable today — anyone with the URL can fetch). The new R2 path goes through `/files/:id` auth + signed URL with 1h expiry.

**Sub-question:** Should the doctor's `accepted_at` gate apply to `messages.file_key` too? My reading: **no** — messages-attached files are exchanged after assignment by definition, so the gate would never reject a legitimate doctor; including it just adds a redundant check.

### Q5 — Display disambiguation: regex in file-tile.ejs OR always proxy through `/files/:id`?

**Question:** Detect R2 keys in `file-tile.ejs` (regex on the URL value) OR always route through `/files/:id` regardless of source?

**Recommendation:** **Always proxy.** Cleaner, future-proof, no regex maintenance burden. The `file-tile.ejs:16` already supports both modes; we just stop passing raw `file_url` from `patient_order.ejs:593`. The change is one line at the caller.

**Cost of being wrong:** the proxy adds a 302 redirect step for every file fetch. Imperceptible UX cost. Not even a bandwidth cost — just one extra request that returns a Location header.

### Q6 — Doctor-side display path for `order_additional_files` (RESOLVED 2026-05-14)

**Resolution: option (b) — doctors don't view additional files in any UI today.** Verified by exhaustive grep across `src/views/`, `src/routes/doctor.js`, and `src/routes/admin.js` / `src/routes/superadmin.js`:

- `portal_doctor_case.ejs` — zero matches for any `additional_files` / `additionalFiles` / `addFiles` / `additional-files` variant.
- `admin_order_detail.ejs` + `superadmin_order_detail.ejs` matches are all to `additionalFilesRequest` (singular `Request`) — the doctor's REQUEST for more files (admin approval queue), distinct from the file display.
- `partials/doctor/bell.ejs` match is a notification-kind label string only.
- `doctor.js` only references `order_additional_files` for SLA computation (`:4397` existence check) and a column-name helper (`:4118`) — neither is a display read.

**Net effect on C2:** Sub-issue C2.D drops the `doctor.js` change entirely. **0 LOC** on the doctor side. Only the patient-side display change at `patient_order.ejs:593` + the patient-side reader rewrite at `patient.js:2662-2670` remain.

**Side effect — pre-existing UX gap surfaced:** the doctor has **no UI surface** for viewing patient-attached message files at all. The mirror to `order_additional_files` is written by `patient.js:3147` but never read in any doctor view. Today this is masked because production has 0 messages and 0 order_additional_files (per §2g). It would surface the moment a patient actually attaches a file to a message — the doctor would receive a notification ("Patient sent a message") but couldn't see the attached file in any portal page. Logged as **side issue #63** (P3 follow-up; not in C2 scope).

### Q7 — `order_additional_files.file_key` schema migration scope

**Question:** Does the migration ship in the same commit as `messages.file_key` (single migration 055), or split into two migrations (055 messages, 056 additional)?

**Recommendation:** **Single migration 055.** Both columns are additive, idempotent (`IF NOT EXISTS`), and mutually independent. Splitting adds churn without rollback benefit (rollback = drop both columns; same complexity either way). One migration, one deploy.

**Cost of being wrong:** if a future scenario needs to roll back one without the other, the column drop is a 1-line ad-hoc DDL. Cheap.

---

## §8 surfacing summary

The six questions ranked by what blocks Step 3 implementation:

| Q | Status | Locked answer |
|---|---|---|
| Q1 (endpoint reuse) | ✅ resolved | Reuse `POST /portal/patient/files` with allowlist-validated `folder` param |
| Q2 (resolver strategy) | ✅ resolved | Extend `/files/:id` to walk 3 tables |
| Q3 (feature flag) | ✅ resolved | New `MESSAGES_R2_ENABLED`, AND-gated with `UPLOAD_R2_DIRECT_ENABLED` |
| Q4 (auth model) | ✅ resolved | `messages.file_key`: admin/superadmin + conversation members; `order_additional_files.file_key`: patient owner + assigned doctor + admin |
| Q5 (display strategy) | ✅ resolved | Always proxy through `/files/<id>`, drop OR fallback |
| Q6 (doctor-side display) | ✅ resolved (2026-05-14) | **Doctor has no display surface** — verified by grep. C2.D doctor-side scope = 0 LOC. Pre-existing UX gap logged as side issue #63. |
| Q7 (migration split) | ✅ resolved | Single migration 055 adding both columns |

**All §8 questions resolved. C2 implementation is unblocked.** Phase 6 starts with C2.A (schema migration).
