// tests/services/ai-usage-window-and-rates.test.js
//
// AUDIT (2026-08-29) — four defects in the AI-credits screen
// (src/services/ai_usage.js), each pinned here.
//
//  1. WINDOW MISMATCH. usageDailyTotals filtered on a rolling instant
//     (`logged_at >= NOW() - N days`) but built its dense day array from the
//     last N CAIRO CALENDAR DAYS. Rows in the gap between the two were counted
//     in the headline total (usageByPurpose used the same rolling predicate)
//     and then dropped from the chart because no key matched. The screen
//     rendered "$7.7777 · 1 call" directly above "No spend recorded on any day
//     in this window."
//
//  2. DST. The day array stepped back a fixed 86 400 000 ms and asked Intl
//     which Cairo day that landed on. Egypt observes DST, so on the two
//     transition nights a year two steps produce the SAME Cairo date (duplicate
//     bar, duplicate React key) or SKIP one (a day with real spend has no
//     bucket). ~30 affected nights on the 30-day tab, twice a year.
//
//  3. PRECISION. Costs were rounded to 4dp, so a real day of spend
//     ($0.000039 across 3 calls) became 0.0000 and drew a zero-height bar —
//     defeating the deliberate 2% bar floor that exists so a small non-zero day
//     is still visible.
//
//  4. OPUS PRICED AS SONNET. RATES_PER_MTOK held haiku and sonnet only and
//     priceFor() fell through to sonnet, so an Opus-class call was recorded at
//     one fifth of its real cost.
//
// The rate table is keyed by model CLASS, never by model id: tests/core/
// anthropic-model-centralisation.test.js forbids `claude-…` literals outside
// src/config/anthropic.js, and a table of ids would price a rotated model at
// the fallback rate on exactly the day the numbers most need to be right. The
// ids used below live in THIS file (a test, not src/), which that lint does not
// scan.

'use strict';

const path = require('path');
const fs = require('fs');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🧮 ai_usage — one window, DST-safe days, honest precision, real Opus rate\n');

const ROOT = path.join(__dirname, '..', '..');
const usage = require(path.join(ROOT, 'src', 'services', 'ai_usage.js'));

function check(name, fn) {
  try { fn(); t.pass(fileTag + ': ' + name); }
  catch (e) { t.fail(fileTag + ': ' + name, e); }
}

// ── 1. The SQL window and the JS day array describe the SAME period ─────────

check('both readers bound on the SAME Cairo-day predicate', function () {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'services', 'ai_usage.js'), 'utf8'));
  ['usageByPurpose', 'usageDailyTotals'].forEach((fn) => {
    const start = src.indexOf('async function ' + fn);
    const next = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, next === -1 ? src.length : next);
    if (body.indexOf('${IN_WINDOW}') === -1) {
      throw new Error(
        `${fn} no longer uses the shared IN_WINDOW predicate. When the KPI and the chart bound ` +
        'their queries differently, a call can be inside the total and outside every bar — which ' +
        'is exactly what "$7.7777 · 1 call" above "No spend recorded" was.'
      );
    }
    if (/NOW\(\)\s*-\s*\(\$1/.test(body) || /\|\|\s*' days'\)::interval/.test(body)) {
      throw new Error(
        `${fn} still bounds on a ROLLING INSTANT (NOW() - N days). The chart's day array is a ` +
        'list of Cairo CALENDAR days; a rolling bound admits rows from a day the array does not ' +
        'contain, and the lookup silently drops them.'
      );
    }
  });
});

check('IN_WINDOW bounds on the Cairo day boundary, two-step converted', function () {
  const w = usage.IN_WINDOW;
  if (!/AT TIME ZONE 'UTC' AT TIME ZONE 'Africa\/Cairo'/.test(w)) {
    throw new Error(
      'IN_WINDOW lost the TWO-step UTC→Cairo conversion. agent_token_log.logged_at is ' +
      '`timestamp WITHOUT time zone` holding UTC digits; a single AT TIME ZONE reinterprets those ' +
      'digits as Cairo wall clock and shifts every bucket by the offset.'
    );
  }
  if (!/date_trunc\('day'/.test(w)) {
    throw new Error('IN_WINDOW no longer truncates to a day boundary — it is a rolling instant again.');
  }
});

// ── 2. The day array is built by calendar arithmetic ────────────────────────

check('the day list is dense, ordered oldest-first, and ends on today (Cairo)', function () {
  const keys = usage.cairoDayKeysEndingToday(30);
  if (keys.length !== 30) throw new Error(`expected 30 keys, got ${keys.length}`);
  const sorted = keys.slice().sort();
  if (JSON.stringify(sorted) !== JSON.stringify(keys)) {
    throw new Error('the day keys are not in ascending order — the chart would draw the window backwards.');
  }
  const todayCairo = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  if (keys[keys.length - 1] !== todayCairo) {
    throw new Error(`the window does not end on the Cairo today (${todayCairo}); last key is ${keys[keys.length - 1]}.`);
  }
});

check('no Cairo day is duplicated or skipped across a full year (the DST guard)', function () {
  // 365 days spans BOTH Egyptian DST transitions from any starting date, so
  // this covers the spring-forward duplicate and the autumn-back skip in one
  // assertion. The old fixed-86 400 000 ms stepping fails here.
  const keys = usage.cairoDayKeysEndingToday(365);
  if (new Set(keys).size !== 365) {
    throw new Error(
      `365 requested days produced only ${new Set(keys).size} distinct Cairo dates. A duplicate ` +
      'means two bars share a date (and a React key); a skip means a day with real spend has no ' +
      'bucket to land in. Build the list by calendar arithmetic, not fixed-ms stepping.'
    );
  }
  // Consecutive keys must be exactly one calendar day apart.
  for (let i = 1; i < keys.length; i++) {
    const [ay, am, ad] = keys[i - 1].split('-').map(Number);
    const [by, bm, bd] = keys[i].split('-').map(Number);
    const gap = (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000;
    if (gap !== 1) throw new Error(`${keys[i - 1]} → ${keys[i]} is a ${gap}-day step, not 1.`);
  }
});

check('the day walk crosses month and year boundaries correctly', function () {
  // Date.UTC normalises an out-of-range day field, which is what makes the walk
  // correct on 1 January and 1 March without any special-casing. Assert the
  // shape rather than a fixed date, so this test does not rot.
  const keys = usage.cairoDayKeysEndingToday(400);
  keys.forEach((k) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) throw new Error(`malformed day key ${k} — it must match to_char(...,'YYYY-MM-DD') exactly.`);
    const [y, m, d] = k.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`day key ${k} is not a real calendar date.`);
  });
});

// ── 3. Precision survives into the payload ──────────────────────────────────

check('cost precision is 6dp, not 4dp', function () {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'services', 'ai_usage.js'), 'utf8'));
  if (/cost_usd\)\s*\*\s*1e4\s*\)\s*\/\s*1e4/.test(src)) {
    throw new Error(
      'ai_usage still rounds a cost to 4 decimals. A real day of spend ($0.000039 across 3 calls) ' +
      'becomes 0.0000, which the app draws as a zero-height bar — defeating the 2% minimum-height ' +
      'floor that exists so a small non-zero day is still visible.'
    );
  }
  const admin = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', 'admin.js'), 'utf8'));
  if (/total\.costUsd\s*=\s*Math\.round\(total\.costUsd\s*\*\s*1e4\)\s*\/\s*1e4/.test(admin)) {
    throw new Error('GET /ai-usage still rounds the headline total to 4dp while the series keeps 6.');
  }
});

check('a sub-cent call keeps a non-zero cost', function () {
  // 5 output tokens on Haiku = 5/1e6 * 5.00 = $0.000025 — real spend, and
  // exactly the order of magnitude a day of classifier calls costs.
  const cost = usage.estimateCostUsd('claude-haiku-4-5', { input_tokens: 0, output_tokens: 5 });
  if (!(cost > 0)) throw new Error('a 5-token Haiku call priced to exactly 0 — the ledger says the platform spent nothing.');
  if (Math.round(cost * 1e4) / 1e4 !== 0) {
    throw new Error('the fixture no longer demonstrates the 4dp collapse; pick a smaller call.');
  }
});

// ── 4. Opus prices as Opus, and unknown still prices at the ceiling ─────────

check('the rate table carries an opus class at its list price', function () {
  const r = usage.RATES_PER_MTOK.opus;
  if (!r) throw new Error('RATES_PER_MTOK has no `opus` class — an Opus-class call prices as Sonnet, a 5x under-report.');
  if (r.input !== 15.00 || r.output !== 75.00) {
    throw new Error(`opus rate is ${JSON.stringify(r)}; expected { input: 15, output: 75 } per Mtok.`);
  }
});

check('an Opus model id prices at the opus rate, not the sonnet rate', function () {
  const opus = usage.estimateCostUsd('claude-opus-4-1', { input_tokens: 1e6, output_tokens: 1e6 });
  const sonnet = usage.estimateCostUsd('claude-sonnet-4-6', { input_tokens: 1e6, output_tokens: 1e6 });
  const expected = usage.RATES_PER_MTOK.opus.input + usage.RATES_PER_MTOK.opus.output;
  if (opus !== expected) throw new Error(`1 Mtok in + 1 Mtok out on Opus should be $${expected}, got $${opus}.`);
  if (!(opus > sonnet)) throw new Error('an Opus call priced at or below Sonnet — the family sniff in priceFor() has regressed.');
});

check('an unknown model still prices at the MOST EXPENSIVE known rate', function () {
  const unknown = usage.estimateCostUsd('some-model-nobody-listed-yet', { input_tokens: 1e6, output_tokens: 1e6 });
  const dearest = Object.values(usage.RATES_PER_MTOK)
    .reduce((a, b) => (b.output > a.output ? b : a));
  const expected = dearest.input + dearest.output;
  if (unknown !== expected) {
    throw new Error(
      `an unknown model priced at $${unknown}; expected $${expected}, the dearest rate in the ` +
      'table. Spend we cannot price must look expensive, never free — a zero would quietly ' +
      'under-report exactly the new model someone just switched to.'
    );
  }
  if (unknown === 0) throw new Error('an unknown model priced at zero.');
});

check('the rate table is keyed by CLASS, with no model-id literal', function () {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ai_usage.js'), 'utf8');
  if (/['"]claude-[a-z0-9.-]+['"]/.test(src)) {
    throw new Error(
      'services/ai_usage.js now contains a claude-* model literal. ' +
      'tests/core/anthropic-model-centralisation.test.js forbids that outside ' +
      'src/config/anthropic.js, and keying prices by class is what lets a model rotation carry ' +
      'its price with it. Match the FAMILY with a regex instead.'
    );
  }
  Object.keys(usage.RATES_PER_MTOK).forEach((k) => {
    if (/\d/.test(k)) throw new Error(`RATES_PER_MTOK key "${k}" looks like a model id, not a class.`);
  });
});
