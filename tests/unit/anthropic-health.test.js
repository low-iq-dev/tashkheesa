// tests/unit/anthropic-health.test.js
//
// Unit suite for the Anthropic billing-failure detector
// (src/config/anthropic.js → isAnthropicBillingError). The detector is the
// correctness-critical piece of the AI-health flag: a false negative means a
// $0-balance outage degrades every AI feature with no flag tripped, which is
// exactly the blind spot we are closing. Error shapes below mirror the REAL
// SDK error captured from a failed prod specialty-classify job.

'use strict';

const path = require('path');
const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🩺 AI health — isAnthropicBillingError detector\n');

const { isAnthropicBillingError } = require('../../src/config/anthropic');

function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

// The real production 400 credit error, captured verbatim from pgboss.job.output.
const prodCreditErr = {
  status: 400,
  error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } },
  message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
};

check('detects the real 400 credit-balance error (nested + top-level message)', function () {
  assert.strictEqual(isAnthropicBillingError(prodCreditErr), true);
});

check('detects a 402 billing error', function () {
  assert.strictEqual(isAnthropicBillingError({ status: 402, message: 'Your credit balance is too low' }), true);
});

check('does NOT flag a 429 rate-limit as billing', function () {
  assert.strictEqual(isAnthropicBillingError({ status: 429, message: 'rate_limit_error: too many requests' }), false);
});

check('does NOT flag a generic 400 (bad params) as billing', function () {
  assert.strictEqual(isAnthropicBillingError({ status: 400, error: { error: { type: 'invalid_request_error', message: 'max_tokens: must be <= 4096' } }, message: '400 max_tokens too large' }), false);
});

check('does NOT flag a 500 server error as billing', function () {
  assert.strictEqual(isAnthropicBillingError({ status: 500, message: 'internal server error' }), false);
});

check('uses statusCode when status is absent', function () {
  assert.strictEqual(isAnthropicBillingError({ statusCode: 400, message: 'credit balance is too low' }), true);
});

check('returns false for null/undefined/non-object without throwing', function () {
  assert.strictEqual(isAnthropicBillingError(null), false);
  assert.strictEqual(isAnthropicBillingError(undefined), false);
  assert.strictEqual(isAnthropicBillingError('boom'), false);
  assert.strictEqual(isAnthropicBillingError(400), false);
});
