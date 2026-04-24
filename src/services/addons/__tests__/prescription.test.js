'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../registry');
const {
  createDisposableDoctor,
  createDisposableOrder,
  getAddonService,
  getOrderAddon,
  getEarningsFor,
  cleanupAll,
  closePool
} = require('./_helpers');

let presc, addonService, doctor, order;

test.before(async () => {
  presc        = reg.getAddon('prescription');
  addonService = await getAddonService('prescription');
  doctor       = await createDisposableDoctor();
  order        = await createDisposableOrder({ doctorId: doctor.id });
});

test.after(async () => {
  await cleanupAll();
  await closePool();
});

test('onPurchase creates order_addons row at status=paid (awaits doctor attach)', async () => {
  const row = await presc.onPurchase({ order, addonService, currency: 'EGP' });
  assert.equal(row.order_id, order.id);
  assert.equal(row.status, 'paid');
  assert.equal(row.price_at_purchase_egp, 400);
  assert.equal(row.doctor_commission_pct_at_purchase, 80);
  assert.equal(row.refund_pending, false);
});

test('onFulfill requires at least one of pdf_storage_key or text_body', async () => {
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'prescription'`, [order.id]
  );
  await assert.rejects(
    async () => { await presc.onFulfill({ order, addon, doctor, payload: {} }); },
    /pdf_storage_key or text_body/
  );
});

test('onFulfill with pdf_storage_key stores attachment metadata', async () => {
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'prescription'`, [order.id]
  );
  const updated = await presc.onFulfill({
    order, addon, doctor,
    payload: { pdf_storage_key: 'doctor-prescriptions/' + order.id + '/1234.pdf' }
  });
  assert.equal(updated.status, 'fulfilled');
  assert.ok(updated.fulfilled_at);
  assert.equal(updated.metadata_json.pdf_storage_key, 'doctor-prescriptions/' + order.id + '/1234.pdf');
  assert.equal(updated.metadata_json.text_body, null);
  assert.ok(updated.metadata_json.attached_at);
  assert.equal(updated.metadata_json.attached_by, doctor.id);
});

test('onComplete inserts addon_earnings at 80% of 400 EGP = 320 EGP', async () => {
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'prescription'`, [order.id]
  );
  const earnings = await presc.onComplete({ order, addon, doctorId: doctor.id });
  assert.ok(earnings);
  assert.equal(earnings.gross_amount_egp, 400);
  assert.equal(earnings.commission_pct, 80);
  assert.equal(earnings.earned_amount_egp, 320);
  assert.equal(earnings.status, 'pending');
  const refreshed = await getOrderAddon(addon.id);
  assert.equal(refreshed.doctor_commission_amount_egp, 320);
});

test('onComplete returns null if prescription is not fulfilled (no accidental payout)', async () => {
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  await presc.onPurchase({ order: fresh, addonService, currency: 'EGP' });
  const unfulfilled = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'prescription'`, [fresh.id]
  );
  const result = await presc.onComplete({ order: fresh, addon: unfulfilled, doctorId: doctor.id });
  assert.equal(result, null);
  assert.equal(await getEarningsFor(unfulfilled.id), null);
});

test('onRefund transitions paid → refunded for unfulfilled addon', async () => {
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  await presc.onPurchase({ order: fresh, addonService, currency: 'EGP' });
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'prescription'`, [fresh.id]
  );
  const refunded = await presc.onRefund({ order: fresh, addon });
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refund_pending, true);
  assert.ok(refunded.refunded_at);
  // No earnings written
  assert.equal(await getEarningsFor(addon.id), null);
});

test('onRefund is a no-op once the addon is fulfilled', async () => {
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  const row = await presc.onPurchase({ order: fresh, addonService, currency: 'EGP' });
  await presc.onFulfill({ order: fresh, addon: row, doctor, payload: { text_body: 'Rx: ...' } });
  const refreshed = await getOrderAddon(row.id);
  const result = await presc.onRefund({ order: fresh, addon: refreshed });
  assert.equal(result, null);
});

test('renderPatientPrompt / renderDoctorPrompt return partial references', () => {
  const p = presc.renderPatientPrompt(addonService, { isAr: false });
  assert.equal(p.partial, 'addons/checkbox_patient');
  assert.equal(p.locals.title, addonService.name_en);
  assert.match(p.locals.desc, /digital prescription/i);

  const pAr = presc.renderPatientPrompt(addonService, { isAr: true });
  assert.equal(pAr.locals.title, addonService.name_ar);

  const d = presc.renderDoctorPrompt(order, { status: 'paid' }, { isAr: false });
  assert.equal(d.partial, 'addons/prescription_card_doctor');
});
