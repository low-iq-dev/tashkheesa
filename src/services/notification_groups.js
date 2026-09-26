'use strict';

// Patient notification grouping (26 Sep 2026).
//
// The bell listed every row in `notifications`, and each event writes one row
// PER CHANNEL (internal + email + whatsapp). So one payment reminder showed up
// three times, and ten rows filled the dropdown with near-duplicates. Two fixes
// live here and in routes/patient.js:
//   1. only the in-app (`internal`) row is shown — email/WhatsApp rows are
//      delivery records, not separate updates;
//   2. what remains is grouped by CATEGORY (payments / your cases / messages /
//      account) and repeats of the same template on the same case collapse into
//      one line with a count.

const CATEGORY_ORDER = ['cases', 'payments', 'messages', 'account'];

const CATEGORY_LABELS = {
  cases:    { en: 'Your cases',  ar: 'حالاتك' },
  payments: { en: 'Payments',    ar: 'المدفوعات' },
  messages: { en: 'Messages',    ar: 'الرسائل' },
  account:  { en: 'Account',     ar: 'الحساب' }
};

function categoryFor(template) {
  const t = String(template || '').toLowerCase();
  if (!t) return 'account';
  if (/message|chat|conversation/.test(t)) return 'messages';
  // Unpaid-case expiry/deletion is a payment consequence from the patient's
  // point of view ("you didn't pay, so the spot closed").
  if (/payment|paid|refund|invoice|claim|unpaid|transfer/.test(t)) return 'payments';
  if (/report|order_|case_|sla_|breach|assign|accept|doctor|file|upload|review/.test(t)) return 'cases';
  return 'account';
}

function tsOf(n) {
  const v = n && (n.at || n.created_at || n.timestamp);
  const ms = v ? new Date(v).getTime() : NaN;
  return isNaN(ms) ? 0 : ms;
}

// items: normalized notifications, newest first or in any order. Each needs
// { template, orderId|order_id, at, ... }. isNew is read from `isNew` or, if
// absent, from status !== seen/read.
function groupNotifications(items, opts) {
  const isAr = !!(opts && opts.isAr);
  const list = (Array.isArray(items) ? items : []).filter(Boolean)
    .slice().sort(function (a, b) { return tsOf(b) - tsOf(a); });

  const byCat = {};
  const collapseIndex = {};
  list.forEach(function (n) {
    const cat = categoryFor(n.template);
    const orderId = String(n.orderId || n.order_id || '');
    const isNew = (typeof n.isNew === 'boolean')
      ? n.isNew
      : !/^(seen|read)$/i.test(String(n.status || ''));
    // Timed reminders are one thread per case: payment_reminder_30m / _6h /
    // _24h are the same nudge escalating, so they share a key.
    const family = String(n.template || n.title || '').replace(/_(\d+)(m|h|d)$/i, '');
    const key = cat + '|' + family + '|' + orderId;
    if (collapseIndex[key]) {
      const g = collapseIndex[key];
      g.count += 1;
      if (isNew) g.isNew = true;
      return; // list is newest-first, so the first one kept is the latest
    }
    const entry = Object.assign({}, n, { category: cat, orderId: orderId, isNew: isNew, count: 1 });
    collapseIndex[key] = entry;
    (byCat[cat] = byCat[cat] || []).push(entry);
  });

  return CATEGORY_ORDER
    .filter(function (c) { return byCat[c] && byCat[c].length; })
    .map(function (c) {
      const rows = byCat[c];
      return {
        category: c,
        label: CATEGORY_LABELS[c][isAr ? 'ar' : 'en'],
        unread: rows.filter(function (r) { return r.isNew; }).length,
        latestAt: rows[0] ? (rows[0].at || '') : '',
        items: rows
      };
    })
    // Most recently active category first, so the newest update is on top.
    .sort(function (a, b) { return tsOf({ at: b.latestAt }) - tsOf({ at: a.latestAt }); });
}

module.exports = { categoryFor, groupNotifications, CATEGORY_LABELS, CATEGORY_ORDER };
