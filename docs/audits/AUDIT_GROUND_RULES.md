# Audit Ground Rules

**Status:** Canonical. Reference these from any audit prompt.
**Owner:** Ziad
**Last updated:** 2026-04-30

These rules apply to all production audits of Tashkheesa, Shifa, and any related infrastructure. They exist because past audits have produced false positives or missed scope by violating them.

---

## GR-DB-1 — Verify production database hostname before any SQL claim

Before running or citing any query that purports to represent production data, the audit MUST:

1. Check the Render dashboard's `DATABASE_URL` env var hostname for the production service.
2. Record the hostname in the audit document's Phase 0 section.
3. Only use queries against that hostname when claiming "verified on production."

Local Postgres, decommissioned databases, or any other DB are acceptable for FLAG/INFO-tier findings but **NEVER for BLOCK-tier financial or security findings**.

**Past failure:** The full April 2026 audit verified Phase 7 BLOCK finding (B4 — 19 services with inverted `doctor_fee`) against frozen Neon DB. Production was Supabase. False positive nearly triggered unnecessary financial reconciliation work. See `full-audit-april-2026.md` § POST-AUDIT CORRECTION for full narrative.

---

## GR-SCOPE-1 — Distinguish "verified" from "inferred"

Every finding must declare its evidence type:

- **VERIFIED** — direct query against production DB, direct curl against production URL, direct git log inspection. Cite the artifact (SQL output, HTTP response, commit hash).
- **INFERRED** — read from local DB, read from code, read from docs. Tag explicitly as "local-DB inferred" or "code-only" — never as "production verified."
- **UNVERIFIED** — needs production access the audit doesn't have. List as a follow-up VERIFY item, do not promote to BLOCK.

A BLOCK-tier finding requires VERIFIED evidence. INFERRED findings can be FLAG at most.

---

## GR-FINANCIAL-1 — Catalog data findings need blast-radius check

Before promoting any catalog-data finding (services pricing, doctor commissions, addon prices) to BLOCK, run a blast-radius query against production:

- How many paid orders are affected?
- What is the total EGP exposure (over- or under-payment)?
- How many doctors / patients are affected?

If the blast radius is zero on production, the finding is at most a FLAG (catalog hygiene), not a BLOCK.

**Past failure:** B4 (April 2026) was promoted to BLOCK based on local catalog data. Production blast-radius was zero. See GR-DB-1 reference above.

---

## Audit trail

| Date | Change | Reason |
|---|---|---|
| 2026-04-30 | Initial document created | Prevent repeat of April 2026 audit's "wrong database" methodology failure (GR-DB-1) and catalog blast-radius miss (GR-FINANCIAL-1) |
