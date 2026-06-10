# TODO — known issues not yet fixed

Items discovered during in-flight work that were out of scope for the commit that surfaced them. Each entry names the exact code sites. Delete an entry only when it ships a fix.

---

## \[RESOLVED 2026-04-30\] Migrate Gmail SMTP → real transactional provider (Resend)

**Resolution (2026-04-30):** `src/services/emailService.js` swapped from Nodemailer + Gmail SMTP (smtp.gmail.com:587) to the Resend HTTP API via the official `resend` SDK. Gmail's 500-emails/day cap and SPF/DKIM/DMARC posture made it unsuitable for transactional patient email at launch scale ("your second opinion is ready" landing in spam was a non-starter for a medical platform).

The Resend SDK is wrapped in a thin nodemailer-shaped adapter so `recipientGuard` (`wrapWithGuard` / `_guardedSendMail`) keeps the same contract; every public surface (`sendEmail`, `sendRawEmail`, low-level `sendMail`, all `notify*` lifecycle wrappers) and every caller across the codebase keeps its existing signature and return shape. Test injection seam (`_setTestTransporter`) preserved. Templates (Handlebars `welcome.hbs`, `password-reset.hbs` en+ar, etc.) are unchanged — Resend accepts pre-rendered HTML in its `html` field.

Config switch: `RESEND_API_KEY` replaces `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE`. Kept: `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME` (renaming would also touch `static-pages.js`'s contact-form recipient default, out of scope). `EMAIL_ENABLED` master kill switch unchanged. Updated: `scripts/notification-health.js`, `scripts/test-email.js`, `tests/notifications/emailService.guard.test.js`. Domain `tashkheesa.com` is verified in Resend with DKIM via Cloudflare DNS auto-config; from-address remains `noreply@tashkheesa.com`.

---

## \[RESOLVED 2026-04-30\] Forgot-password silent failure — POST /forgot-password never sent email

**Resolution (2026-04-30):** Portal POST handler at `src/routes/auth.js:275-305` generated the reset token and built the URL but never called any email-sending function. In production the URL was discarded (the dev `console.log('[RESET LINK]', ...)` is gated on `!IS_PROD`). Fix: added `password-reset` Handlebars templates in `src/templates/email/{en,ar}/password-reset.hbs` and wired a fire-and-forget `sendEmail()` call. Email goes through the recipientGuard-wrapped transporter. Original FLAG: `docs/audits/full-audit-april-2026.md` § "Forgot-password flow silently broken".

---

## \[RESOLVED 2026-04-30\] Mobile API forgot-password uses different storage and a sendEmail stub

**Resolution (2026-04-30):** `src/routes/api/auth.js` POST `/forgot-password` now writes tokens to `password_reset_tokens` (same table as the portal route — tokens are interchangeable) and calls the real `emailService.sendEmail` directly with `template: 'password-reset'`. TTL aligned to 2h to match `RESET_EXPIRY_HOURS` in `src/routes/auth.js`. The `sendEmailStub` and the `sendEmail` injection in `server.js:711-722` were removed; the `sendEmail` parameter was dropped from `api/auth.js`'s helpers destructure since no other api/* route uses it. Reset link points to the portal (`APP_URL/reset-password/:token?lang=…`), which already consumes `password_reset_tokens`. recipientGuard wrapping is preserved automatically via `emailService.getTransporter()`. Commit: `fe52cb7`.

---

## \[Stranded, discovered 2026-04-30\] Mobile API reset-password endpoint reads orphan storage

**Site:** `src/routes/api/auth.js:300-326` (POST `/api/v1/auth/reset-password`).

**State:** Queries `users.reset_token` + `users.reset_token_expires` (lines 312, 321). After the 2026-04-30 forgot-password fix above, no row ever gets written to those columns again — every new reset token now lands in `password_reset_tokens`. So this endpoint will return `INVALID_RESET_TOKEN` for every legitimate token.

**Why this isn't urgent:**
- The mobile app's normal reset flow today is to open the email link, which goes to the portal's `/reset-password/:token` page. That path works.
- A native in-app reset screen (if/when the mobile app ships one) would hit this endpoint and break — but I have no evidence the mobile app currently calls it.

**Recommended fix when picked up:**
- Migrate the SELECT and the post-reset UPDATE to `password_reset_tokens` — mirror the portal logic in `src/routes/auth.js:453-519` (validate via `findValidToken`, mark `used_at`, update `users.password_hash`).
- Delete the now-orphan `users.reset_token` and `users.reset_token_expires` columns (added in `src/migrate_mobile_api.js:26-27`) once verified unused. Migration #033 is next available.
- Once both endpoints share `password_reset_tokens`, the portal and mobile flows are fully unified.

Out of scope for this commit — explicitly held back per "don't refactor surrounding code" in the brief.

---

## \[RESOLVED 2026-04-30\] payments.js writes to non-existent `orders.paid_at` column

**Resolution (2026-04-30):** Migration `032_orders_paid_at.sql` adds the column and backfills historical rows. Verified live on Supabase. The 3 historical "paid" orders that surfaced during the fix turned out to be parity-fixture pollution from `scripts/verify_addon_parity.js` running against production by mistake; all fixture rows (orders, users, doctor_earnings, appointments) were cleaned up. Original entry retained below for historical context.

**Discovered:** 2026-04-24, during Phase 3 synthetic webhook replay (`scripts/replay_paymob_webhook.js`). Every scenario caused the payment callback to return HTTP 500 with `column "paid_at" does not exist`.

The callback handler at `src/routes/payments.js:101-107` writes:

```sql
UPDATE orders
   SET payment_status = 'paid',
       paid_at = COALESCE(paid_at, $1),       -- ← column does not exist
       uploads_locked = true,
       payment_method = COALESCE(payment_method, $2, 'gateway'),
       payment_reference = COALESCE(payment_reference, $3),
       updated_at = $4
 WHERE id = $5 AND (payment_status IS NULL OR payment_status != 'paid')
```

Live `orders` schema has `payment_id`, `payment_link`, `payment_method`, `payment_reference`, `payment_status` — but **no** `paid_at`. The SQL fails at parse time → UPDATE throws → the error handler renders the 500 page → Paymob retries → still 500 forever.

This means **every Paymob payment webhook is currently broken in production.** It hasn't fired because real traffic is effectively zero. The moment a live payment lands, the callback will 500, the order will stay at `payment_status = 'unpaid'` despite the patient being charged, and we'll get a support ticket.

**Fix options:**

1. **Add** `paid_at TIMESTAMPTZ` **to orders.** New migration, back-fill from `updated_at` where `payment_status='paid'` (probably zero rows). This is what the code expects. Simplest path.
2. **Drop** `paid_at` **from the UPDATE statement.** Use `updated_at`alone for the "when did payment happen" timestamp. Code-only fix, no schema change, but loses the semantic distinction.

Recommend (1). Ship as a one-commit fix with its own migration BEFORE Phase 3 dual-write wiring — Phase 3 cannot be meaningfully verified while the V1 callback is broken.

**This is outside the add-on abstraction scope. I did not fix it in my session; flagging for your decision on who should own the fix and when it should land.**

---

## \[Phase 6\] Migrate urgency surcharge to first-class addon

**Captured:** 2026-04-24, during Phase 3 prep review. **Unblocks:** after Phase 5 (prescription feature) stabilises.

Urgency surcharge is currently **baked into the** `services` **pricing model** — the case's total price already includes the urgency premium, and the doctor's commission flows out of the same case-level split. Under the corrected commission policy, the urgency surcharge is **Tashkheesa 75% / Doctor 25%**, which differs from both the main case split (80/20) and the add-on split (20/80). Two different splits on a single order cannot be represented cleanly while urgency lives inside the flat `services.price` field.

Phase 6 migration scope (deferred — do NOT start until prescription ships and production is stable):

- Schema: separate `orders.base_price` from `orders.urgency_surcharge`. Back-compat view or trigger to keep `orders.price` derivable.
- New addons: `Urgency24hAddon` and `UrgencySameDayAddon`, both extending `AddonService`, commission splits per §0 of the design doc (85/15 for 24h rush, 70/30 for same-day / 6h), `has_lifecycle = false` — urgency has no separate doctor-side step, it modifies the main-case SLA deadline instead.
- Migration 0XX to seed the two urgency rows into `addon_services`and backfill `order_addons` for any order with an urgency tier.
- Checkout flow rework: Patient's case-submission flow currently bakes urgency into the service price; refactor so it's selected as an addon alongside prescription and video.
- Extend `scripts/verify_addon_parity.js` with urgency-specific comparisons: old (`orders.urgency_flag` + urgency_tier + implicit price uplift) vs new (`order_addons` rows with `addon_service_id IN ('urgency_24h', 'urgency_same_day')`).
- Doctor earnings: ensure each urgency tier's split (15% / 30%) writes an `addon_earnings` row per urgent order. Reconcile against historical `doctor_fee` values to confirm no drift.
- `orders.sla_hours` + `case_sla_worker.js`: both remain — the `case_sla_worker` reads `orders.sla_hours` regardless of whether urgency is expressed as a main-service field or an addon. Nothing to migrate on the worker side.

**Why deferred:** urgency touches every case, not just add-on cases, and the price-model split is a larger migration than prescription + video combined. Ship the current two-addon abstraction and the prescription feature first, then tackle urgency with the abstraction already battle-tested.

---

## \[RESOLVES IN PHASE 2\] Video-consult commission: wrong migration default

**Discovered:** 2026-04-24, during add-on abstraction recon (Group 3.1). **Reframed:** 2026-04-24, after commission-model clarification — see `docs/architecture/addon_service_abstraction.md` §0 and §6. **Fix lands:** in Phase 2 of the addon refactor (migration 019).

Under the two-tier commission model (main services 80/20 platform/doctor, add-ons 20/80 platform/doctor), video consult is an add-on and therefore pays the doctor **80%**. The `80` fallback in `video.js` was correct all along; the bug is the `70` column default.

SourceValueFile:lineCorrect?`services.video_doctor_commission_pct` column default70`src/migrations/002_column_additions.sql:50`❌ should be 80`services.doctor_commission_pct` column default70`src/migrations/002_column_additions.sql:62`❌ should be 80`video.js` fallback (branch A)80`src/routes/video.js:135`✅`video.js` fallback (branch B)80`src/routes/video.js:173`✅Doctor-facing promise "you keep 80%"80`src/views/doctor_profile.ejs:459-461`✅ (add-on context)

Row read on insert: `src/routes/video.js:801` and `:954`.

**Fix (lands in migration 019, Phase 2 of addon refactor):**

1. `ALTER TABLE services ALTER COLUMN video_doctor_commission_pct SET DEFAULT 80;`
2. `ALTER TABLE services ALTER COLUMN doctor_commission_pct SET DEFAULT 80;`
3. `UPDATE services SET video_doctor_commission_pct = 80 WHERE video_doctor_commission_pct = 70;`
4. `UPDATE services SET doctor_commission_pct = 80 WHERE doctor_commission_pct = 70;`

The `80` fallback literal in `video.js:135, 173` stays through Phases 2–3 (harmless; column is always 80 now) and is removed in Phase 4 prep.

**Verification at Phase 4 cutover:** re-read `doctor_profile.ejs:459-461`. The paragraph mixes main-case copy ("20% of the service price") with video-add-on copy ("80% of each video consultation fee"). Both are consistent with the §0 two-tier model; confirm explicitly before removing the fallback.

**Mark this entry resolved once Phase 2 migration 019 lands.**

---

## \[Later\] Live FX automation for addon pricing

**Discovered:** 2026-04-24, during add-on abstraction design (Group 3.1).

`addon_services.prices_json` stores per-currency prices explicitly (e.g. `{"EGP": 400, "SAR": 100, "AED": 95}`). This matches the existing `services.video_consultation_prices_json` behaviour and is the authoritative source under the Phase 2 design. It does not use a live FX rate — prices are set manually per currency per add-on.

Eventually consider:

- A live FX table (`fx_rates` with `currency, rate_vs_egp, fetched_at`).
- A daily job that pulls from a provider (Wise / OpenExchangeRates).
- Resolver falls back to `base_price_egp * fx_rate` when a currency is not in `prices_json`.
- Guard against volatile days (staleness threshold, manual override).

Not urgent; explicit per-currency prices are fine for the catalogue we have today (2 add-ons × 3–4 currencies = hand-manageable).

---

## \[Closed\] case_sla_worker migration — no longer needed

**Opened:** 2026-04-24 (Phase 2 review). **Closed:** 2026-04-24 (SLA addon decommissioned).

This entry originally tracked a plan to migrate `case_sla_worker.js`off `orders.sla_hours` and onto `order_addons.metadata_json` for the sla_24hr addon. With migration 019b removing the sla_24hr addon entirely (urgency tiers on main-service pricing carry that functionality instead), there is no longer an addon whose lifecycle the worker would need to read. The worker stays on `orders.sla_hours`— which is correct and permanent, because urgency tier is now a main-service field, not an addon concern.

The Phase 6 urgency work (above) includes its own plan for how urgency tier gets represented; when that ships, this entry can be fully deleted. Keeping as a closed reference until then.

---

## \[Later\] Paymob refund automation

**Discovered:** 2026-04-24, during add-on abstraction design (Group 3.1).

When an add-on is marked `status='refunded'` (e.g. a prescription add-on was paid for but the doctor completed the case without attaching one), the `order_addons.refund_pending = true` flag is set and an audit event `addon_refund_queued` is logged. The actual refund through Paymob is manual today — an admin opens the Paymob dashboard and triggers it.

Add an automated refund path that:

- Calls the Paymob refund API on `refund_pending=true` rows.
- Transitions the row to `refund_pending=false` + records `refunded_at = NOW()` + the Paymob refund transaction id in `metadata_json.paymob_refund_id`.
- Handles partial refunds (if an order has multiple add-ons and only one is being refunded).
- Surfaces a dashboard widget for admins to review failed refunds.

Out of scope for the add-on abstraction rollout; do it once the abstraction has stabilised.

---

## \[Later, pre-existing\] Orphan `addon` specialty_id in services

**Discovered:** 2026-04-24, during specialty dedupe (migration 018).

Two rows in `services` have `specialty_id = 'addon'` which is not a valid specialty row. Not caused by the dedupe — pre-existing. Left in place because fixing it was out of scope for the dedupe commit.

Either:

- Delete the two services rows (if they're abandoned pricing entries), OR
- Create an `addon` row in `specialties` (if they're intentionally a separate product line), OR
- Migrate them to a proper specialty.

Query to surface them:

```sql
SELECT id, name, specialty_id, price
  FROM services
 WHERE specialty_id NOT IN (SELECT id FROM specialties);
```

---

## \[Later, discovered 2026-06-10\] Remaining 2-tier-model 72h/24h labels on checkout/order surfaces

Correct the remaining 2-tier-model "72h standard / 24h express" delivery labels on patient-facing checkout/order surfaces to the real per-tier SLA (Standard 48h / VIP 18h / Urgent 4h). **Patient-facing display strings are the priority.** Treat the internal `standard_72h` / `priority_24h` enums with care — the functional `sla_hours` value is already correct (48), so these are display/label concerns, not logic. Not a launch blocker.

**Patient-facing display (fix):**
- `src/views/services.ejs:481,494,495` — "72-hour" tier label + "within 72 hours" / "في خلال 72 ساعة"
- `src/views/order_confirmation.ejs:24` — `tt('oc.standard', 'Standard (72h)', 'عادي (72 ساعة)')`
- `src/views/public_case_thankyou.ejs:28` — `tt('pcty.standard', 'Standard (72h)', 'عادي (72 ساعة)')`
- `src/views/public_case_new.ejs:102` — `'Standard · 72h'` / `'عادي · ٧٢ ساعة'`
- `src/views/order_upload.ejs:31-32` — `'72h standard · 24h fast track'` / `'72 ساعة عادي · 24 ساعة سريع'`

**Internal enums (handle with care — sla_hours already 48):**
- `src/routes/api/cases_intake.js:26,33`, `src/routes/intake.js:280` — `sla_type` values `'standard_72h'` / `'priority_24h'`. Renaming touches enum identity; confirm no persisted rows / downstream readers depend on the string before changing.

**Non-prod / internal (low priority):** `src/views/sandbox_order_intake.ejs:64`, `src/views/help_doctor_guide.ejs:326` (mockup badge).

Surfaced during the refund/delivery-copy truthfulness pass (`fix/refund-copy-truthful`); deferred per request — patient-facing checkout labels first when picked up.

---

## \[Later, discovered 2026-06-10\] Legal/policy pages are English-only — add Arabic (NOT cosmetic)

The three binding legal pages — `src/views/refund_policy.ejs`, `src/views/terms.ejs`, `src/views/delivery_policy.ejs` — render **English only** (no `tt()`/Arabic display strings; the truthfulness pass updated the English wording, there was no Arabic to update). Most patients transact in Arabic, so the binding terms (refund, cancellation, delivery) are **not readable to them**. This is more than cosmetic — it is the legal surface for Arabic-speaking patients and may be a **consumer-protection / compliance requirement** (terms presented in a language the consumer understands).

**Scope when picked up:** add Arabic alongside the English on all three pages, ideally via the existing `tt()` / lang pattern so each renders per the user's language; keep the Arabic in lockstep with the now-truthful English wording. Consider a legal review of the Arabic terms. Flag to whoever owns compliance.

---

## \[Later, discovered 2026-06-10\] Legacy `/order/*` checkout is anonymously URL-reachable with stale pricing/refund copy

**Sites:** `src/routes/order_flow.js`, mounted `app.use('/', orderFlowRoutes)` at `src/server.js:870`; view `src/views/order_review.ejs` (rendered only by `POST /order/:orderId/review`, `order_flow.js:402`); `src/views/order_start.ejs` (the only file linking to `/order/start`, and it is itself never rendered by any route).

**State:** The legacy `/order/*` checkout (`/order/start` → `/upload` → `/review` → `/payment` → `/confirmation`) is superseded by the live wizard at `/patient/new-case` (`requireRole('patient')`). Its entry point `GET /order/start` now renders `coming_soon`, and the original draft-creating handler is commented out (`order_flow.js:121-131`); nothing in the repo links into the flow. BUT the routes are still mounted with **no auth guard** (no `requireRole`/`requireAuth` on any `/order/*` route — only the `/api/cases/*` siblings in the same file are gated), so a hand-crafted `GET /order/<id>/upload` or `POST /order/<id>/review` still responds anonymously. Those legacy views also still carry "+X% surcharge" pricing framing and refund copy that the Item-2 / Item-3 passes deliberately did NOT touch (out of scope — not patient-reachable through the product).

**Why this isn't urgent:** No patient reaches `/order/review` through the product (entry point severed); low discovery likelihood.

**Recommended fix when picked up:** Either (a) unmount `app.use('/', orderFlowRoutes)` if the flow is dead, or (b) gate the `/order/*` routes behind `requireRole('patient')` and align/remove their stale surcharge + refund copy. Confirm no mobile/legacy client depends on `/order/*` before unmounting.

Out of scope for the surcharge-display change that surfaced it (Item 2); logged per request to open a separate low-priority cleanup task.
