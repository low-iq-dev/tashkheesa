'use strict';
// tests/services/kashier-webhook.test.js
//
// 2026-10-05 — Kashier card gateway.
//
// The webhook is the only thing that can turn a Kashier payment into a PAID
// case, so every way it could be wrong in the expensive direction is pinned
// here: a forged signature, the right signature over the wrong amount, a
// refund read as a payment, an unsigned `event` promoted to "paid", the same
// transaction delivered twice, and a TEST-mode payment settling a real
// patient's case.
//
// processKashierEvent takes its dependencies as an argument, so these run
// against an in-memory order + payment_events with no database.

const crypto = require('crypto');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💳 kashier webhook + checkout\n');

const sigLib = require('../../src/kashier-signature.js');
const kashier = require('../../src/services/kashier.js');
const { processKashierEvent } = require('../../src/routes/payments_kashier.js');

const API_KEY = 'unit_test_payment_api_key';
const ORDER_ID = '3f1c2b4a-1111-4222-8333-444455556666';
const PATIENT_ID = 'patient-1';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function sign(data) {
  const subject = sigLib.buildSignatureString(data, data.signatureKeys);
  return crypto.createHmac('sha256', API_KEY).update(subject, 'utf8').digest('hex');
}

function payload(over, event) {
  const data = Object.assign({
    amount: 750,
    channel: 'online | e-commerce',
    currency: 'EGP',
    kashierOrderId: 'k-order-1',
    merchantOrderId: ORDER_ID + '--abc123',
    method: 'card',
    orderReference: 'TEST-ORD-1',
    status: 'SUCCESS',
    transactionId: 'TX-1',
    transactionResponseCode: '00',
    signatureKeys: ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId',
      'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode']
  }, over || {});
  return { event: event || 'pay', data: data };
}

function world(opts) {
  const o = opts || {};
  const w = {
    order: o.order === null ? null : Object.assign({
      id: ORDER_ID, patient_id: PATIENT_ID, doctor_id: null,
      status: 'submitted', payment_status: 'unpaid',
      price: 750, currency: 'EGP', addons_json: null,
      urgency_tier: 'standard', sla_hours: null, deadline_at: null
    }, o.order || {}),
    events: [],          // payment_events rows
    alerts: [],
    notifications: [],
    markCasePaid: 0,
    addonsSettled: 0,
    cfg: Object.assign({ selected: true, configured: true, mode: 'live', apiKey: API_KEY, testPatientIds: [] }, o.cfg || {})
  };
  const d = {
    pool: {
      connect: async function () {
        return {
          query: async function (sql) {
            if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }] };
            return { rows: [] };
          },
          release: function () {}
        };
      }
    },
    queryOne: async function (sql, params) {
      if (/FROM orders_active/.test(sql)) return w.order && w.order.id === params[0] ? w.order : null;
      if (/FROM payment_events WHERE paymob_transaction_id/.test(sql)) {
        return w.events.find(function (e) { return e.txn === params[0]; }) || null;
      }
      return null;
    },
    execute: async function (sql, params) {
      if (/INSERT INTO payment_events/.test(sql) && /ON CONFLICT/.test(sql)) {
        if (w.events.some(function (e) { return e.txn === params[2]; })) return { rowCount: 0 };
        w.events.push({ txn: params[2], event_type: params[3], order_id: params[1] });
        return { rowCount: 1 };
      }
      if (/INSERT INTO payment_events/.test(sql)) {
        const m = sql.match(/'(hmac_failure|amount_mismatch)'/);
        w.events.push({ txn: null, event_type: m ? m[1] : 'other' });
        return { rowCount: 1 };
      }
      if (/UPDATE payment_events\s+SET received_at/.test(sql)) return { rowCount: 0 }; // no stale takeover
      if (/UPDATE payment_events SET event_type/.test(sql)) {
        w.events.forEach(function (e) {
          if (e.txn === params[0] && e.event_type === params[2]) e.event_type = params[1];
        });
        return { rowCount: 1 };
      }
      if (/UPDATE orders\s+SET payment_status = 'paid'/.test(sql)) {
        if (w.order && String(w.order.payment_status).toLowerCase() !== 'paid') {
          w.order.payment_status = 'paid';
          w.order.payment_method = params[1];
          w.order.paymob_transaction_id = params[5];
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }
      return { rowCount: 0 };
    },
    kashier: {
      readConfig: function () { return w.cfg; },
      amountToCents: kashier.amountToCents
    },
    verifyKashierSignature: sigLib.verifyKashierSignature,
    SIGNATURE_HEADER: sigLib.SIGNATURE_HEADER,
    orderIdFromReference: require('../../src/routes/payments.js').orderIdFromReference,
    getOrCreatePaymentUrl: async function () { return '/portal/patient/pay/' + ORDER_ID; },
    owedCentsForOrder: require('../../src/services/order_pricing.js').owedCentsForOrder,
    markCasePaid: async function () {
      w.markCasePaid++;
      w.order.status = 'paid'; w.order.deadline_at = 'x'; w.order.sla_hours = 48;
    },
    settleAddonsForPaidOrder: async function () { w.addonsSettled++; },
    queueMultiChannelNotification: async function (n) { w.notifications.push(n.template); },
    notifyAdmins: async function (n) { w.notifications.push('admin:' + n.template); },
    logOrderEvent: function () {},
    logErrorToDb: function () {},
    sendCriticalAlert: function (msg, key) { w.alerts.push(key); },
    pushOpsEvent: async function () {}
  };
  w.d = d;
  w.send = function (body, sigOverride) {
    return processKashierEvent({
      body: body,
      headerSig: sigOverride !== undefined ? sigOverride : sign(body.data),
      ip: '127.0.0.1'
    }, d);
  };
  return w;
}

// Run one after another: several cases set process.env and the fetch stub.
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async function () {
    try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
  });
}

// ── signature: the documented vector ───────────────────────────────────────
check('signature matches Kashier\'s documented example (values are URL-encoded)', function () {
  const data = {
    amount: 1, channel: 'online | e-commerce', currency: 'EGP',
    kashierOrderId: '9ad06b17-755b-4e21-9774-aff3e2726ac9',
    merchantOrderId: '1653481557813', method: 'card',
    orderReference: 'TEST-ORD-38855', status: 'SUCCESS',
    transactionId: 'TX-249893963', transactionResponseCode: '00',
    signatureKeys: ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId',
      'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode']
  };
  assert(sigLib.buildSignatureString(data, data.signatureKeys) ===
    'amount=1&channel=online%20%7C%20e-commerce&currency=EGP&kashierOrderId=9ad06b17-755b-4e21-9774-aff3e2726ac9&merchantOrderId=1653481557813&method=card&orderReference=TEST-ORD-38855&status=SUCCESS&transactionId=TX-249893963&transactionResponseCode=00',
    'signature string differs from the documented one');
  const r = sigLib.verifyKashierSignature({ event: 'pay', data: data },
    '9610477b2255b2a8ef84fd89adfaa5f1305ff9c20324205851890f1ea03109f4', '11111');
  assert(r.ok, 'documented signature rejected: ' + r.reason);
});

// ── the paid path ──────────────────────────────────────────────────────────
check('a signed SUCCESS pay for the exact amount marks the case paid once', async function () {
  const w = world();
  const out = await w.send(payload());
  assert(out.http === 200 && out.json.ok, 'expected 200 ok, got ' + JSON.stringify(out));
  assert(w.order.payment_status === 'paid', 'order not paid');
  assert(w.markCasePaid === 1, 'markCasePaid calls: ' + w.markCasePaid);
  assert(w.addonsSettled === 1, 'add-ons not settled');
  assert(w.notifications.indexOf('payment_success_patient') !== -1, 'patient not notified');
  assert(w.order.paymob_transaction_id === 'kashier:TX-1', 'transaction id not recorded');
});

check('the order id is recovered from a per-attempt reference (uuid--attempt)', async function () {
  const w = world();
  const out = await w.send(payload({ merchantOrderId: ORDER_ID + '--zz9' }));
  assert(out.http === 200 && w.order.payment_status === 'paid', 'not settled');
});

check('"750.00" as a string is the same money as 750', async function () {
  const w = world();
  await w.send(payload({ amount: '750.00' }));
  assert(w.order.payment_status === 'paid', 'string amount refused');
});

check('the same transaction delivered twice settles once', async function () {
  const w = world();
  await w.send(payload());
  const again = await w.send(payload());
  assert(again.http === 200 && again.json.idempotent === true, 'replay not idempotent: ' + JSON.stringify(again));
  assert(w.markCasePaid === 1, 'markCasePaid ran ' + w.markCasePaid + ' times');
});

check('PENDING then SUCCESS for one transactionId still settles', async function () {
  const w = world();
  const p = await w.send(payload({ status: 'PENDING' }));
  assert(p.http === 200 && w.order.payment_status !== 'paid', 'pending must not pay');
  await w.send(payload({ status: 'SUCCESS' }));
  assert(w.order.payment_status === 'paid', 'success after pending was swallowed');
});

// ── everything that must NOT pay ───────────────────────────────────────────
check('a bad signature is 401 and changes nothing', async function () {
  const w = world();
  const out = await w.send(payload(), 'deadbeef');
  assert(out.http === 401, 'expected 401, got ' + out.http);
  assert(w.order.payment_status !== 'paid' && w.markCasePaid === 0, 'paid on a bad signature');
  assert(w.alerts.indexOf('kashier_hmac_failure') !== -1, 'no alert');
});

check('a valid signature made with a DIFFERENT key (test vs live) is refused', async function () {
  const w = world();
  const body = payload();
  const subject = sigLib.buildSignatureString(body.data, body.data.signatureKeys);
  const otherKeySig = crypto.createHmac('sha256', 'some_other_mode_key').update(subject).digest('hex');
  const out = await w.send(body, otherKeySig);
  assert(out.http === 401 && w.order.payment_status !== 'paid', 'cross-mode signature accepted');
});

check('amount tampered after signing is refused', async function () {
  const w = world();
  const body = payload();
  const sig = sign(body.data);
  body.data.amount = 1;
  const out = await w.send(body, sig);
  assert(out.http === 401 && w.order.payment_status !== 'paid', 'tampered amount accepted');
});

check('a correctly signed payment for the WRONG amount leaves the case unpaid and pages', async function () {
  const w = world();
  const out = await w.send(payload({ amount: 1 }));
  assert(out.http === 200 && out.json.amount_mismatch === true, 'expected amount_mismatch ack');
  assert(w.order.payment_status !== 'paid' && w.markCasePaid === 0, 'paid on a mismatch');
  assert(w.alerts.indexOf('kashier_amount_mismatch') !== -1, 'no mismatch alert');
});

check('the wrong currency is an amount mismatch', async function () {
  const w = world();
  const out = await w.send(payload({ currency: 'USD' }));
  assert(out.json.amount_mismatch === true && w.order.payment_status !== 'paid', 'USD 750 accepted for EGP 750');
});

check('add-ons are part of what is owed', async function () {
  const w = world({ order: { addons_json: JSON.stringify({ prescription: true, prescription_price: 300 }) } });
  const short = await w.send(payload({ amount: 750 }));
  assert(short.json.amount_mismatch === true, 'base-only amount accepted when an add-on was selected');
  const w2 = world({ order: { addons_json: JSON.stringify({ prescription: true, prescription_price: 300 }) } });
  await w2.send(payload({ amount: 1050 }));
  assert(w2.order.payment_status === 'paid', 'full amount with add-on refused');
});

['refund', 'partial_refund', 'void', 'reversal'].forEach(function (ev) {
  check('a ' + ev + ' with status SUCCESS never marks a case paid', async function () {
    const w = world();
    const out = await w.send(payload({}, ev));
    assert(out.http === 200 && out.json.refund_or_void === true, 'not treated as a reversal');
    assert(w.order.payment_status !== 'paid' && w.markCasePaid === 0, ev + ' marked the case paid');
    assert(w.alerts.indexOf('kashier_refund_or_void') !== -1, 'no alert');
  });
});

check('SUCCESS on an event we have no rule for (authorize) is not a payment', async function () {
  const w = world();
  const out = await w.send(payload({}, 'authorize'));
  assert(out.http === 200 && w.order.payment_status !== 'paid', 'authorize marked paid');
  assert(w.alerts.indexOf('kashier_unrecognised_event') !== -1, 'no alert for an unrecognised success');
});

check('FAILURE tells the patient and leaves the case unpaid', async function () {
  const w = world();
  const out = await w.send(payload({ status: 'FAILURE' }));
  assert(out.http === 200 && w.order.payment_status !== 'paid', 'failure paid');
  assert(w.notifications.indexOf('payment_failed_patient') !== -1, 'patient not told');
});

check('an unknown order is 503 (so Kashier retries) and pages', async function () {
  const w = world({ order: null });
  const out = await w.send(payload());
  assert(out.http === 503, 'expected 503, got ' + out.http);
  assert(w.alerts.indexOf('kashier_order_not_found') !== -1, 'no alert');
});

check('an already-paid case is acknowledged without re-running the lifecycle', async function () {
  const w = world({ order: { payment_status: 'paid', status: 'paid', deadline_at: 'x', sla_hours: 48 } });
  const out = await w.send(payload());
  assert(out.http === 200 && w.markCasePaid === 0, 'lifecycle re-ran on a paid case');
});

// ── test mode on production ────────────────────────────────────────────────
check('TEST mode: a real patient\'s case is never settled by a test payment', async function () {
  const w = world({ cfg: { mode: 'test', testPatientIds: ['someone-else'] } });
  const out = await w.send(payload());
  assert(out.http === 200 && out.json.test_mode_refused === true, 'not refused: ' + JSON.stringify(out));
  assert(w.order.payment_status !== 'paid' && w.markCasePaid === 0, 'test payment settled a real case');
});

check('TEST mode: an allowlisted test account settles normally', async function () {
  const w = world({ cfg: { mode: 'test', testPatientIds: [PATIENT_ID] } });
  await w.send(payload());
  assert(w.order.payment_status === 'paid', 'test account not settled');
});

check('no API key configured → 503, nothing read', async function () {
  const w = world({ cfg: { apiKey: '' } });
  const out = await w.send(payload());
  assert(out.http === 503 && w.order.payment_status !== 'paid', 'processed without a key');
});

// ── client + flags ─────────────────────────────────────────────────────────
function withEnv(vars, fn) {
  const keys = ['CARD_PROVIDER', 'KASHIER_MODE', 'KASHIER_MERCHANT_ID', 'KASHIER_PAYMENT_API_KEY',
    'KASHIER_SECRET_KEY', 'KASHIER_TEST_PATIENT_IDS', 'CARD_PAYMENT_ENABLED', 'BASE_URL', 'APP_URL'];
  const saved = {};
  keys.forEach(function (k) { saved[k] = process.env[k]; delete process.env[k]; });
  Object.keys(vars).forEach(function (k) { process.env[k] = vars[k]; });
  const restore = function () {
    keys.forEach(function (k) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.then(function (v) { restore(); return v; }, function (e) { restore(); throw e; });
  restore();
  return r;
}
const KEYS = { KASHIER_MERCHANT_ID: 'MID-1-1', KASHIER_PAYMENT_API_KEY: 'k', KASHIER_SECRET_KEY: 's' };

// These mutate process.env, so they run one after another, after the async
// webhook cases above have been scheduled (those never read the environment).
check('money conversion: cents ⇄ Kashier decimal strings', function () {
  assert(kashier.centsToAmountString(75000) === '750.00', 'centsToAmountString');
  assert(kashier.centsToAmountString(105050) === '1050.50', 'centsToAmountString decimals');
  assert(kashier.amountToCents(750) === 75000 && kashier.amountToCents('750.00') === 75000 && kashier.amountToCents('1050.5') === 105050, 'amountToCents');
  assert(Number.isNaN(kashier.amountToCents('7,50')) && Number.isNaN(kashier.amountToCents('abc')) &&
    Number.isNaN(kashier.amountToCents(null)) && Number.isNaN(kashier.amountToCents('-5')), 'junk amounts must be NaN');
});

check('flags: nothing changes until CARD_PROVIDER=kashier; test mode is allowlist-only', function () {
  const mp = require('../../src/services/manual_payment.js');
  withEnv({}, function () {
    assert(kashier.isSelected() === false, 'selected with no env');
    assert(mp.isCardPaymentEnabledFor('p1') === mp.isCardPaymentEnabled(), 'default card flag changed');
  });
  withEnv({ CARD_PROVIDER: 'kashier' }, function () {
    assert(kashier.isAvailableForPatient('p1') === false, 'available without keys');
    assert(mp.isCardPaymentEnabledFor('p1') === false, 'card shown without keys');
  });
  withEnv(Object.assign({ CARD_PROVIDER: 'kashier', KASHIER_TEST_PATIENT_IDS: 'p1, p2' }, KEYS), function () {
    assert(kashier.readConfig().mode === 'test', 'default mode must be test');
    assert(kashier.isAvailableForPatient('p1') && kashier.isAvailableForPatient('p2'), 'test account not allowed');
    assert(!kashier.isAvailableForPatient('p3'), 'non-test account allowed in test mode');
    assert(mp.isCardPaymentEnabledFor('p1') === true && mp.isCardPaymentEnabledFor('p3') === false, 'isCardPaymentEnabledFor');
  });
  withEnv(Object.assign({ CARD_PROVIDER: 'kashier', KASHIER_MODE: 'live' }, KEYS), function () {
    assert(kashier.isAvailableForPatient('anyone'), 'live mode must be open to all');
    assert(kashier.readConfig().baseUrl === 'https://api.kashier.io', 'live base url');
  });
  withEnv(Object.assign({ CARD_PROVIDER: 'kashier', KASHIER_MODE: 'live', CARD_PAYMENT_ENABLED: 'false' }, KEYS), function () {
    assert(mp.isCardPaymentEnabledFor('anyone') === false, 'CARD_PAYMENT_ENABLED=false must still switch the card off');
  });
});

check('createSession sends the documented request and returns the hosted URL', async function () {
  let seen = null;
  kashier.__setFetch(async function (url, opts) {
    seen = { url: url, opts: opts, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async function () {
      return JSON.stringify({ _id: 'sess1', sessionUrl: 'https://payments.kashier.io/session/sess1?mode=test', status: 'CREATED' });
    } };
  });
  try {
    const out = await withEnv(Object.assign({ CARD_PROVIDER: 'kashier' }, KEYS), function () {
      return kashier.createSession({
        orderRef: ORDER_ID + '--a1', amountCents: 75000, currency: 'EGP',
        redirectUrl: 'https://tashkheesa.com/portal/patient/payment-return/k/' + ORDER_ID,
        webhookUrl: 'https://tashkheesa.com/payments/kashier/webhook', lang: 'ar',
        customer: { reference: 'patient-1', email: 'not-an-email' }
      });
    });
    assert(seen.url === 'https://test-api.kashier.io/v3/payment/sessions', 'url: ' + seen.url);
    assert(seen.opts.headers.Authorization === 's' && seen.opts.headers['api-key'] === 'k', 'auth headers');
    assert(seen.body.amount === '750.00' && seen.body.currency === 'EGP' && seen.body.merchantId === 'MID-1-1', 'amount/currency/mid');
    assert(seen.body.order === ORDER_ID + '--a1', 'order ref');
    assert(seen.body.customer && seen.body.customer.reference === 'patient-1', 'customer.reference is required by Kashier');
    assert(!('email' in seen.body.customer), 'a malformed e-mail must not be sent');
    assert(seen.body.serverWebhook === 'https://tashkheesa.com/payments/kashier/webhook', 'webhook');
    assert(seen.body.merchantRedirect.indexOf('?') === -1, 'redirect must carry no query string');
    assert(new Date(seen.body.expireAt).getTime() > Date.now(), 'expireAt not in the future');
    assert(out.sessionId === 'sess1' && /^https:\/\/payments\.kashier\.io\//.test(out.checkoutUrl), 'result');
  } finally {
    kashier.__setFetch(null);
  }
});

check('createSession: a Kashier error or a response with no sessionUrl is an error, never a link', async function () {
  try {
    kashier.__setFetch(async function () {
      return { ok: false, status: 401, text: async function () { return '{"message":"unauthorized"}'; } };
    });
    let code = null;
    await withEnv(Object.assign({ CARD_PROVIDER: 'kashier' }, KEYS), function () {
      return kashier.createSession({ orderRef: 'x', amountCents: 100, redirectUrl: 'https://a/b', webhookUrl: 'https://a/c' });
    }).catch(function (e) { code = e.code; });
    assert(code === 'KASHIER_HTTP_ERROR', 'expected KASHIER_HTTP_ERROR, got ' + code);

    kashier.__setFetch(async function () {
      return { ok: true, status: 200, text: async function () { return '{"status":"CREATED"}'; } };
    });
    code = null;
    await withEnv(Object.assign({ CARD_PROVIDER: 'kashier' }, KEYS), function () {
      return kashier.createSession({ orderRef: 'x', amountCents: 100, redirectUrl: 'https://a/b', webhookUrl: 'https://a/c' });
    }).catch(function (e) { code = e.code; });
    assert(code === 'KASHIER_MALFORMED_RESPONSE', 'expected KASHIER_MALFORMED_RESPONSE, got ' + code);
  } finally {
    kashier.__setFetch(null);
  }
});

check('checkout: a fresh session for the same amount is reused; a different amount mints a new one', async function () {
  const checkout = require('../../src/services/kashier_checkout.js');
  const events = [];
  const order = { id: ORDER_ID, paymob_intention_id: null };
  let minted = 0;
  checkout.__setTestDeps({
    pg: function () {
      return {
        queryOne: async function (sql, params) {
          const hit = events.filter(function (e) { return e.intention === params[1]; }).pop();
          return hit ? { payload_json: hit.payload } : null;
        },
        execute: async function (sql, params) {
          if (/UPDATE orders SET paymob_intention_id/.test(sql)) { order.paymob_intention_id = params[0]; return { rowCount: 1 }; }
          if (/'intention_created'/.test(sql)) { events.push({ intention: params[2], payload: JSON.parse(params[3]) }); return { rowCount: 1 }; }
          return { rowCount: 1 };
        }
      };
    },
    logErrorToDb: function () {},
    buildSpecialReference: function (id) { return id + '--t' + (minted + 1); }
  });
  kashier.__setFetch(async function () {
    minted++;
    return { ok: true, status: 200, text: async function () {
      return JSON.stringify({ _id: 's' + minted, sessionUrl: 'https://payments.kashier.io/session/s' + minted });
    } };
  });
  try {
    await withEnv(Object.assign({ CARD_PROVIDER: 'kashier', BASE_URL: 'https://tashkheesa.com' }, KEYS), async function () {
      const a = await checkout.ensureKashierCheckout({ order: order, amountCents: 75000, currency: 'EGP' });
      assert(a.reused === false && minted === 1, 'first call must mint');
      assert(order.paymob_intention_id === 'kashier:s1', 'intention id not stored');
      assert(order.payment_link === undefined, 'payment_link must not be overwritten with an expiring session URL');
      const b = await checkout.ensureKashierCheckout({ order: order, amountCents: 75000, currency: 'EGP' });
      assert(b.reused === true && b.checkoutUrl === a.checkoutUrl && minted === 1, 'same amount must reuse');
      const c = await checkout.ensureKashierCheckout({ order: order, amountCents: 105000, currency: 'EGP' });
      assert(c.reused === false && minted === 2, 'a different amount must mint a fresh session');
    });
  } finally {
    kashier.__setFetch(null);
    checkout.__setTestDeps({
      pg: function () { return require('../../src/pg'); },
      logErrorToDb: function () { return require('../../src/logger').logErrorToDb.apply(null, arguments); },
      buildSpecialReference: function (id) { return require('../../src/routes/payments').buildSpecialReference(id); }
    });
  }
});

// ── wiring that must not silently disappear ────────────────────────────────
check('wiring: webhook is mounted, CSRF-exempt by exact path, and the button endpoint branches to Kashier', function () {
  const fs = require('fs');
  const path = require('path');
  const read = function (p) { return fs.readFileSync(path.join(__dirname, '../../', p), 'utf8'); };
  assert(/app\.use\('\/payments\/kashier', require\('\.\/routes\/payments_kashier'\)\)/.test(read('src/server.js')), 'webhook router not mounted');
  assert(read('src/middleware/csrf.js').indexOf("p === '/payments/kashier/webhook'") !== -1, 'webhook not CSRF-exempt');
  assert(/router\.use\(express\.json\(/.test(read('src/routes/payments_kashier.js')), 'webhook router has no JSON body parser — req.body would be undefined');
  const pay = read('src/routes/payments.js');
  assert(pay.indexOf('ensureKashierCheckout') !== -1 && pay.indexOf('kashier.isSelected()') !== -1, 'create-intention has no Kashier branch');
  assert(pay.indexOf('ensureKashierCheckout') < pay.indexOf('paymobService.createIntention({'), 'Kashier branch must come before the Paymob mint');
  assert(read('src/services/paymob_intention.js').indexOf('ensureKashierCheckout') !== -1, 'mobile mint has no Kashier branch');
  assert(read('src/routes/patient.js').indexOf("'/portal/patient/payment-return/k/:id'") !== -1, 'Kashier return route missing');
});
