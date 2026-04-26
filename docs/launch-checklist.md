# Patient Portal v2 — Pre-Launch Checklist

**Use this document to flip the wizard from stub mode → live Paymob in production.** Walk it line by line; do not skip steps. Each item is here because something would break silently in production if missed. Compiled during the v2 migration while context was fresh.

The wizard is feature-complete and stable in stub mode (`PAYMOB_LIVE_PAYMENTS=false`). Going live = the items below.

---

## Phase A — Data integrity (run before touching any env vars)

### A.1 Every active service has a Paymob payment link

The wizard's Step 5 hands off to `services.payment_link` for live payments. Any active service without a payment_link will infinite-redirect through the internal fallback when a patient tries to pay.

```sql
SELECT id, name
FROM services
WHERE COALESCE(is_visible, true) = true
  AND (payment_link IS NULL OR TRIM(payment_link) = '');
```

**Expected: zero rows.** If any rows return, either populate the column with the Paymob hosted-checkout URL or hide the service (`is_visible=false`) until you have one.

### A.2 Specialty has at least one active doctor

Step 3 of the wizard filters out specialties without active doctors at the query level. Verify the filter is producing the expected list.

```sql
SELECT s.id, s.name,
       COUNT(u.id) FILTER (WHERE u.role='doctor' AND COALESCE(u.is_active, true)) AS active_doctors
FROM specialties s
LEFT JOIN users u ON u.specialty_id = s.id
WHERE COALESCE(s.is_visible, true) = true
GROUP BY s.id, s.name
ORDER BY active_doctors DESC, s.name ASC;
```

**Expected: the specialties you want patients to see have ≥1 active doctor.** If a specialty you intended to launch with shows 0 active doctors, either onboard the doctor or hide the specialty.

### A.3 No orphan DRAFT rows from migration backfill

Migration `021_orders_draft_step.sql` backfilled `draft_step` from inference. Verify nothing got stuck mid-flight.

```sql
SELECT COUNT(*) AS draft_step_zero
FROM orders
WHERE UPPER(COALESCE(status, '')) = 'DRAFT'
  AND COALESCE(draft_step, 0) = 0
  AND COALESCE(updated_at, created_at) > NOW() - INTERVAL '30 days';
```

**Expected: zero or near-zero.** A non-zero result means there are recent DRAFT rows the backfill couldn't infer a step for — these patients will land on Step 1 instead of where they left off. Acceptable for a small number; investigate if > 5.

### A.4 Service regional pricing covers the markets you care about

The Step 4/5 dual-currency display falls back to EGP when no regional row exists. Saudi patients with no SAR row will see EGP as their primary currency.

```sql
SELECT s.id, s.name,
       COUNT(DISTINCT srp.country_code) AS country_count,
       STRING_AGG(DISTINCT srp.country_code, ', ' ORDER BY srp.country_code) AS countries
FROM services s
LEFT JOIN service_regional_prices srp
  ON srp.service_id = s.id AND COALESCE(srp.status, 'active') = 'active'
WHERE COALESCE(s.is_visible, true) = true
GROUP BY s.id, s.name
ORDER BY country_count ASC;
```

**Expected: every service has rows for the countries you sell into.** EG should always be present; SA / AE / KW / etc. depending on your launch geography.

---

## Phase B — Paymob dashboard configuration

### B.1 Update each payment link's "Redirect URL"

In the Paymob merchant dashboard, for **every active service's payment link**:

- **Redirect URL** (the URL the patient's browser is sent to after payment):
  ```
  https://tashkheesa.com/portal/patient/payment-return
  ```
- **Webhook URL** (server-to-server callback — should already be set):
  ```
  https://tashkheesa.com/payments/callback
  ```

Both URLs are wired and tested. The redirect URL is generic — Paymob will append the order identifier as a query parameter, which the wizard's defensive handler accepts (any of `merchant_order_id` / `order` / `order_id` / `id` / `merchant_order`).

### B.2 Confirm Paymob's redirect query parameter shape

The first time a real Paymob redirect hits `/portal/patient/payment-return`, the route logs the entire query string:

```
[paymob-return] query {"merchant_order_id":"...","success":"true",...}
```

**Run one sandbox transaction. Tail the application logs. Confirm:**
- The handler logged the query
- The `merchant_order_id` (or whichever key Paymob uses) matches `orders.id`
- The success/failure flag (`success` / `status`) is one of the values the normalizer accepts (`true|success|approved|paid|1`)

If Paymob is using a different parameter name not in the defensive list, add it to `routes/patient.js` `/portal/patient/payment-return` handler. The change is one line.

---

## Phase C — Render env configuration

### C.1 Set `PAYMOB_RETURN_URL`

In Render env config:

```
PAYMOB_RETURN_URL=https://tashkheesa.com/portal/patient/payment-return
```

(This var is informational — used for logs and future Intention-API support. The actual redirect destination is set per-payment-link in Paymob dashboard, see B.1.)

### C.2 Verify `PAYMOB_HMAC_SECRET` is still set

```
PAYMOB_HMAC_SECRET=<existing value, do not change>
```

Used by `routes/payments.js` to verify the webhook signature. If it's been rotated since the last deploy, update both Paymob dashboard + Render to match.

### C.3 Set `UPLOADCARE_PUBLIC_KEY` if not already

Wizard Step 2 + Messages tab attachment require this. The wizard renders a defensive "Uploader not configured" warning when missing, but the patient flow is broken without it.

```
UPLOADCARE_PUBLIC_KEY=<your Uploadcare public key>
```

### C.4 Hold `PAYMOB_LIVE_PAYMENTS=true` until B.2 passes

Do NOT flip this until the sandbox transaction in B.2 succeeds end-to-end:
- Patient submits Step 5
- Browser redirects to Paymob hosted form
- Patient completes payment
- Paymob redirects to `/portal/patient/payment-return` with the expected query
- Webhook hits `/payments/callback` with valid HMAC
- `markCasePaid()` runs; `payment_status` flips to `'paid'`
- `paid_at` and `deadline_at` are populated
- Patient lands on `/portal/patient/orders/:id/payment-success` with the paid state

**Once all of those check out:**

```
PAYMOB_LIVE_PAYMENTS=true
```

Restart the app. Live mode is now active.

---

## Phase D — End-to-end verification (with `PAYMOB_LIVE_PAYMENTS=true`)

### D.1 Smoke test as a real patient

Create a fresh test patient account (NOT a dev account with bypass). Walk through:

1. Sign in
2. Hit `/dashboard` — should render the empty state with the "Start your case" CTA
3. Click "Start my case" — Step 1 of the wizard
4. Fill clinical_question (≥10 chars), click Continue
5. Verify a DRAFT row was created in `orders` with `status='DRAFT'` and `draft_step=1`
6. Step 2: drop a real file (PDF or DICOM). Wait for AI validation to complete (`is_valid` flips from null). Click Continue.
7. Step 3: pick a specialty + service. Both must show on the grid.
8. Step 4: review the case, pick a SLA option (try Priority 24h to verify the premium pricing displays correctly), click Continue.
9. Step 5: verify the totals match what Step 4 showed. Click "Pay securely with Paymob". (Live mode only.)
10. Complete payment in Paymob.
11. Verify webhook fires (`tail -f` the logs for `[callback]`).
12. Verify the redirect lands on the post-payment page.
13. Verify the case detail page renders with the limbo treatment.
14. As Mr. Maher (or admin), assign the case to a doctor.
15. Refresh the case detail page — verify the active state surfaces with the doctor card.
16. As the doctor (separate session), open the case, send a message.
17. As the patient, navigate to Case Detail → Messages tab. Verify the doctor's message appears and is marked read.
18. Reply with text. Verify it appears in the doctor's view.
19. Reply with a file attachment. Verify the file appears as a tile inside the message bubble AND in `order_additional_files`.
20. As the doctor, mark the case complete and deliver a report.
21. As the patient, verify the dashboard flips to the report-ready state.
22. Click "Read the report" — verify the V2 report viewer renders all sections.
23. Click "Print" — verify the print preview shows just the report (no chrome).
24. Click "Download PDF" — verify the PDF downloads.

### D.2 Verify language persistence

1. As the test patient, click the language toggle to switch to Arabic.
2. Verify the dashboard re-renders in Arabic with `dir="rtl"`.
3. In a separate query window, verify `users.lang` was updated for that patient ID.
4. Trigger any notification (e.g., have the doctor reply). Verify the Arabic patient receives Arabic copy.

### D.3 Verify privacy invariant

Open the dashboard in browser dev tools. View page source. Search the rendered HTML for:
- `diagnosis_text`
- `impression_text`
- `recommendation_text`

**Expected: zero hits on the dashboard, zero hits on the case-detail page (except when the Report tab is active and the patient owns the report).** The rendered HTML must never contain those strings outside the Report tab.

Also verify the V1 privacy fix: the dashboard's report-ready state contains the doctor's NAME and the delivery TIMESTAMP and a "Read the report" CTA — but no excerpt, no quote, no preview of the report's text content.

### D.4 Run the dashboard DRAFT detection 30-day filter

Manually backdate a DRAFT order's `updated_at` to 60 days ago for a test patient. Visit the dashboard. Verify the "Continue your case" tile does NOT appear (the 30-day filter excluded it).

---

## Phase E — Deployment & monitoring

### E.1 Render deploy

After Phases A–D pass, deploy the migration branch to production. The migration runner picks up `021_orders_draft_step.sql` automatically on boot.

Verify in logs:
```
[migrate] Migration: 021_orders_draft_step.sql
```

### E.2 Watch the first hour

Tail logs for:
- `[wizard] draft_step inference fired post-backfill` — should be silent. If it fires, the backfill missed a row and the inference fallback is doing extra work. Run the backfill manually for affected order IDs.
- `[paymob-return] query` — should fire on every live payment. The query shape is logged for every transaction.
- `[v2-messages] insert failed` — should be silent. If it fires, the messages table contract changed unexpectedly.
- Any 500-class errors from `routes/patient.js`. The patient-themed 500 page renders for the user; the underlying error should be in your error reporting.

### E.3 First-week metrics to watch

- DRAFT-to-SUBMITTED conversion rate per step (drop-offs at Step 1 vs Step 2 vs Step 5 tell different stories)
- Time from DRAFT creation to payment_status='paid'
- Time from payment_status='paid' to status='ASSIGNED' (Mr. Maher's manual assignment latency)
- Limbo dwell time (patients staring at the limbo state — long dwells suggest the assignment flow is slower than expected)
- Report tab open rate after delivery (should be > 90%; lower means the email/WhatsApp notification isn't landing)

---

## Phase F — Live Paymob verification (post-QA, pre-flip)

This is the final gate before the wizard accepts real money. **Do not run Phase F until Phase 7 QA has passed**. Each line is a single discrete step — don't merge them.

- [ ] Obtain Paymob sandbox merchant credentials (account access, public key, HMAC secret).
- [ ] Configure ONE active service's payment link in Paymob sandbox dashboard with redirect URL = `https://tashkheesa.com/portal/patient/payment-return`.
- [ ] Run one full sandbox payment end-to-end (use a sandbox card). Stop right before flipping the env flag.
- [ ] Tail the application log for `[paymob-return] query` — copy the full query string from the log.
- [ ] Verify Paymob's actual redirect query parameter name appears in the defensive handler's accept list (`merchant_order_id` / `order` / `order_id` / `id` / `merchant_order`). If not, add it as a one-line patch.
- [ ] Verify the webhook arrived at `/payments/callback` with valid HMAC.
- [ ] Verify `markCasePaid()` fired and the order's `payment_status` is `'paid'` with non-null `paid_at` and `deadline_at`.
- [ ] Verify the patient landed on `/portal/patient/orders/:id/payment-success` in the paid state (not the interim webhook-pending state).
- [ ] Update each remaining active service's payment link in production Paymob dashboard with the same redirect URL.
- [ ] Set Render env: `PAYMOB_RETURN_URL=https://tashkheesa.com/portal/patient/payment-return`.
- [ ] Set Render env: `PAYMOB_LIVE_PAYMENTS=true`. **Restart the app.**
- [ ] As Ziad: run one real production payment with your own card for ≤ EGP 100 against a temporarily price-reduced service (or a hidden test service).
- [ ] Verify the production payment completed end-to-end: webhook fired, case advanced, post-payment page rendered.
- [ ] Revert the temporary price (or unhide the test service / clean up the test order).
- [ ] Production live. Watch logs.

If anything fails at any line, **flip `WIZARD_AVAILABLE_FROM` to a future timestamp first**, then debug. The kill switch is the rollback.

---

## Tech debt — post-launch cleanup pass

These were flagged across phases as "fix after launch ships." Compile here so they aren't forgotten.

### Dormant code to delete

- `views/patient_order_new.ejs` — superseded by the wizard. No active route renders it.
- `views/patient_order_upload.ejs` — superseded by the wizard's Step 2 + the Messages-tab attachment flow. No active patient route renders it.
- `POST /patient/new-case` (legacy single-shot create handler in `routes/patient.js`) — no view links to it; the wizard uses `/step1` through `/step5`. Safe to delete.
- `POST /patient/orders` (legacy single-shot create handler) — same. The wizard uses different endpoints. Verify no external integration depends on this endpoint before deleting.
- `isPreLaunch` alias in `routes/patient.js` — only the legacy `POST /patient/orders` handler references it. Goes away when that handler does.

### Schema cleanups

- `services.payment_link` is per-service, not per-order. Long-term, consider Paymob Intention API for per-payment redirect URLs (no dashboard config per service).
- `messages.message_type` has no enum constraint. Add `CHECK (message_type IN ('text','file'))` once the doctor portal is updated to handle `'file'`.
- `report_exports` has no `status` column for explicit withdrawal. Today the patient-side derives "withdrawn" from `orders.status` reverting from a completed value. If care team wants to explicitly mark a report as withdrawn without rolling the case status back, add a column.
- `order_additional_files` query in case-detail handler has no LIMIT. Add `LIMIT 100` once we know realistic counts.

### Parallel-design cleanup

- `public/css/portal-variables.css` defines a competing blue palette that doesn't match the warm-cream/teal/brass system. The patient v2 stack (`patient-tokens.css` + `patient-portal-v2.css`) is independent and untouched by this. If the doctor portal is fully on the warm-cream tokens, `portal-variables.css` is dead weight. Audit + delete.

### Pre-launch operational

- The legacy `/portal/patient/alerts` full-page view is still mounted (linked from the dropdown's "View all"). Decide if you want to keep it or replace with a v2 version.
- `auto_assign.js` is currently disabled (Mr. Maher does manual assignment). When auto-assign turns on, the limbo state will compress from "hours to a working day" to "minutes." Update the limbo ETA copy at that point — *"Usually within a few hours during business hours, sometimes longer overnight or on weekends"* would become *"Usually within a few minutes."*

---

## Rollback plan

If anything breaks post-launch and you need to revert the wizard offline:

```
WIZARD_AVAILABLE_FROM=2099-12-31T00:00:00+02:00
```

(Or any future date.) On the next request, the wizard renders `/coming-soon` and patients can't start new cases. Existing cases continue to work — only the wizard entry is gated.

This is the kill switch. Don't remove it.

---

## Sign-off

Before flipping `PAYMOB_LIVE_PAYMENTS=true`:

- [ ] Phase A all passed
- [ ] Phase B both completed
- [ ] Phase C env vars set (except `PAYMOB_LIVE_PAYMENTS` itself)
- [ ] Phase B.2 sandbox transaction logged and verified
- [ ] Phase D.1 end-to-end smoke completed as a real patient
- [ ] Phase D.2 language persistence verified
- [ ] Phase D.3 privacy invariant verified
- [ ] Phase E.1 production deploy succeeded; migration ran
- [ ] Phase E.2 first-hour log watch shows no surprises

Then, and only then:

```
PAYMOB_LIVE_PAYMENTS=true
```

Restart. Watch.
