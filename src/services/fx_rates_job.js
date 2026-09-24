'use strict';

// src/services/fx_rates_job.js
//
// Launch eve 2026-09-24 (T6). The daily FX pull behind the international EGP
// charge (src/fx.js). Scheduled by job_queue.scheduleFxRates as the pg-boss
// queue 'fx-rates-pull' — daily, plus once at boot so a deploy does not wait
// until tomorrow to replace the seeded 2026-07-29 rates.
//
// Source: https://open.er-api.com/v6/latest/EGP — free, no key. It answers
// "1 EGP = rates[X] units of X"; fx_rates stores the inverse ("1 X = rate
// EGP", the fx.js convention), so rate = 1 / rates[X].
//
// A currency is written only if the API returned it as a finite, positive
// number; anything else keeps its previous row. The pull never deletes.
//
// Staleness: AFTER the pull attempt, if the freshest fx_rates row is more than
// 7 days old, sendCriticalAlert — and keep charging on those rates (there is
// nothing better to charge on; the alert is so a human knows). Checked after
// the attempt, not on read, so the seeded rows do not page anyone at deploy
// when the boot-time pull is about to replace them.

const FX_SOURCE_URL = 'https://open.er-api.com/v6/latest/EGP';
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Turn the API body into { USD: 50.5, … } (EGP per 1 unit), market currencies
 * only. Throws when the body is not a success response.
 */
function parseRates(body, currencies) {
  if (!body || body.result !== 'success' || !body.rates || typeof body.rates !== 'object') {
    throw new Error('fx source did not return success (result=' + (body && body.result) + ')');
  }
  if (body.base_code && String(body.base_code).toUpperCase() !== 'EGP') {
    throw new Error('fx source base is ' + body.base_code + ', expected EGP');
  }
  const out = {};
  for (const ccy of currencies) {
    const perEgp = Number(body.rates[ccy]);
    if (!Number.isFinite(perEgp) || perEgp <= 0) continue;
    // Round to 8 dp (the column scale). toEgp still rounds the CHARGE to whole
    // EGP exactly as before — only the rate's precision is new.
    out[ccy] = Math.round((1 / perEgp) * 1e8) / 1e8;
  }
  return out;
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.fetchFn]      fetch
 * @param {Function} [deps.executeFn]    pg execute(sql, params)
 * @param {Function} [deps.queryOneFn]   pg queryOne(sql, params)
 * @param {Function} [deps.alertFn]      sendCriticalAlert(message, key)
 * @param {Function} [deps.refreshFn]    fx.refreshRatesFromDb()
 * @param {Date}     [deps.now]
 * @returns {Promise<{ ok: boolean, written: string[], error?: string, freshestFetchedAt: (string|null), stale: boolean }>}
 */
async function runFxRatesPull(deps) {
  const d = deps || {};
  const pg = (d.executeFn && d.queryOneFn) ? null : require('../pg');
  const execute = d.executeFn || pg.execute;
  const queryOne = d.queryOneFn || pg.queryOne;
  const fetchFn = d.fetchFn || fetch;
  const fx = require('../fx');
  const refresh = d.refreshFn || fx.refreshRatesFromDb;
  const now = d.now || new Date();

  const result = { ok: false, written: [], freshestFetchedAt: null, stale: false };

  try {
    const res = await fetchFn(FX_SOURCE_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('fx source HTTP ' + res.status);
    const rates = parseRates(await res.json(), fx.MARKET_CURRENCIES);
    for (const [ccy, rate] of Object.entries(rates)) {
      await execute(
        `INSERT INTO fx_rates (base, quote, rate, fetched_at)
         VALUES ($1, 'EGP', $2, $3)
         ON CONFLICT (base, quote) DO UPDATE
           SET rate = EXCLUDED.rate, fetched_at = EXCLUDED.fetched_at`,
        [ccy, rate, now.toISOString()]
      );
      result.written.push(ccy);
    }
    result.ok = result.written.length > 0;
    if (!result.ok) result.error = 'fx source returned none of the market currencies';
  } catch (e) {
    result.error = String((e && e.message) || e);
    console.warn('[fx-rates] pull failed — keeping the previous rates:', result.error);
  }

  try { await refresh(); } catch (_) { /* fx.refreshRatesFromDb never throws; belt and braces */ }

  // Staleness, judged on what is actually in the table after this attempt.
  const st = await checkFxStaleness({
    now, queryOneFn: queryOne, alertFn: d.alertFn,
    detail: 'Last pull: ' + (result.error || 'ok') + '.'
  });
  result.freshestFetchedAt = st.freshestFetchedAt;
  result.stale = st.stale;
  return result;
}

/**
 * Alert when the freshest fx_rates row is older than STALE_AFTER_MS. Shared by
 * the daily job (after its pull) and the per-instance watch below. Never throws.
 */
async function checkFxStaleness({ now, queryOneFn, alertFn, detail } = {}) {
  const out = { freshestFetchedAt: null, stale: false };
  try {
    const q = queryOneFn || require('../pg').queryOne;
    const at = now || new Date();
    const row = await q("SELECT MAX(fetched_at) AS freshest FROM fx_rates WHERE quote = 'EGP'");
    const freshest = row && row.freshest ? new Date(row.freshest) : null;
    out.freshestFetchedAt = freshest ? freshest.toISOString() : null;
    if (freshest && at.getTime() - freshest.getTime() > STALE_AFTER_MS) {
      out.stale = true;
      const days = Math.floor((at.getTime() - freshest.getTime()) / 86400000);
      const send = alertFn || require('../critical-alert').sendCriticalAlert;
      await send(
        'FX rates are ' + days + ' days old (freshest ' + out.freshestFetchedAt.slice(0, 10) + '). ' +
        'International patients are still being charged on them. ' + (detail || ''),
        'fx_rates_stale'
      );
    }
  } catch (e) {
    console.warn('[fx-rates] staleness check failed:', e && e.message);
  }
  return out;
}

// ── The watch that does not depend on the job ─────────────────────────────
// The check above lives inside the job, so a queue that never runs (the
// failure pg-boss has produced twice here — see
// tests/lint/pgboss-queues-are-created.test.js) would never raise it. Every
// instance therefore also checks from its 10-minute rate refresh, but only
// once it has been up long enough for the boot pull to have had its chance,
// and at most every 12 hours per process (sendCriticalAlert's own throttle is
// 5 minutes, far too short for a 10-minute tick).
const WATCH_MIN_UPTIME_MS = 2 * 60 * 60 * 1000;
const WATCH_MIN_GAP_MS = 12 * 60 * 60 * 1000;
let _lastWatchAlertMs = 0;

async function fxStalenessWatchTick({ now, uptimeMs, queryOneFn, alertFn } = {}) {
  const at = now || new Date();
  const up = Number.isFinite(uptimeMs) ? uptimeMs : process.uptime() * 1000;
  if (up < WATCH_MIN_UPTIME_MS) return { checked: false, reason: 'warming_up' };
  if (_lastWatchAlertMs && at.getTime() - _lastWatchAlertMs < WATCH_MIN_GAP_MS) return { checked: false, reason: 'recently_alerted' };
  const st = await checkFxStaleness({
    now: at, queryOneFn, alertFn,
    detail: 'Raised by the instance watch — the daily fx-rates-pull job may not be running.'
  });
  if (st.stale) _lastWatchAlertMs = at.getTime();
  return Object.assign({ checked: true }, st);
}

module.exports = { runFxRatesPull, parseRates, checkFxStaleness, fxStalenessWatchTick, FX_SOURCE_URL, STALE_AFTER_MS };
