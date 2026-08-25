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

// 2026-08-24 — read the catalogue instead of hardcoding it. The literals here
// (400 EGP, 80%) were already wrong against the seeded row (50%), and migration
// 088 reprices to 300. A lifecycle test should assert that onPurchase snapshots
// WHAT THE REGISTRY SAYS and that onComplete pays that percentage OF that
// snapshot — the arithmetic, not one frozen instance of it.
async function catalogueRx() {
  const row = await require('../../../pg').queryOne(
    `SELECT base_price_egp, doctor_commission_pct FROM addon_services WHERE id = 'prescription'`
  );
  assert.ok(row, 'prescription must be seeded in addon_services');
  return { egp: Math.round(Number(row.base_price_egp)), pct: Math.round(Number(row.doctor_commission_pct)) };
}

test('onPurchase creates order_addons row at status=paid (awaits doctor attach)', async () => {
  const cat = await catalogueRx();
  const row = await presc.onPurchase({ order, addonService, currency: 'EGP' });
  assert.equal(row.order_id, order.id);
  assert.equal(row.status, 'paid');
  assert.equal(row.price_at_purchase_egp, cat.egp);
  assert.equal(row.doctor_commission_pct_at_purchase, cat.pct);
  assert.equal(row.refund_pending, false);
});

test('onPurchase snapshots the CHARGED price over the catalogue price', async () => {
  // The defect this guards: prescription.onPurchase used to ignore what the
  // patient actually paid and snapshot addon_services.base_price_egp, so a
  // charge of 350 against a catalogue of 400 paid the doctor a percentage of
  // 400. video_consult was fixed for this in FIX 9; prescription was not, until
  // 2026-08-24.
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  const row = await presc.onPurchase({
    order: fresh, addonService, currency: 'EGP',
    chargedPriceEgp: 275, chargedAmount: 275
  });
  assert.equal(row.price_at_purchase_egp, 275, 'must use the charged price, not the catalogue');
  assert.equal(row.price_at_purchase_amount, 275);
});

test('onPurchase keeps the local charged amount separate from the EGP base', async () => {
  // price_at_purchase_egp is the commission base and must be EGP;
  // price_at_purchase_amount is what the patient paid, in their currency.
  // Writing the EGP figure into both stamped "SAR 300" on a 109 SAR sale.
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  const row = await presc.onPurchase({
    order: fresh, addonService, currency: 'SAR',
    chargedPriceEgp: 300, chargedAmount: 109
  });
  assert.equal(row.price_at_purchase_egp, 300);
  assert.equal(row.price_at_purchase_amount, 109);
  assert.equal(String(row.price_at_purchase_currency).toUpperCase(), 'SAR');
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

test('onComplete inserts addon_earnings at the snapshotted pct of the snapshotted price', async () => {
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'prescription'`, [order.id]
  );
  const gross = Number(addon.price_at_purchase_egp);
  const pct = Number(addon.doctor_commission_pct_at_purchase);
  const expected = Math.round(gross * pct / 100);

  const earnings = await presc.onComplete({ order, addon, doctorId: doctor.id });
  assert.ok(earnings);
  // The point is that the earning is derived from the ROW, not from whatever
  // the catalogue happens to say at completion time — a price change between
  // purchase and completion must never reprice a sale that already happened.
  assert.equal(earnings.gross_amount_egp, gross);
  assert.equal(earnings.commission_pct, pct);
  assert.equal(earnings.earned_amount_egp, expected);
  assert.equal(earnings.status, 'pending');
  const refreshed = await getOrderAddon(addon.id);
  assert.equal(refreshed.doctor_commission_amount_egp, expected);
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
