#!/usr/bin/env node
'use strict';

// Phase-3 synthetic Paymob webhook replay.
//
// Why: dual-write validation needs real POSTs through /payments/callback so
// the addon detection branches fire — but we don't want to burn real money
// on Paymob. The payment callback handler verifies HMAC-SHA512 only; it
// does NOT call back to Paymob to confirm the transaction exists. So we
// can sign a Paymob-shaped payload with our own PAYMOB_HMAC_SECRET, POST
// it to /payments/callback, and exercise the full code path with zero
// Paymob involvement.
//
// Scenarios covered (six, one per add-on combination the live system sees):
//   video-only, prescription-only, sla-only,
//   video+prescription, sla+prescription, all-three.
//
// Idempotent: every order inserted uses the deterministic prefix
//   paymob-replay-YYYYMMDD-HHMM-<scenario>
// Same prefix across repeated runs within the same minute = UPSERT on the
// existing order. Across minutes, fresh orders. `--cleanup` removes every
// order whose id starts with `paymob-replay-`.
//
// Run:
//   node scripts/replay_paymob_webhook.js --env=local
//   node scripts/replay_paymob_webhook.js --env=prod  --yes
//   node scripts/replay_paymob_webhook.js --cleanup
//
// Flags:
//   --env=<local|prod>              Chooses DATABASE_URL + default target.
//                                    prod requires --yes AND an interactive
//                                    confirm unless stdin is a non-TTY.
//   --target=<url>                  Override the callback URL.
//   --yes                           Skip the prod confirmation prompt.
//   --cleanup                       Delete every `paymob-replay-%` row
//                                    (orders + order_addons + addon_earnings
//                                    + appointments + doctor_earnings).
//
// Exit:
//   0  all scenarios accepted (HTTP 200 + ok:true)
//   1  any scenario rejected (HMAC rejection, 4xx, 5xx, or non-ok body)
//   2  usage / infra error

const crypto = require('node:crypto');
const readline = require('node:readline');
const { pool, queryOne, execute } = require('../src/pg');
const { buildHmacString } = require('../src/paymob-hmac');

// ---- args ----
const args = process.argv.slice(2);
function arg(name, fallback) {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : fallback;
}
const env        = arg('env', 'local');
const cleanup    = args.includes('--cleanup');
const skipConfirm = args.includes('--yes');
const DEFAULT_TARGETS = {
  local: 'http://localhost:3000/payments/callback',
  prod:  'https://portal.tashkheesa.com/payments/callback'
};
const target = arg('target', DEFAULT_TARGETS[env] || DEFAULT_TARGETS.local);

if (!['local', 'prod'].includes(env)) {
  console.error('Usage: --env=<local|prod> [--target=URL] [--yes] [--cleanup]');
  process.exit(2);
}
if (env === 'prod' && !skipConfirm && process.stdin.isTTY) {
  // interactive confirm
} else if (env === 'prod' && !skipConfirm) {
  console.error('refusing to run against prod without --yes when stdin is not a TTY');
  process.exit(2);
}

// ---- scenario definitions ----
const SCENARIOS = [
  { key: 'video-only',          video: true,  sla: false, prescription: false, amountEgp: 1700 },
  { key: 'prescription-only',   video: false, sla: false, prescription: true,  amountEgp: 1900 },
  { key: 'sla-only',            video: false, sla: true,  prescription: false, amountEgp: 1600 },
  { key: 'video+prescription',  video: true,  sla: false, prescription: true,  amountEgp: 2100 },
  { key: 'sla+prescription',    video: false, sla: true,  prescription: true,  amountEgp: 2000 },
  { key: 'all-three',           video: true,  sla: true,  prescription: true,  amountEgp: 2200 }
];

const PREFIX = 'paymob-replay-';

function minuteSlug() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getUTCFullYear().toString()
       + pad(d.getUTCMonth() + 1)
       + pad(d.getUTCDate()) + '-'
       + pad(d.getUTCHours())
       + pad(d.getUTCMinutes());
}

function orderIdFor(scenarioKey, slug) {
  return PREFIX + slug + '-' + scenarioKey;
}

async function runCleanup() {
  console.log('[' + env + '] removing all ' + PREFIX + '* rows …');
  const dropped = {};
  dropped.addon_earnings = (await execute(
    `DELETE FROM addon_earnings WHERE order_addon_id IN (SELECT id FROM order_addons WHERE order_id LIKE $1)`,
    [PREFIX + '%']
  )).rowCount;
  dropped.order_addons    = (await execute(`DELETE FROM order_addons    WHERE order_id LIKE $1`, [PREFIX + '%'])).rowCount;
  dropped.appointments    = (await execute(`DELETE FROM appointments    WHERE order_id LIKE $1`, [PREFIX + '%'])).rowCount;
  dropped.doctor_earnings = (await execute(
    `DELETE FROM doctor_earnings
      WHERE appointment_id IN (SELECT id FROM appointments WHERE order_id LIKE $1)`,
    [PREFIX + '%']
  )).rowCount;
  dropped.orders          = (await execute(`DELETE FROM orders          WHERE id       LIKE $1`, [PREFIX + '%'])).rowCount;
  console.log('[' + env + '] dropped:', dropped);
}

async function ensureOrder(orderId, amountEgp) {
  // Upsert on conflict — second run within the same minute reuses the row.
  await execute(
    `INSERT INTO orders
       (id, service_id, specialty_id, price, status, payment_status, created_at)
     VALUES ($1, NULL, 'spec-radiology', $2, 'new', 'unpaid', NOW())
     ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price`,
    [orderId, amountEgp]
  );
  return await queryOne(`SELECT * FROM orders WHERE id = $1`, [orderId]);
}

function buildPaymobObj(orderId, amountEgp) {
  // Minimal Paymob-shaped transaction object. Field set covers every key
  // required for HMAC canonicalisation (see src/paymob-hmac.js HMAC_FIELDS).
  return {
    amount_cents:           amountEgp * 100,
    created_at:             new Date().toISOString(),
    currency:               'EGP',
    error_occured:          false,
    has_parent_transaction: false,
    id:                     Math.floor(Math.random() * 9e8) + 1e8,     // Paymob transaction id (synthetic)
    integration_id:         12345,                                     // any int; not verified back
    is_3d_secure:           true,
    is_auth:                false,
    is_capture:             false,
    is_refunded:            false,
    is_standalone_payment:  true,
    is_voided:              false,
    order:                  { id: Math.floor(Math.random() * 9e8) + 1e8 },
    owner:                  11111,
    pending:                false,
    source_data:            { pan: '2346', sub_type: 'MasterCard', type: 'card' },
    success:                true,
    // Fields the callback handler reads (NOT part of HMAC canonicalisation):
    order_id:               orderId,
    status:                 'success',
    method:                 'card',
    reference:              'synthetic-replay-' + crypto.randomBytes(4).toString('hex')
  };
}

function signPaymobHmac(obj, secret) {
  const canonical = buildHmacString(obj);
  return crypto.createHmac('sha512', secret).update(canonical, 'utf8').digest('hex');
}

async function postCallback(url, body, hmac) {
  // Node 18+ has fetch built-in.
  const full = url + (url.includes('?') ? '&' : '?') + 'hmac=' + encodeURIComponent(hmac);
  const resp = await fetch(full, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body)
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {}
  return { status: resp.status, body: parsed || text };
}

async function confirmProd() {
  if (env !== 'prod' || skipConfirm) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise(resolve => {
    rl.question(
      '\n⚠️  About to replay synthetic Paymob webhooks against PRODUCTION at ' + target + '.\n' +
      '   No real money moves, but DB writes ARE real.\n' +
      '   Type "PROD" to continue: ',
      answer => { rl.close(); resolve(String(answer).trim() === 'PROD'); }
    );
  });
}

async function run() {
  if (cleanup) { await runCleanup(); return; }

  const secret = process.env.PAYMOB_HMAC_SECRET;
  if (!secret) {
    console.error('PAYMOB_HMAC_SECRET is not set; refusing to run.');
    process.exit(2);
  }

  if (env === 'prod' && !(await confirmProd())) {
    console.error('aborted by user');
    process.exit(2);
  }

  const slug = minuteSlug();
  const results = [];
  console.log('[' + env + '] target=' + target + '  prefix=' + PREFIX + slug + '-*');

  for (const s of SCENARIOS) {
    const orderId = orderIdFor(s.key, slug);
    try {
      await ensureOrder(orderId, s.amountEgp);

      const obj = buildPaymobObj(orderId, s.amountEgp);
      const hmac = signPaymobHmac(obj, secret);

      // Body carries the Paymob obj AND the addon-signal flags that the
      // callback handler detects on req.body (see src/routes/payments.js
      // lines 213, 246, 305). Flags must be strings '1' to match the code.
      const body = {
        type: 'TRANSACTION',
        obj,
        addon_video_consultation: s.video ? '1' : undefined,
        addon_sla_24hr:           s.sla ? '1' : undefined,
        addon_prescription:       s.prescription ? '1' : undefined
      };

      const resp = await postCallback(target, body, hmac);
      const ok = resp.status === 200 && resp.body && resp.body.ok === true;
      results.push({ scenario: s.key, orderId, status: resp.status, ok, body: resp.body });
      console.log('  ' + (ok ? '✓' : '✗') + ' ' + s.key.padEnd(22) +
                  ' status=' + resp.status +
                  ' body=' + JSON.stringify(resp.body).slice(0, 80));
    } catch (err) {
      results.push({ scenario: s.key, orderId, status: 'error', ok: false, body: err.message });
      console.log('  ✗ ' + s.key.padEnd(22) + ' error: ' + err.message);
    }
  }

  const passed = results.filter(r => r.ok).length;
  console.log('\n== replay summary (' + env + ') ==');
  console.log('  scenarios: ' + results.length);
  console.log('  passed:    ' + passed);
  console.log('  failed:    ' + (results.length - passed));
  if (passed !== results.length) {
    console.log('\n  failures:');
    for (const r of results.filter(x => !x.ok)) {
      console.log('    ' + r.scenario + ' status=' + r.status + ' body=' + JSON.stringify(r.body));
    }
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

run()
  .catch(err => { console.error(err); process.exitCode = 2; })
  .finally(async () => { await pool.end(); });
