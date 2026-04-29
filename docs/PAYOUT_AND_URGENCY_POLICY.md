# Tashkheesa — Payout & Urgency Policy

**Status:** Canonical source of truth. As of 2026-04-29.
**Owner:** Ziad
**Last reviewed:** 2026-04-29

This document is the single source of truth for how money flows through Tashkheesa. Whenever the code, the doctor profile UI, or the patient checkout disagrees with this document, **this document wins** — code/UI must be updated to match. If the policy needs to change, update this file first, then propagate.

---

## 1. Revenue split per component

A patient's total payment for a case can be made up of up to four components: the main case fee (always present), a video consult add-on (optional), a prescription add-on (optional), and an urgency uplift (optional, only present when the patient picks VIP or Urgent tier).

Each component has its own doctor / Tashkheesa split:

| Component | Doctor share | Tashkheesa share |
|---|---|---|
| Main case base price | 20% | 80% |
| Video consult add-on | 85% | 15% |
| Prescription add-on | 50% | 50% |
| Urgency uplift (the multiplier delta only — see section 2) | 30% | 70% |

The doctor's earnings on a given case are the sum of their share across each present component. The platform's revenue is the inverse.

---

## 2. Urgency tiers

The patient picks one tier at checkout. The tier sets both the SLA promise and a price multiplier on the main case base price.

| Tier | SLA (turnaround) | Price multiplier | Cut-off window |
|---|---|---|---|
| Standard | 48 hours | 1.0× | none — available 24/7 |
| VIP | 12–18 hours | 1.3× | none — available 24/7 |
| Urgent | 1–4 hours | 1.6× | 7:00am – 7:00pm Cairo time only |

**Definition of "urgency uplift":** the difference between the tier-multiplied price and the standard (1.0×) price.

- VIP uplift = base × 0.3 (i.e. 30% of base added on top)
- Urgent uplift = base × 0.6 (i.e. 60% of base added on top)
- Standard uplift = 0 (no uplift)

The uplift is what gets the 30/70 split. The base portion always gets the 20/80 split.

---

## 3. Urgent cut-off behaviour

If a patient submits at a time when Urgent is unavailable (before 7am or after 7pm Cairo time), the system **must not silently reject** the request. Instead, present two options:

1. **Wait until 7am, treat as Urgent** — clock starts at 7am the next eligible morning. SLA deadline is 4 hours from 7am.
2. **Downgrade to VIP now** — case gets the VIP tier, 1.3× pricing, 12–18h SLA, processed immediately.

The patient explicitly picks one. No default; no silent behavior change.

---

## 4. SLA breach handling

If a doctor accepts an Urgent or VIP case and delivers after the SLA deadline, treat it as a breach.

**Patient side:**
- Refund the full urgency uplift portion (the difference between tier price and standard price)
- Patient keeps the case at standard pricing (they paid base × 1.0 effectively)
- Refund tracked in the `refunds` table with `reason = 'sla_breach'`

**Doctor side:**
- Earnings are recalculated as if the case was Standard tier
- Doctor receives only `base × 0.20` (no uplift share)
- Doctor loses the 30% they would have earned on the uplift
- This is **not a punitive deduction** — they just don't earn the bonus they didn't earn

**Platform side:**
- Tashkheesa loses the 70% it would have earned on the uplift
- Both parties bear the operational hit; doctor isn't disproportionately penalized

**Detection:** existing SLA system already tracks deadlines and breaches via `orders.sla_deadline` and `orders.status = 'breached'`. Refund + earnings recalculation hooks into that detection.

---

## 5. Worked examples

### Example A — Standard case, no add-ons
Cardiac MR Review, base price 3,000 EGP, Standard tier.

- Patient pays: 3,000 EGP
- Doctor earns: 3,000 × 0.20 = **600 EGP**
- Tashkheesa keeps: **2,400 EGP**

### Example B — VIP case, no add-ons
Same service, VIP tier (1.3×).

- Patient pays: 3,000 × 1.3 = 3,900 EGP
- Base portion (3,000): doctor 20% = 600, platform 80% = 2,400
- Uplift portion (900): doctor 30% = 270, platform 70% = 630
- Doctor earns: 600 + 270 = **870 EGP**
- Tashkheesa keeps: 2,400 + 630 = **3,030 EGP**

### Example C — Urgent case + video consult add-on
Same service, Urgent tier (1.6×), patient also adds video consult at 1,000 EGP.

- Patient pays: (3,000 × 1.6) + 1,000 = 5,800 EGP
- Base portion (3,000): doctor 600, platform 2,400
- Uplift portion (1,800): doctor 540, platform 1,260
- Video add-on (1,000): doctor 850, platform 150
- Doctor earns: 600 + 540 + 850 = **1,990 EGP**
- Tashkheesa keeps: 2,400 + 1,260 + 150 = **3,810 EGP**

### Example D — VIP case breached (delivered late)
Example B's case, but doctor delivers in 24h instead of 18h.

- Patient paid 3,900 EGP at checkout
- Refund issued: 900 EGP (the urgency uplift)
- Patient's net spend: 3,000 EGP (treated as Standard)
- Doctor earns: 600 EGP (standard portion only — no uplift bonus)
- Tashkheesa keeps: 2,400 EGP (standard portion only)
- Refunds table: row with `reason='sla_breach'`, `amount=900`

---

## 6. Patient checkout — required visibility

The patient must see the price breakdown explicitly at checkout, not just a single total.

**Required line items:**
```
Service price:        3,000 EGP
Urgency surcharge (VIP):  900 EGP   ← only shown when tier ≠ Standard
Video consult:        1,000 EGP   ← only shown when add-on selected
Prescription:           500 EGP   ← only shown when add-on selected
─────────────────────────────────
Total:                5,400 EGP
```

The urgency surcharge line must include the note **"refundable if SLA is breached"** so the refund promise is upfront and credible.

---

## 7. Doctor earnings page — required visibility

On the doctor's earnings page, each completed case must show its components as separate lines, not a single total.

**Required line items per case:**
```
Case #ABC123 — Cardiac MR Review
  Base fee:               600 EGP
  Urgency bonus (VIP):    270 EGP   ← only shown when tier ≠ Standard
  Video consult share:    850 EGP   ← only shown when add-on present
  Prescription share:     250 EGP   ← only shown when add-on present
  ──────────────────────────────
  Total earned:         1,970 EGP
```

This transparency lets doctors see what the breakdown is, builds trust, and makes the policy legible.

---

## 8. Per-service overrides

Default multipliers (1.0 / 1.3 / 1.6) and split percentages apply to all services as the platform default. The `services` table has columns to allow per-service overrides if needed in the future:

- `vip_multiplier` (default 1.3)
- `urgent_multiplier` (default 1.6)
- `urgency_uplift_doctor_pct` (default 30)
- `doctor_commission_pct` for the base price (default 20)

Add-ons have their own per-add-on commission column already (`addons.doctor_commission_pct`).

For now, every row uses the platform defaults. Per-service overrides are a future-flexibility hook, not an active feature.

---

## 9. Database schema implications

This policy requires the following migrations (to be implemented in the upcoming "payout policy fix" PR):

1. **Update `addons.doctor_commission_pct`:**
   - Video consult: change default and existing rows from 80 → **85**
   - Prescription: change default and existing rows from 80 → **50**

2. **Add columns to `services` table:**
   - `vip_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.3`
   - `urgent_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.6`
   - `urgency_uplift_doctor_pct INTEGER NOT NULL DEFAULT 30`

3. **Create `refunds` table:**
   ```sql
   CREATE TABLE refunds (
     id TEXT PRIMARY KEY,
     order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     amount_egp NUMERIC(10,2) NOT NULL,
     reason TEXT NOT NULL,
     refunded_at TIMESTAMP DEFAULT NOW(),
     refunded_by TEXT,
     paymob_refund_id TEXT,
     notes TEXT
   );
   CREATE INDEX idx_refunds_order ON refunds(order_id);
   CREATE INDEX idx_refunds_reason ON refunds(reason);
   CREATE INDEX idx_refunds_created ON refunds(refunded_at);
   ```

4. **Update existing SLA hours:**
   - Standard: change from 72h to **48h**
   - VIP/fast_track: change from 24h to **18h** (use 18h as the breach threshold; doctor aims for 12h but has up to 18h)
   - Urgent: keep at **4h**

5. **Update urgent cut-off enforcement** in `src/routes/order_flow.js`:
   - Currently hard-rejects with HTTP 400 when outside 7am-7pm
   - Must instead present the two-option choice (wait or downgrade) per Section 3
   - Cairo time bounds: 7:00 ≤ hour < 19:00 (which is what the code currently has — keep this)

---

## 10. Source-of-truth precedence

When there is any conflict between this document and:

- The doctor profile page UI ("Your fee is 20% of service price...") — **this document wins**, the UI must be updated to be more nuanced (it currently understates the doctor's earnings on add-ons and urgency cases)
- The code's hardcoded percentages — **this document wins**, the code must be updated
- The pricing spreadsheet (`tashkheesa_pricing_v2.xlsx`) — **this document wins**, the spreadsheet must be updated
- Any future contract or marketing material — **this document wins**, those must be updated

If you (Ziad) decide to change any of these numbers, update **this file first**, then write a migration / code change / UI update PR that brings everything else into line.

---

## 11. Audit trail

| Date | Change | Reason |
|---|---|---|
| 2026-04-29 | Initial document created | Codify policy after discovering code/UI/memory disagreement during earnings page scope discussion |
