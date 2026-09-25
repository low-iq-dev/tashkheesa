'use strict';

// 2026-09-26 — verify-claim hardening. Hermetic: no DB.
//   * isClosedUnpayable is exactly the dead ends (cancelled / expired-unpaid /
//     refunded), NOT the wider !isPayableStatus — an operator must still be able
//     to repair an ASSIGNED case whose payment facts were missing.
//   * All three operator write paths consult it: Command verify (409
//     ORDER_NOT_PAYABLE), superadmin web mark-paid, admin web mark-paid.
//   * Both web mark-paid routes default the recorded method to bank_transfer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isClosedUnpayable } = require('../../src/case_lifecycle');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

test('isClosedUnpayable: dead ends only, any spelling', () => {
  for (const s of ['cancelled', 'CANCELLED', 'canceled', 'expired_unpaid', 'EXPIRED_UNPAID', 'refunded', 'REFUNDED']) {
    assert.equal(isClosedUnpayable(s), true, s);
  }
  for (const s of ['submitted', 'SUBMITTED', 'draft', 'paid', 'assigned', 'in_review', 'completed', '', null, undefined]) {
    assert.equal(isClosedUnpayable(s), false, String(s));
  }
});

test('Command verify refuses a closed case with 409 ORDER_NOT_PAYABLE', () => {
  const src = read('src/services/admin_verify_claim.js');
  assert.match(src, /isClosedUnpayable\(order\.status\)/);
  assert.match(src, /409, 'ORDER_NOT_PAYABLE'/);
  // The guard sits before any write.
  assert.ok(src.indexOf("'ORDER_NOT_PAYABLE'") < src.indexOf('UPDATE orders'), 'guard must precede the orders UPDATE');
});

test('superadmin web mark-paid: refuses closed cases, defaults to bank_transfer', () => {
  const src = read('src/routes/superadmin.js');
  const start = src.indexOf("router.post('/superadmin/orders/:id/mark-paid'");
  const body = src.slice(start, start + 4000);
  assert.match(body, /isClosedUnpayable\(order\.status\)/);
  assert.match(body, /payment=not_payable/);
  assert.match(body, /\|\| 'bank_transfer'\)\.trim\(\)/);
  assert.ok(body.indexOf('isClosedUnpayable') < body.indexOf('UPDATE orders'), 'guard must precede the UPDATE');
});

test('admin web mark-paid: refuses closed cases, defaults to bank_transfer', () => {
  const src = read('src/routes/admin.js');
  const start = src.indexOf("router.post('/admin/orders/:id/mark-paid'");
  const body = src.slice(start, start + 2500);
  assert.match(body, /SELECT id, status, payment_status FROM orders_active/);
  assert.match(body, /isClosedUnpayable\(order\.status\)/);
  assert.doesNotMatch(body, /'manual'/, 'the default method is no longer manual');
  assert.ok(body.indexOf('isClosedUnpayable') < body.indexOf('UPDATE orders'), 'guard must precede the UPDATE');
});

test('superadmin order page explains the not_payable refusal', () => {
  const src = read('src/views/superadmin_order_detail.ejs');
  assert.match(src, /_paymentNotice === 'not_payable'/);
});

test('superadmin web refuses practice cases on mark-paid, reassign and extend-sla', () => {
  const src = read('src/routes/superadmin.js');
  for (const route of ['mark-paid', 'reassign', 'extend-sla']) {
    const start = src.indexOf(`router.post('/superadmin/orders/:id/${route}'`);
    assert.ok(start > 0, route);
    const body = src.slice(start, start + 3000);
    const guard = body.indexOf('order.is_practice === true');
    assert.ok(guard > 0, `${route} checks is_practice`);
    const firstWrite = body.search(/UPDATE orders|execute\(|reassignCase|assignDoctor/);
    assert.ok(firstWrite < 0 || guard < firstWrite, `${route}: guard precedes the first write`);
  }
  assert.match(src, /o\.patient_id, o\.is_practice, u\.name AS patient_name/, 'loadOrderWithPatient selects is_practice');
  assert.match(read('src/views/superadmin_order_detail.ejs'), /_flashError === 'practice_case'/);
});
