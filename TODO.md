# TODO — known issues not yet fixed

Items discovered during in-flight work that were out of scope for the
commit that surfaced them. Each entry names the exact code sites.
Delete an entry only when it ships a fix.

---

## [BLOCKER / Phase 4 cutover gate] Video consult commission: 70% vs 80% inconsistency

**Discovered:** 2026-04-24, during add-on abstraction recon (Group 3.1).
**Blocks:** Phase 4 cutover of the add-on service abstraction — see
`docs/architecture/addon_service_abstraction.md` §6.

The doctor's video-consult commission split is specified in three
places and they disagree:

| Source                               | Value | File:line                                        |
|--------------------------------------|------:|--------------------------------------------------|
| `services.video_doctor_commission_pct` column default | 70 | `src/migrations/002_column_additions.sql:50`     |
| `services.doctor_commission_pct` column default       | 70 | `src/migrations/002_column_additions.sql:62`     |
| Route fallback when column is NULL (branch A)         | 80 | `src/routes/video.js:135`                        |
| Route fallback when column is NULL (branch B)         | 80 | `src/routes/video.js:173`                        |
| Doctor-facing copy: "you keep 80% of each video consultation fee" | 80 | `src/views/doctor_profile.ejs:459-461` |

Commission is then read off the row at `src/routes/video.js:801` and
`:954` when the `doctor_earnings` row is inserted.

**Impact today:** doctors whose `services.video_doctor_commission_pct`
was never explicitly set earn at 80%; any doctor whose row was
backfilled to the column default earns at 70%. This is already
producing silent drift in `doctor_earnings`.

**Resolution (target: before Phase 4 of addon abstraction starts):**

1. Pick the truth. The product copy at `doctor_profile.ejs:459-461`
   promises **80%** to doctors — that promise wins unless legal/finance
   says otherwise. Decide explicitly.
2. Write a one-shot SQL runbook at `docs/db/video_commission_80pct_<date>.md`:
   - `UPDATE services SET video_doctor_commission_pct = 80 WHERE video_doctor_commission_pct = 70;`
   - Sanity check: no rows still at 70 afterwards.
   - Update both column defaults in a fresh migration (the existing
     migration 002 is historical and won't re-run).
3. Remove the `80` fallback literal at `src/routes/video.js:135` and
   `:173` — column is now always populated.
4. Re-run `verify_addon_parity.js` (once the add-on abstraction lands
   Phase 3) with zero mismatches.
5. Only then unblock Phase 4 cutover.

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
