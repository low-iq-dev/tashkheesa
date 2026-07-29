# Tashkheesa Pricing — Single Source of Truth

**Canonical file:** `docs/pricing/tashkheesa_pricing_MASTER.xlsx`
**Established:** 2026-07-29 · supersedes all prior v2/v3/v4-proposal pricing files.

Any pricing question — EG or international — is answered by MASTER. Every other
pricing spreadsheet in this repo or the sibling `tashkheesa-*` clones is stale;
do not price from them. Superseded originals are in `_archive_pre_v4_2026-07-29/`.

## What MASTER contains
- **Pricing Comparison** — 162 services × 19 specialties, EG pricing (revised
  v3 model): 5 tiers, doctor 20% / platform 80%, VIP ×1.30 (18h), Urgent ×1.60 (4h).
- **Intl Tier Matrix** — tier × market standard prices for US, GB, AE, SA, KW,
  QA, BH, OM (local currency), with the 20/80 split + VIP/Urgent + USD-equiv.
- **Intl Benchmarks** — competitor evidence + rationale per market; sources.
- **Intl Per-Service** — all 162 services priced in every market, shaped for
  the `service_regional_prices` table (tashkheesa_price + doctor_commission=20%).

## Tier ladder (standard 48h)
| Tier | EGP | USD | GBP | AED | SAR | KWD | QAR | BHD | OMR |
|------|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| Quick| 800 | 39  | 79  | 149 | 149 | 12  | 149 | 15  | 15  |
| T1   |1600 |120  |150  | 449 | 449 | 35  | 449 | 45  | 45  |
| T2   |2400 |200  |250  | 749 | 749 | 59  | 749 | 75  | 75  |
| T3   |3500 |350  |400  |1199 |1199 | 95  |1199 |119  |119  |
| T5   |5500 |550  |600  |1899 |1899 |149  |1899 |189  |189  |

Doctor share is a uniform 20% of the local invoice in every market (Model A).

## Document → database flow (how MASTER reaches the app)
1. MASTER.xlsx is edited (blue `NEW recommended` / tier prices only).
2. Regenerate JSON in the sync schema (`xlsx_to_json.py`, to be updated for the
   new multi-market structure).
3. `node scripts/sync_pricing_from_xlsx.js --dry-run` → review diff.
4. Apply, then verify against `service_regional_prices` / `services`.
5. Enable a market end-to-end: add its code to `LAUNCH_MARKETS` in
   `src/launch-market.js` (currently `{'EG'}`). That Set is the ONLY switch.

## NOT YET APPLIED TO PRODUCTION (as of 2026-07-29)
MASTER is the canonical DOCUMENT. The live database has NOT been repriced to it.
Applying it is a deliberate, backed-up operation because it changes live EG
prices patients pay (e.g. Cardiac MR 8,395→2,400; Echo 1,380→2,400) in addition
to adding the international rows. See the pricing-apply task before running any
sync against production.
