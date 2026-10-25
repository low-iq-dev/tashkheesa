'use strict';

// src/services/app_payment_return.js
//
// 2026-10-11 — the page that hands a patient back to the mobile app after the
// hosted card checkout (GET /portal/patient/payment-return/k/:id/app, in
// routes/patient.js).
//
// The app opens the card page in the system browser sheet. A sheet has to be
// told when to close: this page navigates it to the app's own link,
// tashkheesa://payment-return, which the sheet hands to the app.
//
// Pure (no database, no request object) so the link and the page can be tested
// exactly. NOTHING here knows or says whether the payment succeeded: the link
// carries a case id and at most a "the provider said failed" hint, and the app
// treats it as "ask the server now". The signed webhook is still the only
// thing that marks an order paid.

const APP_PAYMENT_RETURN_URL = 'tashkheesa://payment-return';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FAILED_STATUSES = ['FAILURE', 'FAILED', 'CANCELLED', 'CANCELED'];

/** Same reading of Kashier's return parameters as the web landing. */
function isFailedReturn(query) {
  const q = query || {};
  const status = String(q.paymentStatus || q.status || '').trim().toUpperCase();
  return FAILED_STATUSES.indexOf(status) !== -1;
}

/**
 * tashkheesa://payment-return?status=returned|failed[&caseId=<id>]
 * Only a plain id is echoed into the link; anything else is left out and the
 * app falls back to the case it already has open.
 */
function buildAppReturnLink(orderId, failed) {
  const id = String(orderId == null ? '' : orderId).trim();
  return APP_PAYMENT_RETURN_URL +
    '?status=' + (failed ? 'failed' : 'returned') +
    (SAFE_ID.test(id) ? '&caseId=' + encodeURIComponent(id) : '');
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {object} a
 * @param {string} a.orderId
 * @param {boolean} a.failed
 * @param {boolean} a.isAr
 * @param {string} [a.nonce]  CSP nonce for the one inline script
 */
function renderAppReturnPage(a) {
  const isAr = !!a.isAr;
  const failed = !!a.failed;
  const link = escAttr(buildAppReturnLink(a.orderId, failed));
  const nonce = a.nonce ? String(a.nonce).replace(/[^A-Za-z0-9+/=_-]/g, '') : '';
  return (
    '<!doctype html><html lang="' + (isAr ? 'ar' : 'en') + '" dir="' + (isAr ? 'rtl' : 'ltr') + '">' +
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    // Three ways back, because browsers differ in what they allow without a
    // tap: the refresh, the script, and — always — the button.
    '<meta http-equiv="refresh" content="0;url=' + link + '">' +
    '<title>Tashkheesa</title></head>' +
    '<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;background:#F8F5EF;color:#12312C;">' +
    '<div style="max-width:420px;margin:18vh auto 0;padding:28px 24px;text-align:center;">' +
    '<h1 style="font-size:22px;margin:0 0 12px;">' +
    (failed
      ? (isAr ? 'الدفع لم يكتمل' : 'Payment was not completed')
      : (isAr ? 'شكراً — جاري تأكيد الدفع' : 'Thank you — confirming your payment')) +
    '</h1><p style="font-size:15px;line-height:1.7;margin:0 0 20px;color:#3d5a55;">' +
    (isAr ? 'ارجع للتطبيق عشان تتابع حالتك.' : 'Go back to the app to follow your case.') +
    '</p><a id="back" href="' + link + '" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#0B6B5F;color:#fff;text-decoration:none;font-weight:600;">' +
    (isAr ? 'ارجع للتطبيق' : 'Return to the app') + '</a></div>' +
    '<script' + (nonce ? ' nonce="' + nonce + '"' : '') + '>' +
    'try{window.location.replace(document.getElementById("back").getAttribute("href"));}catch(e){}' +
    '</script></body></html>'
  );
}

module.exports = { APP_PAYMENT_RETURN_URL, isFailedReturn, buildAppReturnLink, renderAppReturnPage };
