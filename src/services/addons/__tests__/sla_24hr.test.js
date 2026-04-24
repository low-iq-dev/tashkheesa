'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../registry');
const {
  createDisposableOrder,
  getAddonService,
  getOrderAddon,
  getEarningsFor,
  cleanupAll,
  closePool
} = require('./_helpers');

let sla, addonService, order;

test.before(async () => {
  sla          = reg.getAddon('sla_24hr');
  addonService = await getAddonService('sla_24hr');
  order        = await createDisposableOrder({});
});

test.after(async () => {
  await cleanupAll();
  await closePool();
});

test('onPurchase creates order_addons row at status=fulfilled (no doctor step)', async () => {
  const row = await sla.onPurchase({ order, addonService, currency: 'EGP' });
  assert.equal(row.order_id, order.id);
  assert.equal(row.status, 'fulfilled');
  assert.ok(row.fulfilled_at);
  assert.equal(row.price_at_purchase_egp, 100);
  assert.equal(row.doctor_commission_pct_at_purchase, 0);
  assert.deepEqual(row.metadata_json, { new_sla_hours: 24 });
});

test('onPurchase flips orders.sla_hours to 24', async () => {
  const refreshed = await require('../../../pg').queryOne(
    `SELECT sla_hours FROM orders WHERE id = $1`, [order.id]
  );
  assert.equal(refreshed.sla_hours, 24);
});

test('onFulfill / onComplete / onRefund are all no-ops', async () => {
  const addon = await require('../../../pg').queryOne(
    `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = 'sla_24hr'`, [order.id]
  );
  assert.equal(await sla.onFulfill({ order, addon, doctor: null }), null);
  assert.equal(await sla.onComplete({ order, addon, doctorId: null }), null);
  assert.equal(await sla.onRefund({ order, addon }), null);
  // No addon_earnings row should ever exist for an SLA addon
  const earnings = await getEarningsFor(addon.id);
  assert.equal(earnings, null);
  // Status unchanged
  const refreshed = await getOrderAddon(addon.id);
  assert.equal(refreshed.status, 'fulfilled');
});

test('renderPatientPrompt returns a partial reference', () => {
  const p = sla.renderPatientPrompt(addonService, { isAr: false });
  assert.equal(p.partial, 'addons/checkbox_patient');
  assert.equal(p.locals.title, addonService.name_en);
});

test('renderDoctorPrompt returns the SLA badge partial', () => {
  const d = sla.renderDoctorPrompt(order, { status: 'fulfilled' }, { isAr: false });
  assert.equal(d.partial, 'addons/sla_badge_doctor');
  assert.equal(d.locals.label, '24-hour priority');

  const dAr = sla.renderDoctorPrompt(order, { status: 'fulfilled' }, { isAr: true });
  assert.equal(dAr.locals.label, 'أولوية 24 ساعة');
});
