// tests/core/case-draft-flow.test.js
//
// CASE-FLOW REBUILD 2026-08-25 — contract guard for the server-backed draft.
//
// Source-grep + SQL-shape, in the house style. No DB, no boot.
//
// WHY THIS FILE EXISTS. The draft router is the first thing that writes the
// SAME orders row from two different surfaces, and several of its invariants
// fail SILENTLY rather than loudly:
//
//   * Get the mount order wrong and every draft request 404s as "case not
//     found", because cases.js owns GET '/:id' and matches 'draft' as an id.
//   * Compare `status = 'DRAFT'` instead of UPPER(...) and the app simply
//     cannot see drafts the web wizard wrote. Postgres comparison is
//     case-sensitive and this column is written in both cases across the
//     codebase.
//   * Write pricing.totalPrice into display_price and a VIP order renders at
//     base x 1.3 x 1.3 — a 69% overstatement of what the patient is told they
//     paid, against a correct charge.
//   * Drop the file check from submit and the "documents required" rule
//     becomes advisory, because a client can call submit directly.
//
// None of those throw. Each one is a grep away from being caught.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// Strip comments before any assertion that is about CODE.
//
// Learned the hard way, twice in this codebase: a grep for a forbidden literal
// happily matches the comment EXPLAINING why the literal is forbidden, and the
// "fix" is then to make the explanation worse. (The same trap took out
// anthropic-model-centralisation earlier this month.) Scanning code only means
// a comment can quote whatever it needs to quote.
//
// Walks the source once, tracking string, template and regex-literal context so
// a '//' inside 'https://...' is not mistaken for a comment.
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;      // "'" | '"' | '`' when inside a string
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next === undefined ? '' : next; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;                                   // newline itself is kept below
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';        // preserve line numbering
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

console.log('\n📝 Case-flow rebuild — server-backed draft contract\n');

const ROOT = path.join(__dirname, '..', '..');
const DRAFT = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', 'cases_draft.js'), 'utf8');
const CASES = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', 'cases.js'), 'utf8');
const APIV1 = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api_v1.js'), 'utf8');
const PRICING = fs.readFileSync(path.join(ROOT, 'src', 'services', 'case_intake_pricing.js'), 'utf8');
const REF = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'reference.js'), 'utf8');

// Comment-free views, for the assertions that must not be fooled by prose.
const DRAFT_CODE = stripComments(DRAFT);
const CASES_CODE = stripComments(CASES);

// ── 1. Mount order ──────────────────────────────────────────────────────────
// The single most destructive way to break this router, and the least visible:
// every draft call answers "case not found" and the app looks like it has no
// backend at all.
try {
  const draftMount = APIV1.indexOf("router.use('/cases/draft'");
  const casesMount = APIV1.search(/router\.use\('\/cases',\s*casesRoutes\)/);
  expect(draftMount !== -1, "api_v1.js must mount '/cases/draft'");
  expect(casesMount !== -1, "api_v1.js must mount '/cases'");
  expect(draftMount < casesMount,
    "'/cases/draft' MUST be mounted before '/cases' — cases.js owns GET '/:id' and " +
    "would match 'draft' as a case id, 404ing every draft request");
  t.pass("mount order: '/cases/draft' precedes '/cases' in api_v1.js");
} catch (e) { t.fail('mount order', e); }

// ── 2. Case-insensitive DRAFT matching on every read ────────────────────────
// The app writes 'DRAFT'; so does the wizard. But this codebase has a live
// history of the same status column being written in both cases (see
// tests/lint/status-comparisons-fold-case), and a bare equality here means the
// two surfaces silently cannot see each other's drafts — the exact failure
// this router was built to end.
try {
  const bare = DRAFT_CODE.match(/status\s*=\s*'DRAFT'/g) || [];
  expect(bare.length === 0,
    'found ' + bare.length + " bare `status = 'DRAFT'` comparison(s) — use " +
    "UPPER(COALESCE(status, '')) = 'DRAFT' so a row written in the other case is still found");
  const folded = DRAFT_CODE.match(/UPPER\(COALESCE\(status, ''\)\)\s*=\s*'DRAFT'/g) || [];
  expect(folded.length >= 5,
    'expected the case-folded DRAFT guard on every draft read/write; found ' + folded.length);
  t.pass('every DRAFT comparison folds case (' + folded.length + ' sites, 0 bare equalities)');
} catch (e) { t.fail('DRAFT case folding', e); }

// ── 3. Ownership is proven, not assumed ─────────────────────────────────────
try {
  expect(/WHERE id = \$1 AND patient_id = \$2/.test(DRAFT),
    'loadOwnedDraft must scope by BOTH order id and patient_id');
  // 404 rather than 403 on someone else's draft, so the API cannot be used to
  // enumerate which order ids exist.
  const notFound = DRAFT.match(/res\.fail\('Draft not found', 404, 'NOT_FOUND'\)/g) || [];
  expect(notFound.length >= 6,
    'every :id route must answer a missing OR foreign draft with the same 404; found ' + notFound.length);
  t.pass('ownership scoped by (id, patient_id); missing and foreign drafts are indistinguishable 404s');
} catch (e) { t.fail('draft ownership', e); }

// ── 4. Uploaded file keys are pinned to the caller's own R2 folder ──────────
// Shape alone is not enough: 'orders/draft/<someone else>/scan.png' is a
// perfectly well-shaped key belonging to another patient.
try {
  expect(/\^orders\\\/draft\\\/\[A-Za-z0-9_-\]\+\\\/\[A-Za-z0-9_\.-\]\+\$/.test(DRAFT),
    'file attach must pin the R2 key shape (forbids path traversal)');
  expect(/key\.split\('\/'\)\[2\]\s*!==\s*String\(req\.user\.id\)/.test(DRAFT),
    "file attach must verify the key sits in THIS patient's folder — shape alone lets a " +
    "caller attach another patient's scan to their own case");
  t.pass("R2 key is validated for shape AND for ownership of the containing folder");
} catch (e) { t.fail('R2 key ownership', e); }

// ── 5. Documents required — enforced where it is binding ────────────────────
// documents-done is the UX gate. submit is the one that actually holds: a
// client can call submit directly, and a file can be deleted between the two.
try {
  const needsFiles = DRAFT.match(/'NEEDS_FILES'/g) || [];
  expect(needsFiles.length >= 2,
    'the at-least-one-document rule must be enforced at BOTH documents-done and submit; ' +
    'found ' + needsFiles.length + ' site(s). Client-side enforcement is not enforcement.');
  const submitIdx = DRAFT.indexOf("router.post('/:id/submit'");
  expect(submitIdx !== -1, 'submit route must exist');
  const submitBody = DRAFT.slice(submitIdx);
  expect(/files\.length === 0/.test(submitBody),
    'submit must re-check the file count itself, not trust that documents-done ran');
  t.pass('documents-required enforced at documents-done AND independently at submit');
} catch (e) { t.fail('documents required', e); }

// ── 6. Submit is idempotent under a double tap ──────────────────────────────
try {
  const submitBody = DRAFT.slice(DRAFT.indexOf("router.post('/:id/submit'"));
  expect(/UPDATE orders[\s\S]+?WHERE id = \$15 AND patient_id = \$16[\s\S]{0,200}?UPPER\(COALESCE\(status, ''\)\) = 'DRAFT'/.test(submitBody),
    'the submit UPDATE must re-assert DRAFT in its WHERE clause, so a second submit ' +
    'updates nothing instead of re-pricing a live case');
  expect(/alreadySubmitted:\s*true/.test(submitBody),
    'a lost race must report the case that already exists, not invent a failure');
  t.pass('submit re-validates DRAFT in the UPDATE and reports an already-submitted case honestly');
} catch (e) { t.fail('submit idempotency', e); }

// ── 7. display_price is the LOCAL BASE, un-multiplied ───────────────────────
// The expensive one. Both readers (patient pay page, payment-success receipt)
// re-derive the tier multiplier as (price / base_price) and apply it at RENDER
// time, so pre-multiplying here shows a VIP patient base x 1.3 x 1.3.
try {
  const submitBody = DRAFT.slice(DRAFT.indexOf("router.post('/:id/submit'"));
  expect(/intake\.charge\.displayPrice/.test(submitBody),
    'display_price must be written from charge.displayPrice');
  expect(!/display_price[\s\S]{0,80}pricing\.totalPrice/.test(submitBody),
    'display_price must NEVER be written from pricing.totalPrice — both readers re-apply ' +
    'the tier multiplier at render time, so this renders a VIP order at base x 1.3 x 1.3');
  t.pass('display_price written un-multiplied from charge.displayPrice');
} catch (e) { t.fail('display_price contract', e); }

// ── 8. A price mutation kills any stale payment link ────────────────────────
try {
  const submitBody = DRAFT.slice(DRAFT.indexOf("router.post('/:id/submit'"));
  expect(/paymob_intention_id = NULL/.test(submitBody) && /payment_link = NULL/.test(submitBody),
    'the submit UPDATE mutates price and must therefore null paymob_intention_id and ' +
    'payment_link, or a patient who changed service checks out at the OLD amount');
  t.pass('submit nulls paymob_intention_id + payment_link alongside the price');
} catch (e) { t.fail('stale payment link', e); }

// ── 9. ONE pricing path ─────────────────────────────────────────────────────
// The reason the shared module exists. AUDIT-APP-H1 was two copies drifting;
// this asserts there is no third.
try {
  expect(/resolveAndPriceIntake/.test(CASES),
    'POST /cases must price through services/case_intake_pricing');
  expect(/resolveAndPriceIntake/.test(DRAFT),
    'draft submit must price through services/case_intake_pricing');
  expect(!/egpChargeFromLocal/.test(CASES),
    'cases.js must not convert currency itself any more — that lives in the shared module');
  expect(!/egpChargeFromLocal/.test(DRAFT),
    'cases_draft.js must not convert currency itself — one pricing path, no exceptions');
  expect(/computeOrderPricing/.test(PRICING),
    'the shared module must apply the urgency uplift (AUDIT-APP-H1: the app path once did not)');
  t.pass('both case-birth paths price through the one shared intake module');
} catch (e) { t.fail('single pricing path', e); }

// ── 10. Case references come from a sequence, not a dice roll ───────────────
try {
  expect(/nextval\(/.test(REF),
    'reference generation must be sequence-backed');
  expect(!/Math\.floor\(Math\.random\(\) \* 999999\)/.test(CASES_CODE),
    'cases.js must no longer mint references from Math.random — reference_id has only a ' +
    'plain index (migration 043), so a collision silently gives two cases the same ' +
    'patient-facing number');
  t.pass('references are sequence-backed; the random generator is gone from cases.js');
} catch (e) { t.fail('reference generation', e); }

// ── 11. The classifier is fired, and its failure never blocks the patient ───
try {
  const doneIdx = DRAFT.indexOf("router.post('/:id/documents-done'");
  expect(doneIdx !== -1, 'documents-done route must exist');
  const doneBody = DRAFT.slice(doneIdx, DRAFT.indexOf("router.get('/:id/classification'"));
  expect(/enqueueSpecialtyClassify/.test(doneBody),
    'documents-done must enqueue the specialty classifier — this is what makes the AI ' +
    'suggestion ready by the time the patient reaches step 3');
  expect(/CLASSIFIER_ASYNC/.test(doneBody),
    'must honour the same CLASSIFIER_ASYNC rollback switch as the web wizard, so one env ' +
    'var moves BOTH surfaces');
  expect(/runClassification/.test(doneBody),
    'the inline fallback must call the same runClassification the worker does');
  expect(/logErrorToDb/.test(doneBody),
    'a classifier failure must be logged and swallowed — step 3 falls back to the plain grid');
  t.pass('documents-done enqueues the classifier, shares the rollback switch, and never blocks on it');
} catch (e) { t.fail('classifier wiring', e); }

// ── 12. Overriding the AI is recorded, and costs the SLA refund ─────────────
// Both halves matter. The row is the learner's training signal; the flag is a
// real consequence the patient must be told about before they override.
try {
  const submitBody = DRAFT.slice(DRAFT.indexOf("router.post('/:id/submit'"));
  expect(/INSERT INTO specialty_classification_overrides/.test(submitBody),
    'an override must be recorded — it is both the audit trail and the learner training signal');
  expect(/ai_specialty_id, ai_service_id[\s\S]{0,120}patient_specialty_id, patient_service_id/.test(submitBody),
    'the override row must capture BOTH dimensions of AI pick vs patient pick');
  expect(/no_sla_refund_eligibility = true/.test(submitBody),
    'overriding the AI forfeits SLA refund eligibility, exactly as the web wizard sets it');
  expect(/'OVERRIDE_NOT_PERMITTED'/.test(submitBody),
    'above the lock threshold a mismatched pair is a forged or stale client and must be refused');
  t.pass('overrides recorded on both dimensions, forfeit SLA refund, and are refused above the lock threshold');
} catch (e) { t.fail('override audit', e); }

// ── 13. Drafts read through orders_active ──────────────────────────────────
try {
  const bareReads = DRAFT_CODE.match(/FROM orders\b(?!_active)/g) || [];
  expect(bareReads.length === 0,
    'found ' + bareReads.length + " read(s) from bare `orders` — a soft-deleted draft must " +
    'not be resumable, or the submit path prices and charges for a case an operator removed');
  t.pass('every draft read goes through orders_active (soft-deleted drafts stay deleted)');
} catch (e) { t.fail('orders_active reads', e); }
