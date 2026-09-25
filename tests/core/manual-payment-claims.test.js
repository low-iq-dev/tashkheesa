'use strict';
// tests/core/manual-payment-claims.test.js
//
// Manual payment path (InstaPay / bank transfer) — MANUAL_PAY_CONTRACT.md.
//
// THE RULE under test: a patient's transfer claim NEVER sets
// payment_status='paid', never changes status, never calls markCasePaid and
// never triggers auto-assign. Pinned two ways:
//   A. source-grep of every claim code path (service + the two claim routes);
//   B. a recording mock database + a markCasePaid spy driven through the real
//      service and the real API handlers.
// Plus: resubmit updates rather than duplicates; the transfer amount equals
// the card charge (standard / VIP / add-on) — proven against the real Paymob
// mint; GET/POST API shapes and error codes; the superadmin reject/confirm
// flow; config parsing; env documentation; notification registration.
//
// Hermetic: no DB, no network. The service takes its collaborators through
// __setTestDeps (restored at the end); the only require.cache use is a
// synchronous inject-load-restore, as in tests/services/paymob_intention.test.js.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');
function ok(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

console.log('\n🏦 manual payment — claims never move money, API shapes, superadmin flow\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { stripComments } = require('../_helpers/strip-comments');

const ENV_KEYS = [
  'MANUAL_PAYMENT_ENABLED', 'CARD_PAYMENT_ENABLED', 'MANUAL_PAYMENT_INSTAPAY_HANDLE', 'MANUAL_PAYMENT_INSTAPAY_LINK',
  'MANUAL_PAYMENT_BANK_NAME', 'MANUAL_PAYMENT_ACCOUNT_NAME', 'MANUAL_PAYMENT_ACCOUNT_NUMBER', 'MANUAL_PAYMENT_IBAN',
  'MANUAL_PAYMENT_RELATIONSHIP_NOTE_EN', 'MANUAL_PAYMENT_RELATIONSHIP_NOTE_AR',
  'MANUAL_PAYMENT_CONFIRM_NOTE_EN', 'MANUAL_PAYMENT_CONFIRM_NOTE_AR'
];
const savedEnv = {};
ENV_KEYS.forEach(function (k) { savedEnv[k] = process.env[k]; });
function setEnv(obj) {
  ENV_KEYS.forEach(function (k) { delete process.env[k]; });
  Object.keys(obj || {}).forEach(function (k) { process.env[k] = obj[k]; });
}
function restoreEnv() {
  ENV_KEYS.forEach(function (k) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  });
}
const ON = { MANUAL_PAYMENT_ENABLED: 'true', MANUAL_PAYMENT_INSTAPAY_HANDLE: 'tashkheesa@instapay' };

// ── A. Source pins: the claim code paths cannot move money ──────────────────
function between(src, begin, end) {
  const a = src.indexOf(begin);
  const b = src.indexOf(end, a + 1);
  return (a === -1 || b === -1) ? null : src.slice(a, b);
}
const FORBIDDEN = [
  [/payment_status\s*=\s*'paid'/i, "payment_status = 'paid'"],
  [/payment_status\s*=\s*\$\d/i, 'a parameterised payment_status write'],
  [/markCasePaid/, 'markCasePaid'],
  [/enqueueAutoAssign|autoAssign|assignDoctor|broadcastOrderToSpecialty/, 'auto-assign / assignment'],
  [/UPDATE\s+orders\s+SET\s+(?:[a-z_]+\s*=[^;`]*,\s*)*status\s*=/i, 'an orders.status write'],
  [/transitionCase|submitCase\(/, 'a lifecycle transition']
];
function pin(label, code) {
  if (!code) { ok(false, label + ': code block located', 'markers not found'); return; }
  const hits = FORBIDDEN.filter(function (f) { return f[0].test(code); }).map(function (f) { return f[1]; });
  ok(hits.length === 0, label + ': no payment_status=paid, no markCasePaid, no status change, no auto-assign', 'found: ' + hits.join(', '));
  const orderWrites = (code.match(/UPDATE\s+orders\s+SET\s+[a-z_]+/gi) || []).map(function (s) { return s.replace(/\s+/g, ' ').toLowerCase(); });
  const allowed = ['update orders set updated_at', 'update orders set reference_id'];
  const bad = orderWrites.filter(function (w) { return allowed.indexOf(w) === -1; });
  ok(bad.length === 0, label + ': the only writes to orders are updated_at / reference_id', 'unexpected: ' + bad.join(', '));
}
const SERVICE_CODE = stripComments(read('src/services/manual_payment.js'));
pin('services/manual_payment.js', SERVICE_CODE);
pin('routes/patient.js claim route', stripComments(between(read('src/routes/patient.js'), 'MANUAL-PAY-CLAIM-ROUTE BEGIN', 'MANUAL-PAY-CLAIM-ROUTE END') || ''));
pin('routes/api/cases.js claim route', stripComments(between(read('src/routes/api/cases.js'), 'MANUAL-PAY-CLAIM-ROUTE BEGIN', 'MANUAL-PAY-CLAIM-ROUTE END') || ''));
ok(!/require\(['"]\.\.\/case_lifecycle['"]\)\.markCasePaid|\.markCasePaid\s*\(/.test(SERVICE_CODE), 'service never invokes markCasePaid on any lifecycle handle');

{
  const sa = read('src/routes/superadmin.js');
  const mp = between(sa, "router.post('/superadmin/orders/:id/mark-paid'", "router.post('/superadmin/orders/:id/payment-claims/");
  ok(!!mp && mp.indexOf('caseLifecycle.markCasePaid(orderId)') !== -1 &&
     mp.indexOf('confirmPendingClaimForOrder') > mp.indexOf('caseLifecycle.markCasePaid(orderId)'),
    'superadmin mark-paid confirms the pending claim AFTER its existing markCasePaid path');
  ok(!!mp && /return res\.redirect\(`\/superadmin\/orders\/\$\{orderId\}`\);/.test(mp.slice(0, mp.indexOf('confirmPendingClaimForOrder'))),
    'mark-paid idempotent early return is untouched');
  const rj = between(sa, "router.post('/superadmin/orders/:id/payment-claims/:claimId/reject'", "router.get('/superadmin/payment-claims'");
  ok(!!rj && /requireSuperadmin/.test(rj), 'reject route is superadmin-only');
  pin('superadmin reject route', stripComments(rj || ''));
  ok(/\/transfer-claim',\s*requireRole\('patient'\),\s*transferClaimLimiter/.test(read('src/routes/patient.js')),
    'web claim route is patient-only and rate-limited');
  ok(/'\/:id\/payment-claim',\s*paymentClaimLimiter/.test(read('src/routes/api/cases.js')),
    'API claim route is rate-limited per patient');
}

// ── Fakes ───────────────────────────────────────────────────────────────────
const mpSvc = require('../../src/services/manual_payment');
const realLifecycle = require('../../src/case_lifecycle');
const { owedCentsForOrder } = require('../../src/services/order_pricing');

function makeWorld() {
  const w = {
    sql: [],               // every statement, in order
    claims: [],            // payment_claims rows
    orders: {},            // id -> row
    markCasePaidCalls: 0,
    adminAlerts: [],
    pushes: [],
    patientNotes: [],
    events: [],
    insertRaceOnce: false
  };
  let seq = 0;
  function clone(r) { return r ? Object.assign({}, r) : null; }
  w.pg = {
    queryOne: async function (sql, params) {
      w.sql.push(sql);
      const s = sql.replace(/\s+/g, ' ');
      if (/^UPDATE payment_claims SET method/.test(s.trim())) {
        const row = w.claims.find(function (c) { return c.order_id === params[4] && c.status === 'pending'; });
        if (!row) return null;
        Object.assign(row, { method: params[0], reference: params[1], sender_name: params[2], updated_at: new Date(Date.now() + (++seq)) });
        return clone(row);
      }
      if (/^INSERT INTO payment_claims/.test(s.trim())) {
        if (w.insertRaceOnce) {
          w.insertRaceOnce = false;
          w.claims.push({ id: 'pc-racer', order_id: params[1], patient_id: params[2], method: 'bank', reference: 'RACER', sender_name: null, status: 'pending', created_at: new Date(), updated_at: new Date() });
          const e = new Error('duplicate key value violates unique constraint "payment_claims_one_pending_per_order"'); e.code = '23505'; throw e;
        }
        const row = { id: params[0], order_id: params[1], patient_id: params[2], method: params[3], reference: params[4], sender_name: params[5], status: 'pending', rejection_reason: null, created_at: new Date(), updated_at: new Date(Date.now() + (++seq)) };
        w.claims.push(row);
        return clone(row);
      }
      if (/^UPDATE payment_claims SET status = 'rejected'/.test(s.trim())) {
        const row = w.claims.find(function (c) { return c.id === params[2] && c.order_id === params[3] && c.status === 'pending'; });
        if (!row) return null;
        Object.assign(row, { status: 'rejected', rejection_reason: params[0], resolved_by: params[1], resolved_at: new Date() });
        return clone(row);
      }
      if (/^UPDATE payment_claims SET status = 'confirmed'/.test(s.trim())) {
        const row = w.claims.find(function (c) { return c.order_id === params[1] && c.status === 'pending'; });
        if (!row) return null;
        Object.assign(row, { status: 'confirmed', resolved_by: params[0], resolved_at: new Date() });
        return { id: row.id };
      }
      if (/FROM payment_claims WHERE order_id = \$1 ORDER BY/.test(s)) {
        const rows = w.claims.filter(function (c) { return c.order_id === params[0]; })
          .sort(function (a, b) { return ((b.status === 'pending') - (a.status === 'pending')) || (b.updated_at - a.updated_at); });
        return clone(rows[0] || null);
      }
      if (/^UPDATE orders SET reference_id = COALESCE/.test(s.trim())) {
        const o = w.orders[params[1]];
        if (o && !o.reference_id) o.reference_id = params[0];
        return o ? { reference_id: o.reference_id } : null;
      }
      if (/SELECT reference_id FROM orders_active/.test(s)) {
        const o = w.orders[params[0]];
        return o ? { reference_id: o.reference_id } : null;
      }
      return null;
    },
    queryAll: async function (sql) { w.sql.push(sql); return []; },
    execute: async function (sql, params) {
      w.sql.push(sql);
      if (/UPDATE orders SET updated_at/.test(sql)) {
        const o = w.orders[params[1]]; if (o) o.updated_at = params[0];
      }
      return { rowCount: 1 };
    }
  };
  w.deps = {
    pg: function () { return w.pg; },
    caseLifecycle: function () {
      return {
        isPayableStatus: realLifecycle.isPayableStatus,
        markCasePaid: async function () { w.markCasePaidCalls++; }
      };
    },
    notify: function () {
      return {
        notifyAdmins: async function (o) { w.adminAlerts.push(o); return []; },
        queueMultiChannelNotification: async function (o) { w.patientNotes.push(o); return { ok: true }; }
      };
    },
    opsPush: function () { return { pushOpsEvent: async function (o) { w.pushes.push(o); return { sent: true }; } }; },
    audit: function () { return { logOrderEvent: function (e) { w.events.push(e); } }; },
    reference: function () { return { generateReferenceId: async function () { return 'TSH-2026-000999'; } }; },
    logger: function () { return { logErrorToDb: function () {} }; }
  };
  return w;
}

// Every statement that could possibly move money.
function moneyWrites(sqlList) {
  return sqlList.filter(function (s) {
    return /payment_status/i.test(s) && /^\s*(UPDATE|INSERT)/i.test(s) ||
           /UPDATE\s+orders\s+SET\s+[\s\S]*\bstatus\s*=/i.test(s) && !/updated_at\s*=\s*\$1\s+WHERE/i.test(s) ||
           /paid_at/i.test(s);
  });
}

(async function main() {
  let restoreDeps = function () {};
  try {
    // ── B. A claim does not move money; resubmit updates, not duplicates ────
    {
      const w = makeWorld();
      restoreDeps = mpSvc.__setTestDeps(w.deps);
      const order = { id: 'ord-1', status: 'SUBMITTED', payment_status: 'unpaid', price: 1600, currency: 'EGP', addons_json: null, reference_id: 'TSH-2026-000417' };
      w.orders[order.id] = Object.assign({}, order);

      const r1 = await mpSvc.submitClaim({ order, patientId: 'pat-1', patientName: 'Mona', claim: { method: 'instapay', reference: 'IPN-111', senderName: null }, source: 'web' });
      const r2 = await mpSvc.submitClaim({ order, patientId: 'pat-1', patientName: 'Mona', claim: { method: 'bank', reference: 'BNK-222', senderName: 'Mona A' }, source: 'app' });

      ok(r1.created === true && r2.created === false, 'first submit inserts, second submit updates');
      ok(w.claims.length === 1 && w.claims[0].reference === 'BNK-222' && w.claims[0].method === 'bank' && r1.claim.id === r2.claim.id,
        'resubmit while pending updates the SAME claim (no duplicate)', JSON.stringify(w.claims));
      ok(moneyWrites(w.sql).length === 0, 'no statement writes payment_status / status / paid_at', moneyWrites(w.sql).join(' | '));
      ok(w.markCasePaidCalls === 0, 'markCasePaid never called');
      const orderWrites = w.sql.filter(function (s) { return /UPDATE\s+orders/i.test(s); });
      ok(orderWrites.length === 2 && orderWrites.every(function (s) { return /^UPDATE orders SET updated_at = \$1 WHERE id = \$2$/.test(s.trim()); }),
        'the only orders write is touching updated_at (restarts the unpaid TTL clock), once per submit', orderWrites.join(' | '));
      ok(w.orders['ord-1'].payment_status === 'unpaid' && w.orders['ord-1'].status === 'SUBMITTED', 'order stays unpaid and SUBMITTED');
      // Soft launch 2026-09-25: each submission alerts superadmins TWICE — the
      // in-app queue row (channel internal, the original) and a WhatsApp
      // (channel whatsapp), with distinct dedupe keys so neither collapses
      // the other. Two submissions → four alerts.
      const internalAlerts = w.adminAlerts.filter(function (a) { return !a.channel || a.channel === 'internal'; });
      const waAlerts = w.adminAlerts.filter(function (a) { return a.channel === 'whatsapp'; });
      ok(w.adminAlerts.length === 4 && w.adminAlerts.every(function (a) { return a.template === 'admin_payment_claim_received' && a.orderId === 'ord-1'; }) &&
         internalAlerts.length === 2 && waAlerts.length === 2 &&
         new Set(w.adminAlerts.map(function (a) { return a.dedupeKey; })).size === 4,
        'superadmins alerted via notifyAdmins on each distinct submission — in-app AND WhatsApp, distinct dedupe keys');
      ok(w.pushes.length === 2 && w.pushes[0].kind === 'payment_claim', 'Command push fired via pushOpsEvent');
      ok(waAlerts[1].payload.amount === 1600 && waAlerts[1].payload.transferReference === 'BNK-222' &&
         internalAlerts[1].payload.amount === 1600 && internalAlerts[1].payload.transferReference === 'BNK-222', 'alert carries amount + reference (both channels)');
      ok(w.events.map(function (e) { return e.label; }).join(',') === 'payment_claim_submitted,payment_claim_updated', 'audit events written');

      // Race on insert → falls back to updating the winner.
      const w2 = makeWorld();
      restoreDeps(); restoreDeps = mpSvc.__setTestDeps(w2.deps);
      w2.insertRaceOnce = true;
      const r3 = await mpSvc.submitClaim({ order, patientId: 'pat-1', claim: { method: 'instapay', reference: 'IPN-333', senderName: null } });
      ok(w2.claims.length === 1 && r3.claim.id === 'pc-racer' && w2.claims[0].reference === 'IPN-333', 'double-submit race resolves to one pending claim');

      // Reject → then a new submission starts a new pending claim; history kept.
      const w3 = makeWorld();
      restoreDeps(); restoreDeps = mpSvc.__setTestDeps(w3.deps);
      w3.orders['ord-1'] = Object.assign({}, order);
      const s1 = await mpSvc.submitClaim({ order, patientId: 'pat-1', claim: { method: 'instapay', reference: 'IPN-444', senderName: null } });
      const noReason = await mpSvc.rejectClaim({ orderId: 'ord-1', claimId: s1.claim.id, reason: '   ', actorId: 'sa-1' });
      ok(!noReason.ok && noReason.code === 'reason_required' && w3.claims[0].status === 'pending', 'reject requires a reason');
      const rej = await mpSvc.rejectClaim({ orderId: 'ord-1', claimId: s1.claim.id, reason: 'No transfer with that reference arrived.', actorId: 'sa-1' });
      ok(rej.ok && w3.claims[0].status === 'rejected' && w3.claims[0].rejection_reason === 'No transfer with that reference arrived.' && w3.claims[0].resolved_by === 'sa-1',
        'reject: claim → rejected with reason and resolver');
      ok(moneyWrites(w3.sql).length === 0 && w3.markCasePaidCalls === 0 && w3.orders['ord-1'].payment_status === 'unpaid', 'reject: order stays unpaid, nothing moves money');
      ok(w3.patientNotes.length === 1 && w3.patientNotes[0].template === 'payment_claim_rejected_patient' &&
         w3.patientNotes[0].toUserId === 'pat-1' && w3.patientNotes[0].channels.join(',') === 'internal,email' &&
         w3.patientNotes[0].response.rejectionReason === 'No transfer with that reference arrived.',
        'reject: patient notified (in-app + email) with the reason');
      const again = await mpSvc.rejectClaim({ orderId: 'ord-1', claimId: s1.claim.id, reason: 'x', actorId: 'sa-1' });
      ok(!again.ok && again.code === 'not_pending', 'reject is not repeatable on a resolved claim');
      await mpSvc.submitClaim({ order, patientId: 'pat-1', claim: { method: 'instapay', reference: 'IPN-555', senderName: null } });
      ok(w3.claims.length === 2 && w3.claims.filter(function (c) { return c.status === 'pending'; }).length === 1,
        'after a rejection, a new submission opens a fresh pending claim; the rejected one stays as history');
      const cur = await mpSvc.getCurrentClaim('ord-1');
      ok(cur && cur.status === 'pending' && cur.reference === 'IPN-555', 'current claim prefers the pending one');
      const confirmedId = await mpSvc.confirmPendingClaimForOrder('ord-1', 'sa-1');
      ok(!!confirmedId && w3.claims.find(function (c) { return c.id === confirmedId; }).status === 'confirmed', 'confirmPendingClaimForOrder closes the pending claim as confirmed');
      ok(await mpSvc.confirmPendingClaimForOrder('ord-1', 'sa-1') === null, 'confirm is a no-op when nothing is pending');
      restoreDeps();
      restoreDeps = mpSvc.__setTestDeps({ pg: function () { return { queryOne: async function () { throw new Error('relation "payment_claims" does not exist'); } }; } });
      ok(await mpSvc.confirmPendingClaimForOrder('ord-1', 'sa-1') === null && await mpSvc.getCurrentClaim('ord-1') === null,
        'confirm/getCurrentClaim never throw before migration 117 has run');
      restoreDeps(); restoreDeps = function () {};
    }

    // ── C. Amount = what the card flow charges (standard / VIP / add-on) ────
    {
      // Drive the REAL Paymob mint (services/paymob_intention.js) with a fake
      // pg + fake Paymob, capture amountCents, compare with the transfer amount.
      const pgPath = require.resolve('../../src/pg');
      const paymobPath = require.resolve('../../src/services/paymob');
      const intentionPath = require.resolve('../../src/services/paymob_intention');
      let current = null; let captured = null;
      const fakePg = {
        queryOne: async function (sql) {
          if (/FROM orders_active/.test(sql)) return Object.assign({ patient_id: 'p', payment_status: 'unpaid', payment_link: null, service_id: 's' }, current);
          if (/FROM users/.test(sql)) return { id: 'p', name: 'N', email: 'e@x.example', phone: '+201000000000', country: 'EG' };
          return null;
        },
        execute: async function () { return { rowCount: 1 }; }
      };
      const fakePaymob = { createIntention: async function (a) { captured = a.amountCents; return { intentionId: 'i', checkoutUrl: 'https://c' }; } };
      const saved = { pg: require.cache[pgPath], paymob: require.cache[paymobPath], intention: require.cache[intentionPath] };
      function fakeMod(p, exp) { return { id: p, filename: p, loaded: true, exports: exp, children: [], paths: [] }; }
      require.cache[pgPath] = fakeMod(pgPath, fakePg);
      require.cache[paymobPath] = fakeMod(paymobPath, fakePaymob);
      delete require.cache[intentionPath];
      let ensure;
      try { ensure = require(intentionPath).ensurePaymentLinkForOrder; }
      finally {
        if (saved.pg) require.cache[pgPath] = saved.pg; else delete require.cache[pgPath];
        if (saved.paymob) require.cache[paymobPath] = saved.paymob; else delete require.cache[paymobPath];
        if (saved.intention) require.cache[intentionPath] = saved.intention; else delete require.cache[intentionPath];
      }
      const fixtures = {
        standard: { id: 'o-std', price: 1600, currency: 'EGP', addons_json: null },
        'VIP uplift': { id: 'o-vip', price: 2400, base_price: 1600, urgency_uplift_amount: 800, currency: 'EGP', addons_json: null },
        'Urgent uplift, fractional': { id: 'o-urg', price: 3199.5, currency: 'EGP', addons_json: null },
        'add-on (prescription + video)': { id: 'o-add', price: 1600, currency: 'EGP', addons_json: JSON.stringify({ prescription: true, prescription_price: 300, video_consultation: true, video_consultation_price: 200 }) }
      };
      for (const [name, o] of Object.entries(fixtures)) {
        current = o; captured = null;
        await ensure({ orderId: o.id, patientId: 'p', redirectionUrl: 'https://r' });
        const amt = mpSvc.transferAmountForOrder(o);
        ok(captured != null && amt.amountCents === captured && Math.round(amt.amount * 100) === captured && amt.currency === 'EGP',
          'transfer amount equals the Paymob charge — ' + name + ' (' + amt.amount + ' EGP)', 'transfer=' + amt.amountCents + ' card=' + captured);
      }
      ok(mpSvc.transferAmountForOrder(fixtures['add-on (prescription + video)']).amount === 2100, 'add-ons included (1600 + 300 + 200)');
      ok(mpSvc.transferAmountForOrder(fixtures['VIP uplift']).amountCents === owedCentsForOrder({ price: 2400, addons_json: null }), 'VIP uplift included via orders.price');
    }

    // ── F. Config parsing (read per request) ─────────────────────────────────
    {
      setEnv({});
      let c = mpSvc.readManualPaymentConfig();
      ok(c.enabled === false && mpSvc.isCardPaymentEnabled() === true, 'defaults: manual off, card on');
      setEnv({ MANUAL_PAYMENT_ENABLED: 'true' });
      ok(mpSvc.readManualPaymentConfig().enabled === false, 'flag on but nothing configured → treated as disabled (never an empty block)');
      setEnv({ MANUAL_PAYMENT_ENABLED: 'true', MANUAL_PAYMENT_INSTAPAY_LINK: 'http://evil.example/x' });
      ok(mpSvc.readManualPaymentConfig().enabled === false, 'non-https InstaPay link is dropped');
      setEnv({ MANUAL_PAYMENT_ENABLED: 'true', MANUAL_PAYMENT_ACCOUNT_NAME: 'Tashkheesa' });
      ok(mpSvc.readManualPaymentConfig().bank === null, 'bank needs account name AND (number or IBAN)');
      setEnv({ MANUAL_PAYMENT_ENABLED: 'true', MANUAL_PAYMENT_ACCOUNT_NAME: 'Tashkheesa', MANUAL_PAYMENT_IBAN: 'EG00', CARD_PAYMENT_ENABLED: 'false' });
      c = mpSvc.readManualPaymentConfig();
      ok(c.enabled && c.bank && c.bank.iban === 'EG00' && c.instapay === null && mpSvc.isCardPaymentEnabled() === false, 'bank-only config enabled; CARD_PAYMENT_ENABLED=false read');
      ok(c.confirmNote.en === mpSvc.DEFAULT_CONFIRM_NOTE_EN && c.confirmNote.ar === mpSvc.DEFAULT_CONFIRM_NOTE_AR, 'confirm note defaults (EN + AR)');
      setEnv({ CARD_PAYMENT_ENABLED: 'banana' });
      ok(mpSvc.isCardPaymentEnabled() === true, 'unrecognised CARD_PAYMENT_ENABLED value keeps the card on');
      const v1 = mpSvc.validateClaimInput({ method: 'instapay', reference: 'ab' }, { instapay: {}, bank: null });
      const v2 = mpSvc.validateClaimInput({ method: 'bank', reference: 'abc' }, { instapay: {}, bank: null });
      const v3 = mpSvc.validateClaimInput({ method: 'instapay', reference: '  IPN\n 123  ', senderName: 'x'.repeat(81) }, { instapay: {}, bank: null });
      const v4 = mpSvc.validateClaimInput({ method: 'INSTAPAY', reference: '  IPN\n 123  ', senderName: '  Mona  ' }, { instapay: {}, bank: null });
      ok(!v1.ok && v1.code === 'reference_invalid' && !v2.ok && v2.code === 'method_unavailable' && !v3.ok && v3.code === 'sender_invalid' &&
         v4.ok && v4.value.method === 'instapay' && v4.value.reference === 'IPN 123' && v4.value.senderName === 'Mona',
        'claim validation: reference 3-80, method must be configured, sender ≤80, whitespace normalised');
      ok(!mpSvc.validateClaimInput({ method: 'instapay', reference: 'x'.repeat(81) }, null).ok, 'reference over 80 rejected');
      restoreEnv();
    }

    // ── D. API shapes (GET /cases/:id/payment, POST /cases/:id/payment-claim) ─
    {
      const casesPath = require.resolve('../../src/routes/api/cases');
      const intentionPath = require.resolve('../../src/services/paymob_intention');
      let mintCalls = 0;
      let mintShouldFail = false;
      const fakeIntention = { ensurePaymentLinkForOrder: async function () { mintCalls++; if (mintShouldFail) { const e = new Error('paymob_unavailable'); e.code = 'PAYMOB_UNAVAILABLE'; throw e; } return { checkoutUrl: 'https://accept.paymob.com/unifiedcheckout/minted' }; } };
      const saved = { cases: require.cache[casesPath], intention: require.cache[intentionPath] };
      require.cache[intentionPath] = { id: intentionPath, filename: intentionPath, loaded: true, exports: fakeIntention, children: [], paths: [] };
      delete require.cache[casesPath];
      let buildCases;
      try { buildCases = require(casesPath); }
      finally {
        if (saved.intention) require.cache[intentionPath] = saved.intention; else delete require.cache[intentionPath];
        if (saved.cases) require.cache[casesPath] = saved.cases; else delete require.cache[casesPath];
      }

      const w = makeWorld();
      restoreDeps = mpSvc.__setTestDeps(w.deps);
      const orderRow = { id: 'ord-api', status: 'SUBMITTED', payment_status: 'unpaid', price: 2400, currency: 'EGP', addons_json: null, reference_id: null, payment_link: null };
      w.orders['ord-api'] = orderRow;
      const safeGet = async function (sql, params) {
        const s = String(sql);
        if (/FROM orders_active WHERE id = \$1 AND patient_id = \$2/.test(s)) {
          return (params[0] === orderRow.id && params[1] === 'pat-api') ? Object.assign({}, orderRow) : null;
        }
        if (/payment_status as status/.test(s)) {
          return { status: orderRow.payment_status, amount: orderRow.price, currency: 'EGP', paymentLink: orderRow.payment_link, method: null, paidAt: null };
        }
        if (/SELECT lang FROM users/.test(s)) return { lang: 'en' };
        if (/SELECT name FROM users/.test(s)) return { name: 'Api Patient' };
        return null;
      };
      const router = buildCases({}, { safeGet: safeGet, safeAll: async function () { return []; }, safeRun: async function () { return { rowCount: 1 }; } });
      function handler(method, p) {
        const layers = router.stack.filter(function (l) { return l.route && l.route.path === p && l.route.methods[method]; });
        const st = layers[layers.length - 1].route.stack;
        return st[st.length - 1].handle;
      }
      const GET = handler('get', '/:id/payment');
      const POST = handler('post', '/:id/payment-claim');
      async function call(h, opts) {
        const req = Object.assign({ params: { id: 'ord-api' }, user: { id: 'pat-api' }, query: {}, headers: { host: 'x' }, body: {}, get: function () { return 'x'; }, secure: true }, opts || {});
        const res = {
          statusCode: 200, body: null,
          status: function (c) { this.statusCode = c; return this; },
          json: function (b) { this.body = b; return this; },
          ok: function (d) { this.body = { success: true, data: d }; return this; },
          fail: function (m, s, c) { this.statusCode = s || 400; this.body = { success: false, error: m, code: c }; return this; }
        };
        await h(req, res);
        return res;
      }

      // Defaults: unchanged behaviour + the two new fields.
      setEnv({});
      let r = await call(GET);
      ok(r.statusCode === 200 && r.body.data.cardEnabled === true && r.body.data.manual === null && mintCalls === 1 &&
         r.body.data.paymentLink === 'https://accept.paymob.com/unifiedcheckout/minted' && r.body.data.status === 'unpaid',
        'GET defaults: mints as before, cardEnabled:true, manual:null', JSON.stringify(r.body));

      // Card disabled + manual on.
      setEnv(Object.assign({ CARD_PAYMENT_ENABLED: 'false', MANUAL_PAYMENT_RELATIONSHIP_NOTE_EN: 'Founder account.' }, ON));
      orderRow.payment_link = 'https://accept.paymob.com/unifiedcheckout/old';
      mintCalls = 0;
      r = await call(GET);
      const m = r.body && r.body.data && r.body.data.manual;
      ok(r.statusCode === 200 && mintCalls === 0 && r.body.data.paymentLink === null && r.body.data.cardEnabled === false,
        'GET card disabled: no Paymob mint, paymentLink null, still 200', JSON.stringify(r.body));
      ok(!!m && JSON.stringify(Object.keys(m).sort()) === JSON.stringify(['amount', 'bank', 'claim', 'confirmNote', 'currency', 'instapay', 'reference', 'relationshipNote']),
        'GET manual has exactly the contract keys', m && Object.keys(m).join(','));
      ok(!!m && m.instapay && m.instapay.handle === 'tashkheesa@instapay' && m.instapay.link === null && m.bank === null &&
         m.amount === 2400 && m.currency === 'EGP' && m.relationshipNote === 'Founder account.' &&
         m.confirmNote === mpSvc.DEFAULT_CONFIRM_NOTE_EN && m.claim === null,
        'GET manual values (amount = card charge incl. uplift, notes, no claim yet)', JSON.stringify(m));
      ok(!!m && m.reference === 'TSH-2026-000999' && orderRow.reference_id === 'TSH-2026-000999',
        'GET manual mints and persists orders.reference_id when missing');
      r = await call(GET, { query: { lang: 'ar' } });
      ok(r.body.data.manual.confirmNote === mpSvc.DEFAULT_CONFIRM_NOTE_AR, 'GET ?lang=ar localizes the notes');

      // Card ENABLED + manual on.
      setEnv(ON);
      orderRow.payment_link = null;
      mintCalls = 0;
      r = await call(GET);
      ok(r.statusCode === 200 && r.body.data.cardEnabled === true && !!r.body.data.manual && mintCalls === 1, 'GET card + manual both on: link minted and manual present');
      // ...and the Paymob mint FAILS: still 200 with manual (the transfer is the way out).
      mintShouldFail = true;
      r = await call(GET);
      ok(r.statusCode === 200 && r.body.data.paymentLink === null && r.body.data.paymentLinkError === 'PAYMENT_LINK_UNAVAILABLE' && !!r.body.data.manual && r.body.data.manual.amount === 2400,
        'GET when the card link cannot be minted: 200 with manual', JSON.stringify(r.body));
      mintShouldFail = false;

      // POST errors.
      setEnv({});
      r = await call(POST, { body: { method: 'instapay', reference: 'IPN-1' } });
      ok(r.statusCode === 403 && r.body.code === 'MANUAL_PAYMENT_DISABLED' && r.body.success === false && typeof r.body.error === 'string', 'POST flag off → 403 MANUAL_PAYMENT_DISABLED');
      setEnv(ON);
      r = await call(POST, { params: { id: 'nope' }, body: { method: 'instapay', reference: 'IPN-1' } });
      ok(r.statusCode === 404 && r.body.code === 'CASE_NOT_FOUND', 'POST unknown / not-owned case → 404 CASE_NOT_FOUND');
      r = await call(POST, { user: { id: 'someone-else' }, body: { method: 'instapay', reference: 'IPN-1' } });
      ok(r.statusCode === 404 && r.body.code === 'CASE_NOT_FOUND', 'POST by a different patient → 404 (owner only)');
      r = await call(POST, { body: { method: 'instapay', reference: 'ab' } });
      ok(r.statusCode === 400 && r.body.code === 'VALIDATION_ERROR', 'POST short reference → 400 VALIDATION_ERROR');
      r = await call(POST, { body: { method: 'bank', reference: 'abcdef' } });
      ok(r.statusCode === 400 && r.body.code === 'VALIDATION_ERROR', 'POST unconfigured method → 400 VALIDATION_ERROR');
      orderRow.status = 'DRAFT';
      r = await call(POST, { body: { method: 'instapay', reference: 'IPN-1' } });
      ok(r.statusCode === 409 && r.body.code === 'NOT_PAYABLE', 'POST draft → 409 NOT_PAYABLE');
      orderRow.status = 'SUBMITTED';
      orderRow.payment_status = 'paid';
      r = await call(POST, { body: { method: 'instapay', reference: 'IPN-1' } });
      ok(r.statusCode === 409 && r.body.code === 'ALREADY_PAID', 'POST paid → 409 ALREADY_PAID');
      r = await call(GET);
      ok(r.statusCode === 200 && r.body.data.manual === null, 'GET manual is null once the order is paid');
      orderRow.payment_status = 'unpaid';

      // POST success + resubmit.
      w.sql.length = 0;
      r = await call(POST, { body: { method: 'instapay', reference: 'IPN-777', senderName: 'Api P' } });
      const c1 = r.body && r.body.data && r.body.data.claim;
      ok(r.statusCode === 200 && c1 && JSON.stringify(Object.keys(c1).sort()) === JSON.stringify(['id', 'method', 'reference', 'rejectionReason', 'senderName', 'status', 'submittedAt']) &&
         c1.status === 'pending' && c1.method === 'instapay' && c1.reference === 'IPN-777' && c1.senderName === 'Api P' &&
         c1.rejectionReason === null && !isNaN(Date.parse(c1.submittedAt)),
        'POST ok → 200 {claim} in contract shape', JSON.stringify(r.body));
      r = await call(POST, { body: { method: 'instapay', reference: 'IPN-778' } });
      const c2 = r.body.data.claim;
      ok(c2.id === c1.id && c2.reference === 'IPN-778' && w.claims.filter(function (c) { return c.order_id === 'ord-api'; }).length === 1,
        'POST resubmit updates the same pending claim');
      ok(moneyWrites(w.sql).length === 0 && w.markCasePaidCalls === 0 && orderRow.payment_status === 'unpaid' && orderRow.status === 'SUBMITTED',
        'POST never moves money (recorded SQL + markCasePaid spy)');
      r = await call(GET);
      ok(r.body.data.manual.claim && r.body.data.manual.claim.id === c1.id && r.body.data.manual.claim.status === 'pending', 'GET manual.claim reflects the pending claim');

      restoreDeps(); restoreDeps = function () {};
      restoreEnv();
    }

    // ── G. Env vars documented ───────────────────────────────────────────────
    {
      const envEx = read('.env.example');
      const reads = Array.from(new Set((SERVICE_CODE.match(/process\.env\.([A-Z0-9_]+)/g) || []).map(function (s) { return s.replace('process.env.', ''); })));
      const missing = reads.filter(function (k) { return !new RegExp('^#?\\s*' + k + '=', 'm').test(envEx); });
      ok(reads.length >= 12 && missing.length === 0, 'every env var the service reads is documented in .env.example', 'missing: ' + missing.join(', '));
      ok(/^MANUAL_PAYMENT_ENABLED=false/m.test(envEx) && /^CARD_PAYMENT_ENABLED=true/m.test(envEx), '.env.example shows the safe defaults');
    }

    // ── H. Notification templates registered ────────────────────────────────
    {
      const titles = read('src/notify/notification_titles.js');
      const worker = read('src/notification_worker.js');
      ok(/admin_payment_claim_received:/.test(titles) && /payment_claim_rejected_patient:/.test(titles), 'titles registered (EN + AR)');
      ok(/payment_claim_rejected_patient:\s*'payment-claim-rejected'/.test(worker) &&
         fs.existsSync(path.join(ROOT, 'src/templates/email/en/payment-claim-rejected.hbs')) &&
         fs.existsSync(path.join(ROOT, 'src/templates/email/ar/payment-claim-rejected.hbs')), 'rejection email mapped with en + ar templates');
      const { renderNotificationMessage } = require('../../src/notify');
      const en = renderNotificationMessage('payment_claim_rejected_patient', { case_id: 'o', caseReference: 'TSH-1', reason: 'Not found' }, 'en');
      const ar = renderNotificationMessage('payment_claim_rejected_patient', { case_id: 'o', caseReference: 'TSH-1', reason: 'Not found' }, 'ar');
      ok(/could not match your transfer/.test(en) && /Not found/.test(en) && /لم نتمكن من مطابقة تحويلك/.test(ar), 'in-app rejection body bilingual with the reason');
    }

    // ── Confirmation notice to the patient already exists (verify) ─────────
    {
      const sa = read('src/routes/superadmin.js');
      const mp = between(sa, "router.post('/superadmin/orders/:id/mark-paid'", "router.post('/superadmin/orders/:id/payment-claims/");
      ok(!!mp && /template:\s*'payment_marked_paid_patient'/.test(mp), 'mark-paid already notifies the patient (payment_marked_paid_patient)');
    }
  } catch (e) {
    t.fail(fileTag + ': unexpected error', e);
  } finally {
    try { restoreDeps(); } catch (_) {}
    restoreEnv();
  }
})();
