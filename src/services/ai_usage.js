'use strict';

// services/ai_usage.js — where the Anthropic credits actually go.
//
// 2026-08-25, Ziad's ask: "a section to see where my API credits are going".
//
// WHAT WAS THERE BEFORE. The `agent_token_log` table already existed with
// exactly the right columns (agent_name, tokens_used, cost_usd, task_label),
// plus a reader in routes/ops.js and a writer on an ops endpoint nobody calls.
// It was EMPTY, and not one of the six real Anthropic call sites wrote to it.
// So the honest answer to "where are my credits going" was "nobody knows" — the
// only source of truth was the Anthropic console, which reports one total for
// the whole account and cannot tell a case classification from a marketing post.
//
// This module is the missing writer, plus the vocabulary that makes the answer
// useful: a PURPOSE per call, so the spend can be read as a sentence about the
// business rather than a number.
//
// ── Tokens are exact. Cost is an ESTIMATE, and is labelled as one. ─────────
//
// Every Anthropic response carries `usage.input_tokens` / `output_tokens`, so
// the token counts here are the real ones. The dollar figures are derived from
// the price table below, which is a local copy of public list prices and WILL
// drift when Anthropic changes them or when a call uses cache reads, batch
// pricing, or a model we have not listed.
//
// So: the console is authoritative for what you are billed. This is
// authoritative for the SPLIT — which feature is eating the budget. That is the
// question actually being asked, and it is one the console cannot answer.
// Anything surfacing these numbers must say "estimated" and mean it.

const { randomUUID } = require('crypto');
const { execute, queryAll } = require('../pg');
const { modelSonnet, modelHaiku, modelVision } = require('../config/anthropic');

// ─── Purposes ───────────────────────────────────────────────────────────────
//
// Deliberately named after what the BUSINESS gets, not after the module that
// happens to make the call. "order_wizard" is a thing Ziad can decide to spend
// more or less on; "classify_job" is not.
const PURPOSES = Object.freeze({
  order_wizard:      'Order wizard — routing a case to a specialty',
  document_check:    'Document checks — is this scan usable',
  case_intelligence: 'Case intelligence — summaries for the doctor',
  intake_triage:     'Website intake — suggesting a case type',
  assistant:         'Support assistant',
  marketing:         'Marketing content',
  health_canary:     'Health canary — the probe that detects an outage',
  other:             'Other',
});

// USD per MILLION tokens, by model CLASS. Public list prices, 2026-08.
//
// Keyed by class, NOT by model id, and that is deliberate twice over:
//
//  1. Theme 9 Sub-issue D forbids `claude-…` literals anywhere but
//     config/anthropic.js, and there is a test that enforces it. A price table
//     full of model ids would be exactly the drift that rule exists to stop.
//  2. The ids rotate. A table keyed by id would silently start pricing the new
//     model at the fallback rate the day a rotation lands — the one day the
//     numbers most need to be right.
//
// The mapping from id to class goes through the config helpers, so a rotation
// carries the price with it.
//
// 2026-08-29 — opus added. The table held haiku and sonnet only, and priceFor()
// fell through to SONNET for everything else, so an Opus-class call was billed
// into this ledger at ONE FIFTH of its real rate. The "unknown prices at the
// expensive rate" rule below is what makes that a silent under-report rather
// than an obvious zero, so it has to be the most expensive rate ACTUALLY KNOWN,
// not a hard-coded class — see MOST_EXPENSIVE_RATE.
const RATES_PER_MTOK = Object.freeze({
  haiku:  { input: 1.00, output: 5.00 },
  sonnet: { input: 3.00, output: 15.00 },
  opus:   { input: 15.00, output: 75.00 },
});

// The dearest rate card in the table, derived rather than named. Adding a class
// above automatically moves the unknown-model fallback if the new class is more
// expensive, which is the only way the "never under-report an unknown model"
// rule survives the next price list.
const MOST_EXPENSIVE_RATE = Object.values(RATES_PER_MTOK)
  .reduce((a, b) => (b.output > a.output ? b : a));

// Prompt-caching multipliers on the base input rate. Two of the six call sites
// — case intelligence and the support assistant — send a large stable prefix
// wrapped in cache_control. For those, `usage.input_tokens` counts only the
// UNCACHED remainder, so pricing on it alone under-reports the real spend by
// most of the call. The cache tokens arrive in separate usage fields and are
// billed at different rates; both are folded in below.
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute ephemeral write
const CACHE_READ_MULTIPLIER  = 0.10; // cache hit

/**
 * Rate card for a model id.
 *
 * Three steps, cheapest and most certain first: ask the config what each class
 * currently resolves to; failing that, read the family out of the id (which
 * survives a rotation the config has not caught up with); failing that, price
 * it at the dearest rate in the table.
 *
 * The last step matters. An UNKNOWN model prices at the MOST EXPENSIVE KNOWN
 * rate, never at zero — a spend we cannot price should look expensive, not
 * free. A zero would quietly under-report exactly the new model someone just
 * switched to, which is the one case where a wrong number would go unnoticed.
 *
 * 2026-08-29 — the family sniff now covers Opus, and the fallback is
 * MOST_EXPENSIVE_RATE rather than a hard-coded Sonnet. Before this, an
 * Opus-class id matched no branch and fell through to Sonnet: a real 5×
 * under-report, presented with the same confidence as every other figure.
 *
 * The sniff stays a FAMILY regex, never a model-id literal — tests/core/
 * anthropic-model-centralisation.test.js forbids `claude-…` outside
 * src/config/anthropic.js, and keying prices by class is what lets a model
 * rotation carry its price with it.
 */
function priceFor(model) {
  const key = String(model || '').trim();
  if (key) {
    if (key === modelHaiku()) return RATES_PER_MTOK.haiku;
    if (key === modelSonnet() || key === modelVision()) return RATES_PER_MTOK.sonnet;
    if (/haiku/i.test(key)) return RATES_PER_MTOK.haiku;
    if (/opus/i.test(key)) return RATES_PER_MTOK.opus;
    if (/sonnet/i.test(key)) return RATES_PER_MTOK.sonnet;
  }
  return MOST_EXPENSIVE_RATE;
}

/**
 * Pull the four token counts out of an Anthropic `usage` block.
 *
 * Tolerates both the SDK's snake_case and a camelCase shape, because two call
 * sites talk to the HTTP API directly with `https.request` rather than through
 * the SDK and one day someone will normalise them.
 */
function readUsage(usage) {
  const u = usage || {};
  const n = (a, b) => Number(u[a] ?? u[b] ?? 0) || 0;
  return {
    input:      n('input_tokens', 'inputTokens'),
    output:     n('output_tokens', 'outputTokens'),
    cacheWrite: n('cache_creation_input_tokens', 'cacheCreationInputTokens'),
    cacheRead:  n('cache_read_input_tokens', 'cacheReadInputTokens'),
  };
}

/**
 * Estimated USD for one call.
 * @param {string} model
 * @param {object} usage the response's `usage` block (or a shape like it)
 * @returns {number} rounded to 6dp — individual calls are fractions of a cent.
 */
function estimateCostUsd(model, usage) {
  const p = priceFor(model);
  const t = readUsage(usage);
  const usd =
    (t.input / 1e6) * p.input +
    (t.cacheWrite / 1e6) * p.input * CACHE_WRITE_MULTIPLIER +
    (t.cacheRead / 1e6) * p.input * CACHE_READ_MULTIPLIER +
    (t.output / 1e6) * p.output;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Record one Anthropic call.
 *
 * NON-THROWING BY CONTRACT. This is called from inside the classifier, the
 * image check and the assistant — accounting must never be the reason a
 * patient's case fails to route. Every caller wraps it anyway; this is the
 * second layer.
 *
 * @param {object} args
 * @param {string} args.purpose      one of PURPOSES
 * @param {string} args.model        the model id actually used
 * @param {object} [args.usage]      the response's `usage` block
 * @param {string} [args.label]      free text — an order id, a campaign name
 */
async function recordAiUsage({ purpose, model, usage, label }) {
  try {
    const p = Object.prototype.hasOwnProperty.call(PURPOSES, String(purpose || ''))
      ? String(purpose)
      : 'other';
    const t = readUsage(usage);
    // input_tokens stores EVERYTHING sent — uncached, cache writes and cache
    // reads together — because the question this table answers is "how much did
    // this feature consume", and a cached token is still a token that was paid
    // for (at a different rate, which cost_usd already reflects). Splitting the
    // three would need three more columns to answer a question nobody asks.
    const inTok = t.input + t.cacheWrite + t.cacheRead;
    const outTok = t.output;
    const total = inTok + outTok;
    // A call that reported no usage at all is still worth a row — it is
    // evidence the feature ran, and a purpose with many calls and no tokens is
    // itself a finding.
    await execute(
      `INSERT INTO agent_token_log
         (id, agent_name, tokens_used, cost_usd, task_label, logged_at,
          purpose, model, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)`,
      [randomUUID(), p, total, estimateCostUsd(model, usage),
       label ? String(label).slice(0, 200) : null, p, String(model || '').slice(0, 80),
       inTok, outTok]
    );
  } catch (_) {
    // Swallowed. See the contract above.
  }
}

// ─── AUDIT-AI-WINDOW (2026-08-29) — ONE window, used by BOTH readers ────────
//
// THE BUG. usageDailyTotals filtered on a ROLLING INSTANT
// (`logged_at >= NOW() - N days`) and then built its dense day array from the
// last N CAIRO CALENDAR DAYS. Those are not the same period. A rolling 1-day
// window at 09:00 Cairo starts at 09:00 YESTERDAY, so calls made yesterday
// morning are inside the SQL result and have a key ('2026-08-28') that the
// array — which for days=1 holds only today — does not contain. The row is
// silently dropped by the `byDay.get(key)` lookup.
//
// usageByPurpose used the SAME rolling predicate, so those calls stayed in the
// headline `total`. The screen rendered exactly that contradiction:
//
//     $7.7777 · 1 call        (KPI, rolling window)
//     "No spend recorded on any day in this window."   (chart, Cairo days)
//
// THE FIX. Both queries bound on the CAIRO DAY BOUNDARY — 00:00 Cairo of the
// oldest day the chart draws — so the SQL window and the JS array describe the
// same period by construction, and every row the total counts has a bucket to
// land in.
//
// The two-step `AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo'` is mandatory
// and must stay two steps: logged_at is `timestamp WITHOUT time zone` holding
// UTC digits (every writer is SQL NOW() under the UTC-pinned session in
// src/pg.js). A single AT TIME ZONE would reinterpret UTC digits as Cairo wall
// clock and shift every bucket by the offset.
//
// The lower bound subtracts days from a NAIVE Cairo timestamp, which is pure
// calendar arithmetic — no DST offset can creep into it — matching
// cairoDayKeysEndingToday() below step for step.
const AI_TZ = 'Africa/Cairo';
const LOGGED_AT_CAIRO = `(logged_at AT TIME ZONE 'UTC' AT TIME ZONE '${AI_TZ}')`;
const WINDOW_START_CAIRO =
  `(date_trunc('day', (NOW() AT TIME ZONE '${AI_TZ}')) - make_interval(days => $1::int - 1))`;
const IN_WINDOW = `${LOGGED_AT_CAIRO} >= ${WINDOW_START_CAIRO}`;

/**
 * Spend by purpose over a window, for the Command app.
 *
 * Returns purposes with ZERO usage too. An empty row is information — "the
 * order wizard has cost nothing this month" means either a quiet month or a
 * broken classifier, and the operator should be able to tell which from the
 * case count elsewhere rather than from a missing row.
 *
 * Windowed by IN_WINDOW, the IDENTICAL predicate usageDailyTotals uses, so the
 * KPI above the chart and the chart itself can never describe different periods.
 */
async function usageByPurpose(days) {
  const windowDays = Math.max(1, Math.min(365, Number(days) || 30));
  const rows = await queryAll(
    `SELECT COALESCE(purpose, agent_name, 'other') AS purpose,
            COUNT(*)::int                AS calls,
            COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(tokens_used), 0)::bigint   AS total_tokens,
            COALESCE(SUM(cost_usd), 0)   AS cost_usd,
            MAX(logged_at)               AS last_call
       FROM agent_token_log
      WHERE ${IN_WINDOW}
      GROUP BY 1`,
    [windowDays]
  );

  const byPurpose = new Map(rows.map(r => [String(r.purpose), r]));
  const out = Object.keys(PURPOSES).map(function (key) {
    const r = byPurpose.get(key);
    return {
      purpose: key,
      label: PURPOSES[key],
      calls: r ? Number(r.calls) : 0,
      inputTokens: r ? Number(r.input_tokens) : 0,
      outputTokens: r ? Number(r.output_tokens) : 0,
      totalTokens: r ? Number(r.total_tokens) : 0,
      costUsd: r ? Math.round(Number(r.cost_usd) * 1e6) / 1e6 : 0,
      lastCall: r && r.last_call ? new Date(r.last_call).toISOString() : null,
    };
  });

  // Anything recorded under a purpose this build does not know about — an older
  // deploy, or a new feature added after this one. Surfaced rather than
  // dropped, so the totals always add up to what was actually spent.
  for (const [key, r] of byPurpose) {
    if (Object.prototype.hasOwnProperty.call(PURPOSES, key)) continue;
    out.push({
      purpose: key,
      label: key,
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      totalTokens: Number(r.total_tokens),
      costUsd: Math.round(Number(r.cost_usd) * 1e6) / 1e6,
      lastCall: r.last_call ? new Date(r.last_call).toISOString() : null,
    });
  }

  out.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return out;
}

/**
 * Daily totals over a window — the sparkline under the breakdown.
 *
 * Bucketed in Cairo wall-clock, not UTC, for the same reason the revenue tiles
 * are (AUDIT-TZ-3 in routes/api/admin.js): "yesterday" has to mean the same day
 * on the spend screen as it does on the money screen, or the two disagree for
 * two hours every night and nobody can tell which is wrong.
 *
 * Days with no calls are returned as zeros. A gap in the array would read as
 * missing data; a zero reads as a quiet day, which is what it is.
 */
async function usageDailyTotals(days) {
  const windowDays = Math.max(1, Math.min(365, Number(days) || 30));
  const rows = await queryAll(
    // IN_WINDOW — the SAME bound usageByPurpose applies, on the Cairo day
    // boundary rather than a rolling instant. See the long AUDIT-AI-WINDOW note
    // above for the KPI-vs-chart contradiction the rolling bound produced.
    `SELECT to_char(date_trunc('day', ${LOGGED_AT_CAIRO}), 'YYYY-MM-DD') AS day,
            COUNT(*)::int              AS calls,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM agent_token_log
      WHERE ${IN_WINDOW}
      GROUP BY 1`,
    [windowDays]
  );
  const byDay = new Map(rows.map(r => [String(r.day), r]));

  // Dense, ordered, and built by CALENDAR arithmetic — see
  // cairoDayKeysEndingToday for why fixed-ms stepping was wrong.
  return cairoDayKeysEndingToday(windowDays).map((key) => {
    const r = byDay.get(key);
    return {
      day: key,
      calls: r ? Number(r.calls) : 0,
      // AUDIT-AI-PRECISION (2026-08-29) — SIX decimals, not four.
      //
      // Individual calls cost fractions of a cent: estimateCostUsd already
      // rounds to 1e-6 and a real day's spend has been as low as $0.000039
      // across 3 calls. Rounding to 4dp turned that into 0.0000, which the app
      // then drew as a zero-height bar — defeating the 2% minimum-height floor
      // that exists precisely so a small non-zero day is still visible, and
      // reading as "nothing happened" on a day something did. The payload keeps
      // the precision; formatting for display is the app's job.
      costUsd: r ? Math.round(Number(r.cost_usd) * 1e6) / 1e6 : 0,
    };
  });
}

// The Cairo calendar day an instant falls on, as YYYY-MM-DD.
//
// Via Intl rather than by adding a fixed offset: Cairo is UTC+2 in winter and
// UTC+3 under DST, and a hard-coded offset would put every call on the wrong
// day for half the year. 'en-CA' is the locale whose short date format IS
// ISO — the same trick, and the same reason, as elsewhere in the codebase.
// The keys produced here must match to_char(...,'YYYY-MM-DD') above exactly,
// or every day looks empty.
const _cairoDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});
function cairoDayKey(d) {
  return _cairoDayFmt.format(d);
}

// ─── AUDIT-AI-DST (2026-08-29) — the N Cairo days ending today, oldest first ─
//
// The old loop was `cairoDayKey(new Date(Date.now() - i * 86400000))`: step back
// a FIXED 86 400 000 ms and ask Intl which Cairo day that lands on. Egypt
// observes DST, so on the two transition nights a year one step is 23 or 25
// hours of wall clock and the fixed step lands on the WRONG side of it:
//   * spring forward → two consecutive steps format to the SAME Cairo date,
//     producing a duplicate bar (and a duplicate React key in the chart);
//   * autumn back    → a Cairo date is SKIPPED entirely, so a day with real
//     spend has no bucket to land in and is silently dropped.
// On the 30-day tab that is roughly 30 affected nights a year, twice over.
//
// Calendar arithmetic instead: take TODAY's Cairo date parts and walk the DAY
// field. Date.UTC normalises an out-of-range day across month and year
// boundaries for free, and UTC has no DST, so every step is exactly one
// calendar day. The keys are formatted from the same UTC parts rather than
// re-run through Intl, so they cannot drift back into the offset problem.
function cairoDayKeysEndingToday(days) {
  const pad = (v) => String(v).padStart(2, '0');
  const [y, m, d] = cairoDayKey(new Date()).split('-').map(Number);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = new Date(Date.UTC(y, m - 1, d - i));
    out.push(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`);
  }
  return out;
}

module.exports = {
  recordAiUsage,
  usageByPurpose,
  usageDailyTotals,
  estimateCostUsd,
  PURPOSES,
  RATES_PER_MTOK,
  // Exported for tests/services/ai-usage-window-and-rates.test.js: the DST-safe
  // day walk and the window predicate are the two things that must not regress.
  cairoDayKeysEndingToday,
  IN_WINDOW,
};
