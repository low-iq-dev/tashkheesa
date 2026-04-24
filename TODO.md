# TODO — known issues not yet fixed

Items discovered during in-flight work that were out of scope for the
commit that surfaced them. Each entry names the exact code sites.
Delete an entry only when it ships a fix.

---

## [CRITICAL / BLOCKS ALL PAYMOB WEBHOOKS] payments.js writes to non-existent `orders.paid_at` column

**Discovered:** 2026-04-24, during Phase 3 synthetic webhook replay
(`scripts/replay_paymob_webhook.js`). Every scenario caused the
payment callback to return HTTP 500 with
`column "paid_at" does not exist`.

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

Live `orders` schema has `payment_id`, `payment_link`, `payment_method`,
`payment_reference`, `payment_status` — but **no `paid_at`**. The SQL
fails at parse time → UPDATE throws → the error handler renders the
500 page → Paymob retries → still 500 forever.

This means **every Paymob payment webhook is currently broken in
production.** It hasn't fired because real traffic is effectively
zero. The moment a live payment lands, the callback will 500, the
order will stay at `payment_status = 'unpaid'` despite the patient
being charged, and we'll get a support ticket.

**Fix options:**

1. **Add `paid_at TIMESTAMPTZ` to orders.** New migration, back-fill
   from `updated_at` where `payment_status='paid'` (probably zero rows).
   This is what the code expects. Simplest path.
2. **Drop `paid_at` from the UPDATE statement.** Use `updated_at`
   alone for the "when did payment happen" timestamp. Code-only fix,
   no schema change, but loses the semantic distinction.

Recommend (1). Ship as a one-commit fix with its own migration BEFORE
Phase 3 dual-write wiring — Phase 3 cannot be meaningfully verified
while the V1 callback is broken.

**This is outside the add-on abstraction scope. I did not fix it in
my session; flagging for your decision on who should own the fix and
when it should land.**

---

## [Phase 6] Migrate urgency surcharge to first-class addon

**Captured:** 2026-04-24, during Phase 3 prep review.
**Unblocks:** after Phase 5 (prescription feature) stabilises.

Urgency surcharge is currently **baked into the `services` pricing
model** — the case's total price already includes the urgency
premium, and the doctor's commission flows out of the same case-level
split. Under the corrected commission policy, the urgency surcharge
is **Tashkheesa 75% / Doctor 25%**, which differs from both the main
case split (80/20) and the add-on split (20/80). Two different splits
on a single order cannot be represented cleanly while urgency lives
inside the flat `services.price` field.

Phase 6 migration scope (deferred — do NOT start until prescription
ships and production is stable):

- Schema: separate `orders.base_price` from `orders.urgency_surcharge`.
  Back-compat view or trigger to keep `orders.price` derivable.
- New addons: `Urgency24hAddon` and `UrgencySameDayAddon`, both
  extending `AddonService`, commission splits per §0 of the design
  doc (85/15 for 24h rush, 70/30 for same-day / 6h), `has_lifecycle
  = false` — urgency has no separate doctor-side step, it modifies
  the main-case SLA deadline instead.
- Migration 0XX to seed the two urgency rows into `addon_services`
  and backfill `order_addons` for any order with an urgency tier.
- Checkout flow rework: Patient's case-submission flow currently bakes
  urgency into the service price; refactor so it's selected as an
  addon alongside prescription and video.
- Extend `scripts/verify_addon_parity.js` with urgency-specific
  comparisons: old (`orders.urgency_flag` + urgency_tier + implicit
  price uplift) vs new (`order_addons` rows with
  `addon_service_id IN ('urgency_24h', 'urgency_same_day')`).
- Doctor earnings: ensure each urgency tier's split (15% / 30%)
  writes an `addon_earnings` row per urgent order. Reconcile against
  historical `doctor_fee` values to confirm no drift.
- `orders.sla_hours` + `case_sla_worker.js`: both remain — the
  `case_sla_worker` reads `orders.sla_hours` regardless of whether
  urgency is expressed as a main-service field or an addon. Nothing
  to migrate on the worker side.

**Why deferred:** urgency touches every case, not just add-on cases,
and the price-model split is a larger migration than prescription +
video combined. Ship the current two-addon abstraction and the
prescription feature first, then tackle urgency with the abstraction
already battle-tested.

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
we have today (2 add-ons × 3–4 currencies = hand-manageable).

---

## [Closed] case_sla_worker migration — no longer needed

**Opened:** 2026-04-24 (Phase 2 review).
**Closed:** 2026-04-24 (SLA addon decommissioned).

This entry originally tracked a plan to migrate `case_sla_worker.js`
off `orders.sla_hours` and onto `order_addons.metadata_json` for the
sla_24hr addon. With migration 019b removing the sla_24hr addon
entirely (urgency tiers on main-service pricing carry that
functionality instead), there is no longer an addon whose lifecycle
the worker would need to read. The worker stays on `orders.sla_hours`
— which is correct and permanent, because urgency tier is now a
main-service field, not an addon concern.

The Phase 6 urgency work (above) includes its own plan for how
urgency tier gets represented; when that ships, this entry can be
fully deleted. Keeping as a closed reference until then.

---

## [Later] Paymob refund automation

**Discovered:** 2026-04-24, during add-on abstraction design (Group 3.1).

When an add-on is marked `status='refunded'` (e.g. a prescription
add-on was paid for but the doctor completed the case without attaching
one), the `order_addons.refund_pending = true` flag is set and an audit
event `addon_refund_queued` is logged. The actual refund through Paymob
is manual today — an admin opens the Paymob dashboard and triggers it.

Add an automated refund path that:

- Calls the Paymob refund API on `refund_pending=true` rows.
- Transitions the row to `refund_pending=false` + records
  `refunded_at = NOW()` + the Paymob refund transaction id in
  `metadata_json.paymob_refund_id`.
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
