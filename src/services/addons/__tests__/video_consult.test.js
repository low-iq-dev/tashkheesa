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

let video, addonService, doctor, order;

test.before(async () => {
  video        = reg.getAddon('video_consult');
  addonService = await getAddonService('video_consult');
  doctor       = await createDisposableDoctor();
  order        = await createDisposableOrder({ doctorId: doctor.id });
});

test.after(async () => {
  await cleanupAll();
  await closePool();
});

test('onPurchase creates order_addons row at status=paid with locked price + commission', async () => {
  const row = await video.onPurchase({ order, addonService, currency: 'EGP' });
  assert.equal(row.order_id, order.id);
  assert.equal(row.addon_service_id, 'video_consult');
  assert.equal(row.status, 'paid');
  assert.equal(row.price_at_purchase_egp, 200);
  assert.equal(row.price_at_purchase_currency, 'EGP');
  assert.equal(row.price_at_purchase_amount, 200);
  assert.equal(row.doctor_commission_pct_at_purchase, 80);
  assert.equal(row.doctor_commission_amount_egp, null);  // not computed yet
});

test('onPurchase is idempotent (second call returns existing row without duplicate)', async () => {
  const again = await video.onPurchase({ order, addonService, currency: 'EGP' });
  assert.equal(again.order_id, order.id);
  // the UNIQUE(order_id, addon_service_id) index protects us; the ON
  // CONFLICT DO UPDATE clause returns the existing row.
  const { queryAll } = require('../../../pg');
  const all = await queryAll(
    `SELECT id FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
    [order.id]
  );
  assert.equal(all.length, 1, 'exactly one order_addons row per order+service');
});

test('onFulfill transitions paid → fulfilled + stores appointment metadata', async () => {
  const existing = await getOrderAddon(
    (await require('../../../pg').queryOne(
      `SELECT id FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
      [order.id]
    )).id
  );
  const updated = await video.onFulfill({
    order, addon: existing, doctor,
    payload: { appointment_id: 'appt-xyz', twilio_room: 'room-1', call_duration_seconds: 720 }
  });
  assert.equal(updated.status, 'fulfilled');
  assert.ok(updated.fulfilled_at);
  assert.equal(updated.metadata_json.appointment_id, 'appt-xyz');
  assert.equal(updated.metadata_json.twilio_room, 'room-1');
  assert.equal(updated.metadata_json.call_duration_seconds, 720);
  assert.equal(updated.metadata_json.doctor_id, doctor.id);
});

test('onComplete inserts addon_earnings row at 80% of locked price', async () => {
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
    [order.id]
  );
  const earnings = await video.onComplete({ order, addon, doctorId: doctor.id });
  assert.ok(earnings);
  assert.equal(earnings.doctor_id, doctor.id);
  assert.equal(earnings.gross_amount_egp, 200);
  assert.equal(earnings.commission_pct, 80);
  assert.equal(earnings.earned_amount_egp, 160);  // 200 * 80 / 100
  assert.equal(earnings.status, 'pending');

  // doctor_commission_amount_egp should be back-written to the addon row
  const refreshed = await getOrderAddon(addon.id);
  assert.equal(refreshed.doctor_commission_amount_egp, 160);
});

test('onComplete is idempotent (second call does not duplicate earnings)', async () => {
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
    [order.id]
  );
  await video.onComplete({ order, addon, doctorId: doctor.id });
  const { queryAll } = require('../../../pg');
  const all = await queryAll(`SELECT id FROM addon_earnings WHERE order_addon_id = $1`, [addon.id]);
  assert.equal(all.length, 1, 'UNIQUE(order_addon_id) enforces one-per-addon');
});

test('onComplete returns null if the addon is not fulfilled', async () => {
  // Fresh order + fresh unfulfilled addon
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  await video.onPurchase({ order: fresh, addonService, currency: 'EGP' });
  const unfulfilled = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
    [fresh.id]
  );
  const result = await video.onComplete({ order: fresh, addon: unfulfilled, doctorId: doctor.id });
  assert.equal(result, null);
  const missing = await getEarningsFor(unfulfilled.id);
  assert.equal(missing, null);
});

test('onRefund transitions paid → refunded + sets refund_pending', async () => {
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  await video.onPurchase({ order: fresh, addonService, currency: 'EGP' });
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'video_consult'`,
    [fresh.id]
  );
  const refunded = await video.onRefund({ order: fresh, addon });
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refund_pending, true);
  assert.ok(refunded.refunded_at);
  // No earnings row
  const earnings = await getEarningsFor(addon.id);
  assert.equal(earnings, null);
});

test('onRefund is a no-op for already fulfilled addons', async () => {
  const fresh = await createDisposableOrder({ doctorId: doctor.id });
  const row = await video.onPurchase({ order: fresh, addonService, currency: 'EGP' });
  await video.onFulfill({ order: fresh, addon: row, doctor, payload: { appointment_id: 'a1' } });
  const refreshed = await getOrderAddon(row.id);
  assert.equal(refreshed.status, 'fulfilled');
  const result = await video.onRefund({ order: fresh, addon: refreshed });
  assert.equal(result, null);
});

test('renderPatientPrompt / renderDoctorPrompt return partial references', () => {
  const p = video.renderPatientPrompt(addonService, { isAr: false });
  assert.equal(typeof p, 'object');
  assert.equal(p.partial, 'addons/checkbox_patient');
  assert.equal(p.locals.title, addonService.name_en);

  const pAr = video.renderPatientPrompt(addonService, { isAr: true });
  assert.equal(pAr.locals.title, addonService.name_ar);

  const d = video.renderDoctorPrompt(order, { status: 'paid' }, { isAr: false });
  assert.equal(d.partial, 'addons/video_card_doctor');
});
