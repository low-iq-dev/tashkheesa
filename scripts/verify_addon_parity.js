#!/usr/bin/env node
'use strict';

// Phase-3 parity check.
//
// For every order that has ANY addon signal — addons_json populated or
// video_consultation_selected = true — compare the old-system state
// against the new-system state:
//
//   OLD              vs   NEW
//   orders.addons_json    order_addons rows per service_id
//   video_consultation_*  order_addons where addon_service_id='video_consult'
//   appointments          order_addons.metadata_json.appointment_id (for video)
//   doctor_earnings       addon_earnings
//
// NOTE: orders.sla_hours is NOT checked here — the 24hr SLA addon was
// removed in migration 019b. Urgency / faster-turnaround is now
// expressed through urgency tiers on the main service, not through an
// addon. Parity does not need to assert anything on sla_hours.
//
// Fields checked: amount (to the cent), commission pct, commission
// amount, state transition equivalence, timestamp alignment (within
// ALLOWED_TIMESTAMP_SKEW_MS, default 5000 ms).
//
// Scope:
//   --since=<ISO-8601>    only check orders created after this cutoff
//                         (default: process.env.ADDON_DUALWRITE_SINCE
//                         or 2026-04-24T00:00:00Z — the earliest the
//                         dual-write could have been live)
//   --prefix=<string>     only check orders whose id starts with this
//                         prefix (useful for fixture-only runs)
//   --force-mismatch      inject a synthetic mismatch into the first
//                         examined order and assert we catch it. Used
//                         by the local self-test; refuses to run in prod.
//   --env=<local|prod>    for log filename discrimination only
//
// Output:
//   stdout        human-readable summary
//   logs/addon_parity_<timestamp>.json   full structured report
//
// Exit code:
//   0  every examined order matched
//   1  at least one mismatch
//   2  usage / infra error

const fs = require('node:fs');
const path = require('node:path');
const { pool, queryOne, queryAll, execute } = require('../src/pg');

const ALLOWED_TIMESTAMP_SKEW_MS = 5000;

// ---- args ----
const args = process.argv.slice(2);
function arg(name, fallback) {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : fallback;
}
const since         = arg('since', process.env.ADDON_DUALWRITE_SINCE || '2026-04-24T00:00:00Z');
const prefix        = arg('prefix', null);
const env           = arg('env', 'local');
const forceMismatch = args.includes('--force-mismatch');

if (forceMismatch && env === 'prod') {
  console.error('refusing to --force-mismatch on --env=prod');
  process.exit(2);
}

// ---- helpers ----

// Normalize a Postgres-returned timestamp to a UTC epoch-ms number.
//
// The trap: `doctor_earnings.created_at` is TIMESTAMP WITHOUT TIME ZONE
// and `addon_earnings.created_at` is TIMESTAMP WITH TIME ZONE. The
// node-pg driver returns:
//   - TIMESTAMPTZ → a JS Date (correctly UTC-anchored), OR an ISO
//                    string with a `Z` or `+HH:MM` suffix.
//   - TIMESTAMP   → a string with NO offset suffix (e.g.
//                    `2026-04-24 19:23:40.275074`). JS `new Date(s)`
//                    interprets such strings as LOCAL time, which
//                    silently shifts by the runner's timezone offset.
//
// Supabase sessions run in UTC (`SHOW timezone` → UTC), so naive values
// coming back from the TIMESTAMP column are already UTC intent — we
// just need to stop JS from applying a local-time offset. This helper
// appends `Z` when no explicit offset is present, so both column types
// produce the same UTC epoch.
function toUtcMs(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  let s = String(v);
  // PG's TIMESTAMP uses a space separator (`YYYY-MM-DD HH:MM:SS.fff`).
  // Swap it for the ISO-8601 `T` so JS Date.parse will accept it.
  s = s.replace(' ', 'T');
  // Postgres emits the UTC offset as `Z`, `+HH`, `+HHMM`, or `+HH:MM`.
  // JS `Date` reliably accepts only `Z` and `+HH:MM`. Normalize:
  //   • `+HHMM` → `+HH:MM`  (insert the colon)
  //   • `+HH`   → `+HH:00`  (supply the minutes)
  // Order matters — the compact-4-digit replace runs first so `+0300`
  // becomes `+03:00` before the bare-2-digit branch would otherwise
  // wrongly match its trailing `00`.
  s = s.replace(/([+\-]\d{2})(\d{2})$/, '$1:$2');
  s = s.replace(/([+\-]\d{2})$/, '$1:00');
  // If no offset is present at all, the value came from a TIMESTAMP
  // WITHOUT TIME ZONE column; Supabase sessions run in UTC, so the
  // value is UTC-intent — append `Z` to stop JS from applying the
  // runner's local-timezone offset.
  const hasOffset = /(?:Z|[+\-]\d{2}:\d{2})$/.test(s);
  if (!hasOffset) s = s + 'Z';
  return new Date(s).getTime();
}

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function addonsJsonSignals(order) {
  const parsed = parseJsonish(order.addons_json) || {};
  const out = {};
  if (parsed.video_consultation || order.video_consultation_selected) {
    out.video_consult = {
      selected: true,
      price_egp: Number(order.video_consultation_price || 200)
    };
  }
  // sla_24hr removed in migration 019b — urgency tiers now carry that
  // functionality on main-service pricing, not as an addon.
  if (parsed.prescription) {
    out.prescription = {
      selected: true,
      price_egp: Number(parsed.prescription_price || 400)
    };
  }
  return out;
}

async function addonsInNewSystem(orderId) {
  const rows = await queryAll(
    `SELECT * FROM order_addons WHERE order_id = $1 ORDER BY addon_service_id`,
    [orderId]
  );
  const out = {};
  for (const r of rows) out[r.addon_service_id] = r;
  return out;
}

async function earningsFor(orderAddonId) {
  return await queryOne(`SELECT * FROM addon_earnings WHERE order_addon_id = $1`, [orderAddonId]);
}

// For a given order + addonId, find the matching old-system earnings row.
// Video: via appointments.order_id → doctor_earnings.appointment_id
// Others: no old-system earnings exist today, so compare to null.
async function oldEarningsForAddon(order, addonId) {
  if (addonId !== 'video_consult') return null;
  const appt = await queryOne(
    `SELECT id FROM appointments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );
  if (!appt) return null;
  return await queryOne(
    `SELECT * FROM doctor_earnings WHERE appointment_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [appt.id]
  );
}

// ---- the check ----

function recordMismatch(report, orderId, addonId, field, oldVal, newVal, detail) {
  report.mismatches.push({
    order_id: orderId,
    addon_id: addonId,
    field,
    old: oldVal === undefined ? null : oldVal,
    new: newVal === undefined ? null : newVal,
    detail: detail || null
  });
}

async function compareOneOrder(order, report) {
  const signals = addonsJsonSignals(order);
  const newRows = await addonsInNewSystem(order.id);
  const expectedIds = Object.keys(signals);
  const foundIds    = Object.keys(newRows);

  // Missing-in-v2: old has a signal, new doesn't have a row.
  for (const id of expectedIds) {
    if (!newRows[id]) {
      recordMismatch(report, order.id, id, 'presence', 'present-in-old', 'missing-in-new');
    }
  }
  // Extra-in-v2: new has a row, old has no signal.
  for (const id of foundIds) {
    if (!signals[id]) {
      recordMismatch(report, order.id, id, 'presence', 'missing-in-old', 'present-in-new');
    }
  }

  // For each matched addon, compare fields.
  for (const id of expectedIds) {
    const newRow = newRows[id];
    if (!newRow) continue;
    const oldSignal = signals[id];

    // Amount, base EGP: new.price_at_purchase_egp should match old's price_egp
    if (Number(newRow.price_at_purchase_egp) !== oldSignal.price_egp) {
      recordMismatch(report, order.id, id, 'price_egp',
                     oldSignal.price_egp, newRow.price_at_purchase_egp);
    }

    // Commission — only for addons that produce payout (video_consult,
    // prescription). SLA has no earnings path.
    if (id === 'video_consult' || id === 'prescription') {
      const newEarnings = await earningsFor(newRow.id);
      const oldEarnings = await oldEarningsForAddon(order, id);

      // Status parity: fulfilled vs paid-earnings present.
      if (newRow.status === 'fulfilled' && !newEarnings) {
        recordMismatch(report, order.id, id, 'new_earnings', null, 'missing',
                       'addon is fulfilled but no addon_earnings row');
      }
      if (newEarnings && oldEarnings) {
        if (Math.round(Number(newEarnings.earned_amount_egp)) !== Math.round(Number(oldEarnings.earned_amount))) {
          recordMismatch(report, order.id, id, 'commission_amount',
                         Number(oldEarnings.earned_amount),
                         Number(newEarnings.earned_amount_egp));
        }
        if (Math.round(Number(newEarnings.commission_pct)) !== Math.round(Number(oldEarnings.commission_pct))) {
          recordMismatch(report, order.id, id, 'commission_pct',
                         Number(oldEarnings.commission_pct),
                         Number(newEarnings.commission_pct));
        }
      } else if (oldEarnings && !newEarnings) {
        recordMismatch(report, order.id, id, 'earnings_presence', 'present-in-old', 'missing-in-new');
      } else if (!oldEarnings && newEarnings && id === 'video_consult') {
        // Video should always have a matching doctor_earnings row. Others
        // (prescription) do not have an old-system earnings path — skip.
        recordMismatch(report, order.id, id, 'earnings_presence', 'missing-in-old', 'present-in-new');
      }

      // Timestamp alignment (when both exist)
      if (newEarnings && oldEarnings) {
        const oldT = toUtcMs(oldEarnings.created_at);
        const newT = toUtcMs(newEarnings.created_at);
        if (Math.abs(oldT - newT) > ALLOWED_TIMESTAMP_SKEW_MS) {
          recordMismatch(report, order.id, id, 'earnings_timestamp_skew',
                         oldEarnings.created_at, newEarnings.created_at,
                         Math.abs(oldT - newT) + ' ms (>' + ALLOWED_TIMESTAMP_SKEW_MS + ' allowed)');
        }
      }
    }

    // Video-specific: appointment presence should match fulfillment state.
    if (id === 'video_consult') {
      const appt = await queryOne(
        `SELECT id, status FROM appointments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [order.id]
      );
      const newFulfilled = newRow.status === 'fulfilled';
      const oldFulfilled = appt && ['confirmed', 'completed'].includes(appt.status);
      if (newFulfilled !== oldFulfilled) {
        recordMismatch(report, order.id, id, 'fulfillment_state',
                       oldFulfilled ? 'fulfilled-in-old' : 'not-fulfilled-in-old',
                       newFulfilled ? 'fulfilled-in-new' : 'not-fulfilled-in-new');
      }
    }
  }

  report.examined += 1;
}

async function main() {
  const report = {
    started_at:       new Date().toISOString(),
    env,
    since,
    prefix:           prefix || null,
    force_mismatch:   forceMismatch,
    examined:         0,
    mismatches:       [],
    summary:          null
  };

  // Gather candidate orders (sla_hours dropped from the signal set in 019b
  // — urgency tiers are a main-service concern, not an addon).
  const clauses = [
    `(addons_json IS NOT NULL AND addons_json <> '' AND addons_json <> 'null')`,
    `video_consultation_selected = true`
  ];
  const params = [];
  let where = `(${clauses.join(' OR ')}) AND created_at >= $1`;
  params.push(since);
  if (prefix) { where += ' AND id LIKE $2'; params.push(prefix + '%'); }

  const orders = await queryAll(
    `SELECT id, addons_json, video_consultation_selected, video_consultation_price,
            created_at
       FROM orders
      WHERE ${where}
      ORDER BY created_at DESC`,
    params
  );

  if (forceMismatch && orders.length > 0) {
    // Corrupt the first order's addon state so the parity check has to
    // find it. Records what we did so the self-test can assert.
    const victim = orders[0];
    const victimAddon = await queryOne(
      `SELECT id, price_at_purchase_egp FROM order_addons WHERE order_id = $1 LIMIT 1`,
      [victim.id]
    );
    if (victimAddon) {
      await execute(
        `UPDATE order_addons SET price_at_purchase_egp = $1 WHERE id = $2`,
        [victimAddon.price_at_purchase_egp + 999, victimAddon.id]
      );
      report.forced_mismatch_injected = {
        order_id: victim.id,
        addon_id: 'unknown',
        field: 'price_egp',
        original: victimAddon.price_at_purchase_egp,
        corrupted_to: victimAddon.price_at_purchase_egp + 999
      };
    }
  }

  for (const o of orders) {
    await compareOneOrder(o, report);
  }

  report.summary = {
    examined:                     report.examined,
    mismatches_total:             report.mismatches.length,
    mismatches_by_field:          report.mismatches.reduce((acc, m) => { acc[m.field] = (acc[m.field] || 0) + 1; return acc; }, {}),
    mismatches_by_addon:          report.mismatches.reduce((acc, m) => { acc[m.addon_id] = (acc[m.addon_id] || 0) + 1; return acc; }, {})
  };
  report.finished_at = new Date().toISOString();

  // Write structured log
  const logsDir = path.resolve(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const stamp = report.started_at.replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `addon_parity_${env}_${stamp}.json`);
  fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  // Human summary
  console.log('');
  console.log('== addon parity report (' + env + ') ==');
  console.log('  examined:   ' + report.examined);
  console.log('  mismatches: ' + report.mismatches.length);
  if (report.mismatches.length) {
    console.log('  by field:');
    for (const [k, v] of Object.entries(report.summary.mismatches_by_field)) console.log('    ' + k + ': ' + v);
    console.log('  by addon:');
    for (const [k, v] of Object.entries(report.summary.mismatches_by_addon)) console.log('    ' + k + ': ' + v);
    console.log('');
    console.log('  first 10 mismatches:');
    for (const m of report.mismatches.slice(0, 10)) {
      console.log('    order=' + m.order_id + ' addon=' + m.addon_id + ' field=' + m.field +
                  ' old=' + JSON.stringify(m.old) + ' new=' + JSON.stringify(m.new) +
                  (m.detail ? ' (' + m.detail + ')' : ''));
    }
  }
  console.log('');
  console.log('  log:        ' + logPath);
  console.log('');

  process.exitCode = report.mismatches.length === 0 ? 0 : 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 2; })
  .finally(async () => { await pool.end(); });
