// src/paymob-hmac.js
// Paymob HMAC-SHA512 webhook verification
//
// Paymob sends a ?hmac=<hex> query parameter on every transaction webhook.
// The signature is HMAC-SHA512 over a specific concatenation of 19 fields
// taken from body.obj (the transaction object), in this exact order:
//
//   amount_cents, created_at, currency, error_occured, has_parent_transaction,
//   id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded,
//   is_standalone_payment, is_voided, order.id, owner, pending,
//   source_data.pan, source_data.sub_type, source_data.type, success
//
// All values are cast to string as-is (booleans become "true"/"false").
// Reference: https://docs.paymob.com/docs/hmac-calculation

'use strict';

const crypto = require('crypto');
const { logErrorToDb } = require('./logger');

// The 19 fields in the exact order Paymob specifies
const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order',          // resolved to obj.order.id
  'owner',
  'pending',
  'source_data_pan',       // resolved from obj.source_data.pan
  'source_data_sub_type',  // resolved from obj.source_data.sub_type
  'source_data_type',      // resolved from obj.source_data.type
  'success'
];

/**
 * Extract the HMAC-subject string from a Paymob transaction object.
 * @param {object} obj - body.obj from the Paymob webhook payload
 * @returns {string}
 */
function buildHmacString(obj) {
  const vals = HMAC_FIELDS.map(field => {
    let v;
    switch (field) {
      case 'order':
        // Paymob sends order as a nested object; we use order.id
        v = (obj.order && obj.order.id != null) ? obj.order.id : '';
        break;
      case 'source_data_pan':
        v = (obj.source_data && obj.source_data.pan != null) ? obj.source_data.pan : '';
        break;
      case 'source_data_sub_type':
        v = (obj.source_data && obj.source_data.sub_type != null) ? obj.source_data.sub_type : '';
        break;
      case 'source_data_type':
        v = (obj.source_data && obj.source_data.type != null) ? obj.source_data.type : '';
        break;
      default:
        v = obj[field] != null ? obj[field] : '';
    }
    return String(v);
  });
  return vals.join('');
}

/**
 * Verify the Paymob HMAC signature on an incoming webhook request.
 *
 * @param {object} req   - Express request object
 * @param {object} res   - Express response object (only used for logging context)
 * @param {string} hmacSecret - value of PAYMOB_HMAC_SECRET env var
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyPaymobHmac(req, hmacSecret) {
  try {
    // 1. The HMAC comes as a query parameter: ?hmac=<hex>
    const receivedHmac = (req.query && req.query.hmac) ? String(req.query.hmac) : '';
    if (!receivedHmac) {
      return { ok: false, reason: 'missing_hmac_param' };
    }

    // 2. Extract the transaction object from the request body
    const body = req.body || {};
    // Paymob sends { type: "TRANSACTION", obj: { ... } }
    const obj = body.obj || body;
    if (!obj || typeof obj !== 'object') {
      return { ok: false, reason: 'missing_obj' };
    }

    // 3. Build the concatenated string and compute expected HMAC-SHA512
    const hmacString = buildHmacString(obj);
    const expectedHmac = crypto
      .createHmac('sha512', hmacSecret)
      .update(hmacString, 'utf8')
      .digest('hex');

    // 4. Timing-safe comparison to prevent timing attacks
    const expected = Buffer.from(expectedHmac, 'utf8');
    const received = Buffer.from(receivedHmac, 'utf8');

    if (expected.length !== received.length) {
      return { ok: false, reason: 'hmac_mismatch' };
    }
    if (!crypto.timingSafeEqual(expected, received)) {
      return { ok: false, reason: 'hmac_mismatch' };
    }

    return { ok: true };
  } catch (err) {
    logErrorToDb(err, { context: 'verifyPaymobHmac' });
    return { ok: false, reason: 'hmac_error' };
  }
}

module.exports = { verifyPaymobHmac, buildHmacString };
