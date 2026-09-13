'use strict';
// tests/core/refund-operator-queue.test.js
//
// 2026-09-13 (Part C4, C5, C7). The operator side of refunds:
//   C4 /superadmin/refunds — tabs, the patient's name from the ORDER in <bdi>,
//      what the case can still refund on every row, approve prefilled with that
//      (never above the request) and the remainder maths, mark-paid requiring
//      the number paid to and stamping who paid, deny asking for the reason the
//      patient reads, a confirm step on every action, honest banners.
//   C5 /superadmin/refunds/create — the ceiling is what is STILL refundable
//      (it was base_price + uplift, recomputed in the view), payment facts from
//      the shared helper, a REFUND_CREATED_BY_OPERATOR case event.
//   C7 GET /api/v1/admin/refunds — the same figures as added fields; every
//      existing field keeps its value.
// Browser-level (390px and 1440px, both languages) is in scripts/mobile-shots.js.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💸 operator refund queue, create form and Command API (Part C4/C5/C7)\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { refundFigures, describeRefund } = require('../../src/services/refund_summary');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); } catch (e) { t.fail(name, e); }
}

// ── views ────────────────────────────────────────────────────────────────
['header', 'page_header', 'c_card_open', 'c_card_close', 'c_empty', 'footer'].forEach((p) => {
  ejs.cache.set(path.join(VIEWS, 'partials', 'superadmin', p + '.ejs'), () => '');
});
ejs.cache.set(path.join(VIEWS, 'partials', 'superadmin', 'c_chip.ejs'), (d) => '<span class="chip">' + (d && d.label) + '</span>');
let rc = 0;
function render(view, locals) {
  const src = fs.readFileSync(path.join(VIEWS, view), 'utf8');
  return ejs.render(src, Object.assign({
    lang: 'en', isAr: false, user: {}, cspNonce: 'n',
    tt: (k, en) => en, csrfField: () => '<input type="hidden" name="_csrf" value="x">'
  }, locals), { filename: path.join(VIEWS, '__opq_' + (++rc) + '.ejs'), cache: true });
}

const order = { price: '2400.00', base_price: '1600.00', urgency_uplift_amount: '800.00', addons_json: null };
function row(extra) {
  const r = Object.assign({ order_id: 'o-' + Math.random(), reference_id: 'TSH-X', patient_name: 'منى علي', reason: 'patient_request',
    instapay_handle: '+201000000002', refunded_at: new Date(Date.now() - 3 * 3600e3), paid_refunded_egp: '600.00' }, order, extra);
  r.figures = refundFigures(r);
  return r;
}
function queue(locals) {
  return render('superadmin_refunds.ejs', Object.assign({
    pending: [row({ id: 'p1', status: 'pending', requested_amount: '1500.00', patient_reason: 'Changed plans' }),
              row({ id: 'p2', status: 'pending', requested_amount: '2400.00' })],
    awaitingPayment: [row({ id: 'a1', status: 'approved', requested_amount: '2400.00', approved_amount: '1200.00', reviewed_by_name: 'Omar', reviewed_at: new Date() })],
    recent: [row({ id: 'd1', status: 'paid', amount_egp: '600.00', approved_amount: '600.00', paid_at: new Date(), paid_to_number: '+201000000002', instapay_reference: 'IPX-1', paid_by_name: 'Omar' }),
             row({ id: 'n1', status: 'denied', requested_amount: '1600.00', denial_reason: 'Report already written', reviewed_by_name: 'Omar', reviewed_at: new Date() })],
    flash: '', flashError: '', flashWarn: '', prefillOrder: '', prefillOrderRow: null
  }, locals));
}
const articles = (html) => html.split('<article class="rq-row"').slice(1).map((a) => a.slice(0, a.indexOf('</article>')));

check('C4 figures: charged 2400, 600 paid back → 1800 refundable; approving 1500 leaves 300', () => {
  const f = row({ status: 'pending', requested_amount: '1500.00' }).figures;
  if (f.eligibleEgp !== 1800 || f.alreadyRefundedEgp !== 600 || f.remainderEgp !== 300) return JSON.stringify(f);
  const paid = row({ status: 'paid', amount_egp: '600.00', approved_amount: '600.00' }).figures;
  if (paid.remainderEgp !== 1800) return 'a paid row must not subtract itself twice: ' + JSON.stringify(paid);
  return null;
});

check('C4 queue: four filter tabs over four panels', () => {
  const html = queue();
  const tabs = html.match(/<button[^>]*role="tab"[^>]*data-refund-tab="(pending|awaiting|paid|denied)"/g) || [];
  const panels = html.match(/role="tabpanel"[^>]*data-refund-panel="(pending|awaiting|paid|denied)"/g) || [];
  return tabs.length === 4 && panels.length === 4 ? null : tabs.length + ' tabs, ' + panels.length + ' panels';
});

check('C4 queue: every row isolates the patient name in <bdi> and shows requested / refundable / already refunded', () => {
  const rows = articles(queue());
  if (rows.length !== 5) return rows.length + ' rows';
  for (const a of rows) {
    if (!/<bdi class="rq-name">منى علي<\/bdi>/.test(a)) return 'name not in <bdi>: ' + a.slice(0, 120);
    if (!/EGP 1,800/.test(a) && !/EGP 600/.test(a)) return 'no case figures';
  }
  const p1 = rows[0];
  if (!/Requested<\/dt><dd>EGP 1,500/.test(p1) || !/Refundable now<\/dt><dd>EGP 1,800/.test(p1) || !/Already refunded<\/dt><dd>EGP 600/.test(p1)) return 'pending figures wrong';
  if (!/Changed plans/.test(p1)) return 'patient reason not shown';
  return null;
});

check('C4 approve: prefilled with min(requested, refundable) and the remainder maths', () => {
  const rows = articles(queue());
  const input = (a) => (a.match(/<input[^>]*name="approved_amount"[^>]*>/) || [''])[0];
  if (!/max="1500\.00" value="1500\.00"/.test(input(rows[0]))) return 'request below the ceiling: ' + input(rows[0]);
  if (!/max="1800\.00" value="1800\.00"/.test(input(rows[1]))) return 'request above the ceiling not capped: ' + input(rows[1]);
  if (!/Refundable now EGP 1,800 − this approval EGP 1,500 = EGP 300 still refundable/.test(rows[0])) return 'no remainder maths';
  return null;
});

check('C4 actions: approve, deny and mark-paid each confirm; mark-paid requires the number paid to', () => {
  const html = queue();
  for (const act of ['approve', 'deny', 'mark-paid']) {
    const forms = html.match(new RegExp('<form[^>]*action="/superadmin/refunds/[^"]+/' + act + '"[^>]*>', 'g')) || [];
    if (!forms.length) return 'no ' + act + ' form';
    if (forms.some((f) => !/data-confirm-msg="[^"]+"/.test(f))) return act + ' form without a confirm step';
  }
  const paid = html.slice(html.indexOf('/mark-paid"'), html.indexOf('</form>', html.indexOf('/mark-paid"')));
  if (!/<input[^>]*name="paid_to_number"[^>]*required[^>]*value="\+201000000002"/.test(paid)) return 'paid-to number not required/prefilled';
  if (!/name="instapay_reference"[^>]*required/.test(paid)) return 'reference not required';
  if (!/Reason the patient will see/.test(html)) return 'deny does not say the patient reads the reason';
  if (!/new approve script/.test('new approve script') || !/window\.confirm\(msg\)/.test(html)) return 'no confirm script';
  return null;
});

check('C4 paid and denied rows say who acted and what the patient read', () => {
  const rows = articles(queue());
  const paid = rows.find((a) => /data-refund-id="d1"/.test(a));
  const denied = rows.find((a) => /data-refund-id="n1"/.test(a));
  if (!/ending<\/span>|to the number ending/.test(paid) || !/0002/.test(paid) || !/paid by/.test(paid) || !/IPX-1/.test(paid)) return 'paid row: ' + paid;
  if (!/Denied by/.test(denied) || !/Report already written/.test(denied)) return 'denied row';
  return null;
});

check('C4 banners stay honest: clawback failure never says "try again"; unknown flash renders nothing', () => {
  const claw = queue({ flash: 'paid', flashError: 'clawback_failed' });
  if (!/do not pay the refund again/.test(claw)) return 'clawback banner does not warn against paying twice';
  const err = claw.slice(claw.indexOf('class="flash err"'), claw.indexOf('</div>', claw.indexOf('class="flash err"')));
  if (/try again/i.test(err)) return 'clawback banner tells the operator to try again';
  if (/class="flash ok"/.test(queue({ flash: 'bogus' }))) return 'empty success banner for an unknown flash';
  if (!/raised to the amount you entered/.test(queue({ flash: 'superseded' }))) return 'superseded flash renders nothing';
  return null;
});

// ── C5 create view ───────────────────────────────────────────────────────
function createView(extra) {
  return render('superadmin_refund_create.ejs', Object.assign({
    order: Object.assign({ id: 'o1', reference_id: 'TSH-1', patient_name: 'Mona', patient_phone: '+201000000002' }, order),
    defaultAmount: 1800,
    summary: describeRefund({ verdict: { eligible: true, reason: 'post_in_review_review_required', autoApprove: false }, ceilingEgp: 2400, alreadyRefundedEgp: 600, paidEgp: 2400 }),
    existingRefund: null, supersedingBreachRefund: null, formError: null
  }, extra));
}
check('C5 create: the ceiling is what is still refundable (1800), not base + uplift (2400)', () => {
  const html = createView();
  const amt = (html.match(/<input[^>]*id="amount"[^>]*>/) || [''])[0];
  if (!/max="1800\.00"/.test(amt) || !/value="1800\.00"/.test(amt)) return amt;
  if (/2400\.00/.test(amt)) return 'legacy base + uplift ceiling';
  if (!/Patient paid[\s\S]{0,80}EGP 2,400/.test(html) || !/Already refunded \(paid out\)[\s\S]{0,80}EGP 600/.test(html)) return 'payment facts missing';
  if (!/Up to EGP 1,800 — the rest of what you paid/.test(html)) return 'shared eligibility sentence missing';
  if (!/name="instapay_handle"[^>]*value="\+201000000002"/.test(html)) return 'InstaPay number not prefilled';
  if (!/data-confirm-msg=/.test(html)) return 'no confirm step';
  const src = read('src/views/superadmin_refund_create.ejs');
  if (/Number\(order && order\.base_price[^)]*\)\s*\+\s*Number\(order && order\.urgency_uplift_amount/.test(src)) return 'view still computes base + uplift';
  return null;
});
check('C5 create: an unpaid SLA-breach refund is explained as a top-up', () => {
  return /RAISES that refund/.test(createView({ supersedingBreachRefund: { id: 'b1', status: 'auto_approved', reason: 'sla_breach', amount: 800 } })) ? null : 'no top-up explanation';
});

// ── routes (source) ──────────────────────────────────────────────────────
const SA = read('src/routes/superadmin.js');
const handler = (needle) => { const i = SA.indexOf(needle); return i < 0 ? '' : SA.slice(i, SA.indexOf('\nrouter.', i + 50)); };
check('C4 queue route: patient from the order, figures on every row', () => {
  const h = handler("router.get('/superadmin/refunds', requireSuperadmin");
  if (/LEFT JOIN users u ON u\.id = r\.requested_by/.test(h)) return 'patient still joined via requested_by';
  if (!/LEFT JOIN orders_active o ON o\.id = r\.order_id[\s\S]{0,80}LEFT JOIN users u ON u\.id = o\.patient_id/.test(h)) return 'patient not joined via the order';
  if (!/paid_refunded_egp/.test(h) || !/refundFigures\(/.test(h)) return 'rows carry no figures';
  return null;
});
check('C4 approve route: capped at what the case can still refund (fails closed)', () => {
  const h = handler("router.post('/superadmin/refunds/:id/approve'");
  if (!/remainingRefundableEgp\(ord\)/.test(h) || !/amount_exceeds_remaining/.test(h)) return 'no remaining-ceiling check';
  if (!/catch \(_\) \{\s*return res\.redirect\('\/superadmin\/refunds\?error=ceiling_unavailable'\)/.test(h)) return 'does not fail closed';
  return null;
});
check('C4 mark-paid route: number paid to (E.164) required, stored with who paid', () => {
  const h = handler("router.post('/superadmin/refunds/:id/mark-paid'");
  if (!/validatePhoneE164\(\s*String\(\(req\.body && req\.body\.paid_to_number\)/.test(h)) return 'paid_to_number not validated';
  if (!/paid_to_number_invalid/.test(h)) return 'no error for a missing number';
  if (!/paid_to_number = \$4,\s*paid_by = \$5/.test(h) || !/\[reference, finalAmount, refundId, paidToNumber, payerId\]/.test(h)) return 'not stored with paid_by';
  if (!/last4\(paidToNumber\)/.test(h)) return 'notification not from the number actually paid to';
  if (!fs.existsSync(path.join(ROOT, 'src/migrations/108_refunds_paid_to_and_paid_by.sql'))) return 'migration 108 missing';
  return null;
});
check('C5 create route: shared summary + REFUND_CREATED_BY_OPERATOR on both create paths', () => {
  if (!/refundSummaryForOrder\(order\)/.test(handler("router.get('/superadmin/refunds/create'"))) return 'GET does not build the shared summary';
  const post = handler("router.post('/superadmin/refunds/create'");
  const n = (post.match(/logCaseEvent\(orderId, 'REFUND_CREATED_BY_OPERATOR'/g) || []).length;
  return n === 2 ? null : n + ' REFUND_CREATED_BY_OPERATOR events (expected insert + top-up)';
});

// ── C7 Command API ───────────────────────────────────────────────────────
module.exports = (async function c7() {
  const name = 'C7 GET /api/v1/admin/refunds: added eligible / already refunded / remainder / masked number / reason; existing fields unchanged';
  let server;
  try {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-command-refunds';
    process.env.SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'ziad.wahsh@shifaegypt.com';
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const apiResponse = require('../../src/middleware/apiResponse');
    const makeAdminRouter = require('../../src/routes/api/admin');
    const ROW = {
      id: 'rf-c7', order_id: 'ord-c7', amount_egp: '1500.00', requested_amount: '1500.00', approved_amount: null,
      status: 'pending', reason: 'patient_request', instapay_handle: '+201000000002', instapay_reference: null,
      refunded_at: new Date('2026-09-12T08:00:00Z'), reviewed_at: null, paid_at: null,
      patient_name: 'Mona', reference_id: 'TSH-C7', service_id: 'svc', price: '2400.00', currency: 'EGP',
      patient_reason: 'Changed plans', paid_to_number: null, paid_by: null,
      base_price: '1600.00', urgency_uplift_amount: '800.00', addons_json: null, paid_refunded_egp: '600.00'
    };
    const seen = [];
    const stubs = {
      safeAll: async (sql) => { seen.push(sql); return /r\.status = 'pending'/.test(sql) ? [ROW] : []; },
      safeGet: async (sql) => (/collected_today/.test(sql) ? { collected_today: 0, collected_mtd: 0 }
        : /refunded_mtd/.test(sql) ? { refunded_mtd: 0, unsettled_count: 0, unsettled_total: 0 } : null)
    };
    const helpers = { safeGet: stubs.safeGet, safeAll: stubs.safeAll, safeRun: async () => ({ rowCount: 0 }), mustGet: stubs.safeGet, mustAll: stubs.safeAll };
    const app = express();
    app.use(apiResponse);
    app.use(express.json());
    app.use('/api/v1/admin', makeAdminRouter({ totalCount: 1, idleCount: 1, waitingCount: 0 }, helpers,
      { gitSha: 'x', startedAt: 0, startedAtIso: '', version: '1', mode: 'test' },
      { ensureConversation: async () => 'c', queueMultiChannelNotification: async () => ({ ok: true, results: {} }), notifyCaseAssigned: async () => ({ ok: true }) }));
    server = app.listen(0);
    const token = jwt.sign({ id: 'd1d04fb8-cc53-4928-b412-60f763546d09', email: process.env.SUPERADMIN_EMAIL, role: 'superadmin', name: 'Ziad' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/admin/refunds', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
    const body = await res.json();
    const p = body && body.data && body.data.queue && body.data.queue.pending && body.data.queue.pending[0];
    const errs = [];
    if (res.status !== 200 || !p) errs.push('HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200));
    else {
      const want = { eligibleEgp: 1800, alreadyRefundedEgp: 600, remainderEgp: 300, instapayMasked: '+20******0002', instapayLast4: '0002', patientReason: 'Changed plans', paidToMasked: null, paidBy: null };
      for (const [k, v] of Object.entries(want)) if (p[k] !== v) errs.push(k + '=' + JSON.stringify(p[k]) + ' (want ' + JSON.stringify(v) + ')');
      const keep = { id: 'rf-c7', orderId: 'ord-c7', patientName: 'Mona', orderReference: 'TSH-C7', price: 2400, currency: 'EGP', amountEgp: 1500, requestedAmount: 1500, approvedAmount: null, settledAmount: 1500, status: 'pending', reason: 'patient_request', instapayHandle: '+201000000002', instapayReference: null };
      for (const [k, v] of Object.entries(keep)) if (p[k] !== v) errs.push('existing field ' + k + ' changed: ' + JSON.stringify(p[k]));
      if (!seen.some((s) => /paid_refunded_egp/.test(s))) errs.push('queue SQL does not select paid_refunded_egp');
    }
    const src = read('src/routes/api/admin.js');
    for (const act of ['approve', 'deny', 'mark-paid']) {
      const i = src.indexOf("router.post('/refunds/:id/" + act + "'");
      const h = src.slice(i, src.indexOf('\n  router.', i + 20));
      if (!/refund: await withRefundExtras\(refund\)/.test(h)) errs.push(act + ' response lacks the added fields');
    }
    if (errs.length) t.fail(name, new Error(errs.join('; '))); else t.pass(name);
  } catch (e) {
    t.fail(name, e);
  } finally {
    if (server) server.close();
  }
})();
