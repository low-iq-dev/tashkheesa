// tests/core/e2e-lock-quote-summary.test.js
//
// E2E fixes 2026-10-06 — contract guard for E2E_CONTRACT.md items 1, 2, 3, 6
// and the submitted_at stamp. Source-grep + pure-function, in the house style.
// No DB, no boot.
//
// WHY THIS FILE EXISTS. Every rule below fails QUIETLY if it regresses:
//
//   * Put the service back into the lock and a confidently classified case can
//     be bought as exactly one service — the picker 409s, nothing logs.
//   * Gate the web override block on the form's hidden `override` field again
//     and the specialty lock is skipped by leaving the field at 0.
//   * Name orders.submitted_at through the orders_active alias, or without the
//     column probe, and safeAll swallows the 42703: every patient sees an
//     empty case list and nothing pages.
//   * Count a submitted-but-unpaid case as "active" and the dashboard tells a
//     patient something is in progress that nobody has been paid to start.
//   * Mount /summary under /:id and it answers "Case not found".

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

function expect(cond, msg) { if (!cond) throw new Error(msg); }

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// Line comments and EJS/JS block comments out, so an assertion about CODE
// cannot be satisfied (or tripped) by the comment explaining it. Deliberately
// simple: it only drops whole-line `//` comments and `--` SQL comment lines,
// which is how this codebase writes them, and leaves strings alone.
function code(src) {
  return src.split('\n').filter(function (l) {
    const s = l.trim();
    return !(s.startsWith('//') || s.startsWith('--') || s.startsWith('*') || s.startsWith('/*'));
  }).join('\n');
}

const DRAFT = code(read('src/routes/api/cases_draft.js'));
const CASES = code(read('src/routes/api/cases.js'));
const PATIENT = code(read('src/routes/patient.js'));
const VIEW = read('src/views/patient_new_case.ejs');
const HELPER_SRC = code(read('src/services/orders_submitted_at.js'));

function between(src, startNeedle, endNeedle) {
  const a = src.indexOf(startNeedle);
  expect(a !== -1, 'could not find ' + JSON.stringify(startNeedle));
  const b = endNeedle ? src.indexOf(endNeedle, a + startNeedle.length) : -1;
  return b === -1 ? src.slice(a) : src.slice(a, b);
}

console.log('\nE2E 2026-10-06 — lock, list payload, quote, summary, submitted_at\n');

// ── 1. API submit: the lock is the specialty ────────────────────────────────
try {
  const submit = between(DRAFT, "router.post('/:id/submit'");
  const upTo409 = submit.slice(0, submit.indexOf("'OVERRIDE_NOT_PERMITTED'"));
  const guard = upTo409.slice(upTo409.lastIndexOf('if (specialtyMismatch'));
  expect(/^if \(specialtyMismatch\) \{/.test(guard),
    'the 409 must sit inside `if (specialtyMismatch) {` — not `specialtyMismatch || serviceMismatch`');
  expect(/confidence\) >= lockThreshold/.test(guard),
    'and only at or above the live lock threshold');
  expect(!/serviceMismatch/.test(guard),
    'the service must play no part in the decision to refuse');
  const msg = /res\.fail\(\s*'([^']+)',\s*409, 'OVERRIDE_NOT_PERMITTED'/.exec(submit);
  expect(msg && /specialty/i.test(msg[1]) && /service/i.test(msg[1]),
    'the 409 text must say the SPECIALTY is locked and that any service within it may be chosen');
  t.pass('API submit refuses a different specialty above the lock, and only that');
} catch (e) { t.fail('API lock = specialty only', e); }

// ── 2. API submit: a service-only override is recorded and keeps the refund ──
try {
  const submit = between(DRAFT, "router.post('/:id/submit'");
  const audit = between(submit, 'if (specialtyMismatch || serviceMismatch) {', '} catch (err) {');
  expect(/INSERT INTO specialty_classification_overrides/.test(audit),
    'a service-only difference must still be inserted into specialty_classification_overrides');
  const flag = audit.indexOf('no_sla_refund_eligibility = true');
  expect(flag !== -1, 'a specialty override must still forfeit the on-time refund');
  const before = audit.slice(0, flag);
  expect(/if \(specialtyMismatch\) \{\s*await execute\(\s*`UPDATE orders SET $/.test(before),
    'no_sla_refund_eligibility must be set ONLY inside `if (specialtyMismatch)` — a ' +
    'service-only change keeps the case with the AI-routed doctors and forfeits nothing');
  expect(before.indexOf('INSERT INTO specialty_classification_overrides') <
         before.lastIndexOf('if (specialtyMismatch) {'),
    'the audit insert must not be inside the specialty-only branch');
  t.pass('service-only override: audited, refund eligibility untouched');
} catch (e) { t.fail('API service-only override', e); }

// ── 3. Web wizard: same rule, and the hidden field decides nothing ──────────
try {
  const step3 = between(PATIENT, "router.post('/patient/new-case/step3'", "\nrouter.");
  expect(!/req\.body\.override/.test(step3) && !/isOverride/.test(step3),
    'step 3 must not read the client-sent `override` field — a forged form that leaves it ' +
    'at 0 skipped the whole locked-tier defense');
  expect(/FROM specialty_classifications/.test(step3),
    'the mismatch must be computed server-side from the classification row');
  const upToRedirect = step3.slice(0, step3.indexOf('err=override_not_permitted'));
  const guard = upToRedirect.slice(upToRedirect.lastIndexOf('if ('));
  expect(/^if \(specialtyMismatch && lockThreshold != null &&\s*Number\(classRow\.confidence\) >= lockThreshold\) \{/.test(guard),
    'the override_not_permitted redirect must be guarded by specialty mismatch + lock threshold only');
  expect(!/serviceMismatch/.test(guard), 'the service must not be part of the web lock');
  // The lock check must not be nested in any client-controlled condition:
  // between the classification lookup and the redirect there is no `if` that
  // mentions the request body.
  const fromLookup = upToRedirect.slice(upToRedirect.indexOf('FROM specialty_classifications'));
  expect(!/if \([^)]*req\.body/.test(fromLookup),
    'nothing between the classification lookup and the lock may branch on req.body');

  const audit = between(step3, 'if (recommendationWasShown && (specialtyMismatch || serviceMismatch)) {', '} catch (err) {');
  expect(/INSERT INTO specialty_classification_overrides/.test(audit),
    'web: a service-only difference is recorded');
  const flag = audit.indexOf('no_sla_refund_eligibility = true');
  expect(flag !== -1 && /if \(specialtyMismatch\) \{\s*await execute\(\s*`UPDATE orders SET $/.test(audit.slice(0, flag)),
    'web: refund eligibility is removed only for a specialty change');
  t.pass('web step 3: lock computed server-side on the specialty; forged override flag is irrelevant');
} catch (e) { t.fail('web lock', e); }

// ── 4. Web view: locked tier fixes the specialty, offers its services ───────
try {
  const card = /id="step3-services-card" style="([^"]*)"/.exec(VIEW);
  expect(card, 'services card not found');
  expect(!/__tier !== 'locked'/.test(card[1]),
    'the services card must no longer be hidden for the locked tier');
  expect(/__tier === 'locked'\) \? __defaultSpecialty : selectedSpecialty/.test(card[1]),
    'for a locked classification the card shows the AI specialty\'s services from first render');
  const locked = between(VIEW, "<% if (__tier === 'locked') { %>", "<% } else if (__tier === 'auto'");
  expect(!/__recServiceName/.test(locked) && !/__recServicePrice/.test(locked),
    'the locked card must not present the AI service as a fixed line now that it is a choice');
  expect(!/step3-override-grid|p-spec-card/.test(locked),
    'the locked tier must still offer no way to change specialty');
  const errCopy = between(VIEW, "step3Err === 'override_not_permitted'", '<% } else if');
  expect(/specialty can’t be changed/.test(errCopy) && /any service within it/.test(errCopy) &&
         /لا يمكن تغيير التخصص/.test(errCopy),
    'the override_not_permitted notice must talk about the specialty, in both languages');
  t.pass('locked tier: specialty fixed, services selectable, copy accurate in EN and AR');
} catch (e) { t.fail('locked-tier view', e); }

// ── 5. List + detail payload ────────────────────────────────────────────────
try {
  const list = between(CASES, "router.get('/', [", "router.get('/summary'");
  ['"submittedAt"', '"paymentStatus"', '"paymentClaimPending"'].forEach(function (f) {
    expect(list.indexOf(' as ' + f) !== -1, 'GET /cases must project ' + f);
  });
  expect(/ORDER BY \$\{SUBMITTED_AT_SQL\} DESC/.test(list),
    'the list must be ordered by submission time, newest first');
  expect(/PAYMENT_STATUS_SQL = `LOWER\(/.test(CASES), 'paymentStatus must be lower-cased');
  expect(/FROM payment_claims pc\s+WHERE pc\.order_id = o\.id AND pc\.status = 'pending'/.test(CASES),
    'paymentClaimPending = a pending payment_claims row exists for the order');

  const detail = between(CASES, "router.get('/:id', async", "router.post('/', [");
  expect(/\$\{SUBMITTED_AT_SQL\} as "submittedAt"/.test(detail), 'detail must return submittedAt');
  expect(/\$\{PAYMENT_CLAIM_PENDING_SQL\} as "paymentClaimPending"/.test(detail),
    'detail must return paymentClaimPending');
  expect(/caseData\.paymentStatus = String\([^;]+\)\.toLowerCase\(\)/.test(detail),
    'detail paymentStatus must be lower-cased');

  const cancel = between(CASES, "router.post('/:id/cancel'", "router.get('/:id/payment'");
  expect(/resolveSubmittedAtSql\(\)/.test(cancel) && /submitted_at_resolved/.test(cancel),
    'the cancel window must run on the same submission clock as the list and detail');
  t.pass('list and detail carry paymentStatus / submittedAt / paymentClaimPending; list sorted by submission');
} catch (e) { t.fail('list/detail payload', e); }

// ── 6. submitted_at is read safely ──────────────────────────────────────────
try {
  const h = require(path.join(ROOT, 'src/services/orders_submitted_at.js'));
  const withCol = h.submittedAtSql(true, 'o');
  const without = h.submittedAtSql(false, 'o');
  expect(/SELECT ob\.submitted_at FROM orders ob WHERE ob\.id = o\.id AND ob\.deleted_at IS NULL\)/.test(withCol),
    'the column must be read from the BASE table by id — orders_active freezes its column ' +
    'list and may not carry a new column');
  expect(!/\bo\.submitted_at\b/.test(withCol),
    'never o.submitted_at: `o` is orders_active in every caller');
  expect(!/submitted_at\b(?!_)/.test(without.replace(/'submitted'/g, '')),
    'without the column the expression must not name it at all');
  [withCol, without].forEach(function (sql) {
    expect(/order_timeline/.test(sql) && /o\.created_at\)\s*$/.test(sql),
      'both forms fall back to the timeline row and finally created_at');
  });
  expect(withCol.indexOf('ob.submitted_at') < withCol.indexOf('order_timeline'),
    'the stamp leads the COALESCE');
  expect(h.submittedAtSetClause(false) === '', 'no column, no SET fragment');
  expect(h.submittedAtSetClause(true) === 'submitted_at = COALESCE(submitted_at, NOW()),',
    'the stamp is COALESCE(submitted_at, NOW()) so it can never be overwritten');
  expect(/information_schema\.columns/.test(HELPER_SRC),
    'the column must be probed, because safeAll would turn a 42703 into an empty case list');
  expect(!/\bo\.submitted_at\b/.test(CASES) && !/\bo\.submitted_at\b/.test(DRAFT),
    'no route may name o.submitted_at directly');
  t.pass('submitted_at is probed, read from the base table, and falls back to timeline then created_at');
} catch (e) { t.fail('submitted_at reader', e); }

// ── 7. submitted_at is stamped at submit, and only there ────────────────────
try {
  const submit = between(DRAFT, "router.post('/:id/submit'");
  const upd = between(submit, '`UPDATE orders\n          SET reference_id', '`,');
  expect(/\$\{submittedAtSet\}/.test(upd),
    'API submit must stamp submitted_at inside the DRAFT -> submitted UPDATE');
  expect(/UPPER\(COALESCE\(status, ''\)\) = 'DRAFT'/.test(upd),
    'and that UPDATE must still re-assert DRAFT, so it matches once, at the transition');
  expect(/submittedAtSetClause\(await hasSubmittedAtColumn\(\)\)/.test(submit),
    'the fragment comes from the probed helper');
  const draftRest = DRAFT.replace(submit, '');
  expect(!/\$\{submittedAtSet\}|submitted_at =/.test(draftRest),
    'no other draft route (patch, files, documents-done) may write submitted_at');

  const step5 = between(PATIENT, "router.post('/patient/new-case/step5'", "\nrouter.");
  const afterSubmit = step5.slice(step5.indexOf('caseLifecycle.submitCase(orderId)'));
  expect(/SET submitted_at = COALESCE\(submitted_at, NOW\(\)\)/.test(afterSubmit),
    'web step 5 must stamp submitted_at right after submitCase');
  expect(/hasSubmittedAtColumn\(\)/.test(afterSubmit), 'web stamp must be column-probed');
  const patientRest = PATIENT.replace(step5, '');
  expect(!/SET submitted_at/.test(patientRest),
    'no other web handler may write submitted_at');

  const create = between(CASES, "router.post('/', [", "router.post('/:id/cancel'");
  expect(/UPDATE orders SET submitted_at = COALESCE\(submitted_at, NOW\(\)\) WHERE id = \$1 AND patient_id = \$2/.test(create) &&
         /if \(await hasSubmittedAtColumn\(\)\)/.test(create),
    'POST /cases creates the case already submitted, so it stamps straight after the INSERT');
  expect((CASES.match(/SET submitted_at/g) || []).length === 1,
    'no other case route (cancel, payment, review) may write submitted_at');
  t.pass('submitted_at stamped by API submit, web step 5 and POST /cases — nowhere else');
} catch (e) { t.fail('submitted_at stamp', e); }

// ── 8. Quote ────────────────────────────────────────────────────────────────
try {
  expect(/router\.get\('\/:id\/quote'/.test(DRAFT), 'GET /cases/draft/:id/quote must exist');
  const quote = between(DRAFT, "router.get('/:id/quote'", "router.post('/:id/submit'");
  expect(/loadOwnedDraft\(req\.params\.id, req\.user\.id\)/.test(quote) &&
         /'Draft not found', 404/.test(quote),
    'quote must be ownership-checked like every other draft route, 404 for not-yours');
  expect(/409, 'QUOTE_NOT_READY'/.test(quote), 'no service chosen yet -> 409 QUOTE_NOT_READY');
  expect(/priceDraftIntake\(/.test(quote), 'quote must price through priceDraftIntake');
  expect(/failFromError\(/.test(quote),
    'IntakeErrors (URGENT_UNAVAILABLE etc.) must surface with the same code submit uses');
  ['serviceId', 'serviceName', 'serviceNameAr', 'urgencyTier', 'amount', 'currency',
   'displayAmount', 'displayCurrency'].forEach(function (k) {
    expect(new RegExp('\\b' + k + ':').test(quote), 'quote response is missing ' + k);
  });
  expect(!/execute\(/.test(quote), 'quote is read-only');

  const helper = between(DRAFT, 'async function priceDraftIntake', "router.get('/:id/quote'");
  expect(/resolveAndPriceIntake\(/.test(helper), 'priceDraftIntake must call resolveAndPriceIntake');
  expect(/chargedTotalEgp: intake\.pricing\.totalPrice/.test(helper),
    'the charged total is pricing.totalPrice (base + tier uplift)');
  const submit = between(DRAFT, "router.post('/:id/submit'");
  expect(/priceDraftIntake\(/.test(submit) && !/resolveAndPriceIntake\(/.test(submit),
    'submit must price through the SAME helper, not its own call');
  expect(/intake\.charge\.egpBase, chargedTotalEgp, intake\.pricing\.upliftAmount/.test(submit),
    'and write that same total to orders.price — the figure GET /cases/:id/payment reports');
  expect((DRAFT.match(/resolveAndPriceIntake\(/g) || []).length === 1,
    'exactly one resolveAndPriceIntake call in the draft router');
  t.pass('quote route: owned, QUOTE_NOT_READY, same pricing call and same total as submit');
} catch (e) { t.fail('quote', e); }

// ── 9. Summary ──────────────────────────────────────────────────────────────
try {
  const iSummary = CASES.indexOf("router.get('/summary'");
  const iDetail = CASES.indexOf("router.get('/:id', async");
  expect(iSummary !== -1, 'GET /cases/summary must exist');
  expect(iSummary < iDetail, "/summary must be defined before '/:id' or it is read as a case id");

  const sum = between(CASES, "router.get('/summary'", "router.get('/:id', async");
  expect(/dbStatusValuesFor/.test(sum) && /CASE_STATUS\./.test(sum),
    'status spellings must come from case_lifecycle, not a second hand-written list');
  expect((sum.match(/COUNT\(\*\) FILTER/g) || []).length === 5 && (sum.match(/\bFROM\b/g) || []).length === 1,
    'one query: COUNT(*) plus five COUNT(*) FILTER buckets over a single FROM');
  expect(/FROM orders_active o\s+WHERE o\.patient_id = \$1 AND o\.deleted_at IS NULL\s+AND NOT \(\$\{ST\} = ANY\(\$2::text\[\]\)\)/.test(sum),
    "scoped to the patient's non-deleted, non-draft cases");
  expect(/drafts = variants\(CASE_STATUS\.DRAFT\)/.test(sum), '$2 is the DRAFT variants');
  expect(/COUNT\(\*\)::int AS total/.test(sum),
    'total is the unfiltered count, so cancelled / expired / refunded are in it');
  expect(/AWAITING_PAYMENT = `\(\$\{ST\} = ANY\(\$3::text\[\]\) AND \$\{UNPAID\}\)`/.test(sum),
    'awaitingPayment = submitted AND unpaid');
  expect(/WHERE NOT \$\{AWAITING_PAYMENT\} AND NOT \$\{TERMINAL\}\)::int AS active/.test(sum),
    'active must EXCLUDE awaitingPayment and every completed/closed case');
  expect(/NOT \$\{AWAITING_PAYMENT\} AND NOT \$\{TERMINAL\}\s+AND \$\{ST\} = ANY\(\$6::text\[\]\)\)::int AS "awaitingReport"/.test(sum),
    'awaitingReport is a subset of active');
  expect(/closed = variants\(CASE_STATUS\.CANCELLED, CASE_STATUS\.EXPIRED_UNPAID, CASE_STATUS\.REFUNDED\)/.test(sum),
    'closed = cancelled + expired_unpaid + refunded');
  ['total', 'active', 'awaitingPayment', 'awaitingReport', 'completed', 'closed'].forEach(function (k) {
    expect(new RegExp('\\b' + k + ': n\\(').test(sum), 'summary response is missing ' + k);
  });
  expect(!/safeGet\(/.test(sum),
    'summary must not use safeGet — a swallowed failure would report six zeros');

  // The variants the handler will actually send, checked against the lifecycle.
  const { CASE_STATUS, dbStatusValuesFor } = require(path.join(ROOT, 'src/case_lifecycle.js'));
  const lower = function (c) { return dbStatusValuesFor(c).map(function (v) { return String(v).toLowerCase(); }); };
  expect(lower(CASE_STATUS.SUBMITTED).indexOf('submitted') !== -1 && lower(CASE_STATUS.SUBMITTED).indexOf('new') !== -1,
    "SUBMITTED variants must cover 'submitted' and 'new' (both are written by submit paths)");
  expect(lower(CASE_STATUS.EXPIRED_UNPAID).indexOf('expired_unpaid') !== -1, 'expired_unpaid is a closed status');
  expect(lower(CASE_STATUS.DRAFT).indexOf('draft') !== -1, 'drafts are excluded by variant');
  t.pass('summary: defined before /:id, one query, unpaid-submitted is awaitingPayment not active, drafts out, cancelled in total');
} catch (e) { t.fail('summary', e); }

console.log('');
