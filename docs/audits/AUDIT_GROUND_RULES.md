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

## GR-CSP-1 — Nonce-based CSP fixes depend on helmet `'unsafe-inline'` being killed

Theme 2 (CSP / view crashes, completed 2026-05-11) hardened ~25 inline `<script>` tags with `nonce="…"`, threaded `cspNonce` through 17 patient views' head/foot includes, and added a CI lint (`tests/lint/no-bare-foot-include.test.js`) to prevent regression. Every one of those fixes only matters under a **strict** CSP policy — one where `script-src` does NOT include `'unsafe-inline'`.

Today, both Helmet (`src/middleware.js:23` and `:30`) and the per-request strict-CSP middleware (`src/server.js:349`) emit Content-Security-Policy headers. If a future refactor consolidates them and Helmet's `'unsafe-inline'` directive wins:
- Every Theme 2 nonce becomes decorative — browsers stop enforcing.
- A stored-XSS payload is no longer blocked by CSP, only by per-field escaping.
- The CI lint test will still pass (it checks `cspNonce` is threaded, not that CSP is strict).

**Rule:** when auditing CSP, never read the Theme 2 nonce coverage as "we have a strict CSP". Verify by:
1. `grep -n "unsafe-inline" src/middleware.js src/server.js` → must be zero on the script-src directive for the active middleware.
2. `curl -sI https://tashkheesa.com/ | grep -i content-security-policy` → the actual header on a prod response must not contain `script-src ... 'unsafe-inline'`.

**Cross-theme dependency:** Theme 3 (CSRF) and/or Theme 11 (strict-CSP consolidation) own the work of deleting `'unsafe-inline'` from helmet's directive list. Until that ships, Theme 2's *correctness* is in place but its *security value* is contingent.

---

## Reference: production infrastructure providers

For audits that touch transport or external dependencies, treat these as ground truth (source of truth: Render env vars and provider dashboards):

| Concern | Provider | Verifying surface |
|---|---|---|
| Database (production) | Supabase Postgres | Render `DATABASE_URL` hostname (see GR-DB-1) |
| Email (transactional) | Resend (`resend` SDK, HTTP API) | `RESEND_API_KEY` env var; logs at https://resend.com/emails |
| WhatsApp | Meta WhatsApp Cloud API | `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` |
| Object storage | AWS S3 + Cloudinary | `@aws-sdk/client-s3` and `cloudinary` deps |
| Payments | Paymob | webhook handler at `src/routes/payments.js` |

Findings that name an email-transport bug ("Gmail rate limit", "SMTP TLS handshake", "nodemailer transporter") are stale as of 2026-04-30 — the SMTP path was removed. From-address is `noreply@tashkheesa.com`; the `tashkheesa.com` Resend domain is DKIM-verified via Cloudflare DNS.

---

## Audit trail

| Date | Change | Reason |
|---|---|---|
| 2026-04-30 | Initial document created | Prevent repeat of April 2026 audit's "wrong database" methodology failure (GR-DB-1) and catalog blast-radius miss (GR-FINANCIAL-1) |
| 2026-05-11 | Added GR-CSP-1 | Theme 2 (CSP / view crashes) shipped per-script nonces, but its security value is contingent on Theme 3/11 deleting `'unsafe-inline'` from Helmet. Future CSP audits must verify the live response header, not just the nonce coverage. |
| 2026-04-30 | Added "production infrastructure providers" reference table | Email transport migrated from Gmail SMTP / nodemailer to Resend; future audits should not flag SMTP_* env vars or nodemailer config as expected |
