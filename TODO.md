# TODO — known issues not yet fixed

Items discovered during in-flight work that were out of scope for the
commit that surfaced them. Each entry names the exact code sites.
Delete an entry only when it ships a fix.

---

## [RESOLVES IN PHASE 2] Video-consult commission: wrong migration default

**Discovered:** 2026-04-24, during add-on abstraction recon (Group 3.1).
**Reframed:** 2026-04-24, after commission-model clarification — see
`docs/architecture/addon_service_abstraction.md` §0 and §6.
**Fix lands:** in Phase 2 of the addon refactor (migration 019).

Under the two-tier commission model (main services 80/20
platform/doctor, add-ons 20/80 platform/doctor), video consult is an
add-on and therefore pays the doctor **80%**. The `80` fallback in
`video.js` was correct all along; the bug is the `70` column default.

| Source                                                  | Value | File:line                                    | Correct? |
|---------------------------------------------------------|------:|---------------------------------------------|---------:|
| `services.video_doctor_commission_pct` column default   |    70 | `src/migrations/002_column_additions.sql:50` | ❌ should be 80 |
| `services.doctor_commission_pct` column default         |    70 | `src/migrations/002_column_additions.sql:62` | ❌ should be 80 |
| `video.js` fallback (branch A)                          |    80 | `src/routes/video.js:135`                   | ✅ |
| `video.js` fallback (branch B)                          |    80 | `src/routes/video.js:173`                   | ✅ |
| Doctor-facing promise "you keep 80%"                    |    80 | `src/views/doctor_profile.ejs:459-461`      | ✅ (add-on context) |

Row read on insert: `src/routes/video.js:801` and `:954`.

**Fix (lands in migration 019, Phase 2 of addon refactor):**

1. `ALTER TABLE services ALTER COLUMN video_doctor_commission_pct SET DEFAULT 80;`
2. `ALTER TABLE services ALTER COLUMN doctor_commission_pct       SET DEFAULT 80;`
3. `UPDATE services SET video_doctor_commission_pct = 80 WHERE video_doctor_commission_pct = 70;`
4. `UPDATE services SET doctor_commission_pct       = 80 WHERE doctor_commission_pct       = 70;`

The `80` fallback literal in `video.js:135, 173` stays through Phases
2–3 (harmless; column is always 80 now) and is removed in Phase 4
prep.

**Verification at Phase 4 cutover:** re-read `doctor_profile.ejs:459-461`.
The paragraph mixes main-case copy ("20% of the service price") with
video-add-on copy ("80% of each video consultation fee"). Both are
consistent with the §0 two-tier model; confirm explicitly before
removing the fallback.

**Mark this entry resolved once Phase 2 migration 019 lands.**

---

## [Later] Live FX automation for addon pricing

**Discovered:** 2026-04-24, during add-on abstraction design (Group 3.1).

`addon_services.prices_json` stores per-currency prices explicitly
(e.g. `{"EGP": 400, "SAR": 100, "AED": 95}`). This matches the
existing `services.video_consultation_prices_json` behaviour and is
the authoritative source under the Phase 2 design. It does not use a
live FX rate — prices are set manually per currency per add-on.

Eventually consider:
- A live FX table (`fx_rates` with `currency, rate_vs_egp, fetched_at`).
- A daily job that pulls from a provider (Wise / OpenExchangeRates).
- Resolver falls back to `base_price_egp * fx_rate` when a currency
  is not in `prices_json`.
- Guard against volatile days (staleness threshold, manual override).

Not urgent; explicit per-currency prices are fine for the catalogue
we have today (3 add-ons × 3–4 currencies = hand-manageable).

---

## [Later] Kashier refund automation

**Discovered:** 2026-04-24, during add-on abstraction design (Group 3.1).

When an add-on is marked `status='refunded'` (e.g. a prescription
add-on was paid for but the doctor completed the case without attaching
one), the `order_addons.refund_pending = true` flag is set and an audit
event `addon_refund_queued` is logged. The actual refund through Kashier
is manual today — an admin opens the Kashier dashboard and triggers it.

Add an automated refund path that:

- Calls the Kashier refund API on `refund_pending=true` rows.
- Transitions the row to `refund_pending=false` + records
  `refunded_at = NOW()` + the Kashier refund transaction id in
  `metadata_json.kashier_refund_id`.
- Handles partial refunds (if an order has multiple add-ons and only
  one is being refunded).
- Surfaces a dashboard widget for admins to review failed refunds.

Out of scope for the add-on abstraction rollout; do it once the
abstraction has stabilised.

---

## [Later, pre-existing] Orphan `addon` specialty_id in services

**Discovered:** 2026-04-24, during specialty dedupe (migration 018).

Two rows in `services` have `specialty_id = 'addon'` which is not
a valid specialty row. Not caused by the dedupe — pre-existing. Left
in place because fixing it was out of scope for the dedupe commit.

Either:

- Delete the two services rows (if they're abandoned pricing entries), OR
- Create an `addon` row in `specialties` (if they're intentionally a
  separate product line), OR
- Migrate them to a proper specialty.

Query to surface them:

```sql
SELECT id, name, specialty_id, price
  FROM services
 WHERE specialty_id NOT IN (SELECT id FROM specialties);
```
