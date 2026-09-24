'use strict';
// tests/core/launch-eve-fx-rates.test.js
//
// 2026-09-24 (launch eve, T6). src/fx.js's hand-maintained RATES_TO_EGP
// (dated 2026-07-29) set the real EGP charge for international patients. Now:
// fx_rates (migration 118, seeded with those exact values), a daily pg-boss
// pull from open.er-api.com, fx.js reading the table (fallback only when it
// is empty), and a critical alert when the freshest row is > 7 days old.
// Hermetic: fetch, pg and the alert are fakes; fx.js is loaded fresh.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💱 FX rates: daily pull, DB-backed, never silently stale\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FX = require.resolve(path.join(ROOT, 'src/fx.js'));
const JOB = require.resolve(path.join(ROOT, 'src/services/fx_rates_job.js'));

// The real response shape of https://open.er-api.com/v6/latest/EGP (trimmed).
const API_OK = {
  result: 'success', provider: 'https://www.exchangerate-api.com', base_code: 'EGP',
  time_last_update_utc: 'Thu, 24 Sep 2026 00:02:31 +0000',
  rates: { EGP: 1, USD: 0.0198, GBP: 0.01456, AED: 0.07272, SAR: 0.07426, QAR: 0.07208,
    KWD: 0.006031, BHD: 0.007446, OMR: 0.007616, EUR: 0.0169 }
};

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

module.exports = (async function run() {
  const savedFx = require.cache[FX];
  const savedJob = require.cache[JOB];
  delete require.cache[FX];
  delete require.cache[JOB];
  const fx = require(FX);
  const job = require(JOB);
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await check('the API\'s EGP→X rate is INVERTED into fx.js\'s X→EGP (USD 0.0198 → ~50.5)', () => {
      const r = job.parseRates(API_OK, fx.MARKET_CURRENCIES);
      if (!(r.USD > 50.4 && r.USD < 50.6)) throw new Error('USD ' + r.USD);
      if (!(r.KWD > 165 && r.KWD < 167)) throw new Error('KWD ' + r.KWD);
      if ('EUR' in r || 'EGP' in r) throw new Error('non-market currency written');
      if (Object.keys(r).sort().join() !== fx.MARKET_CURRENCIES.slice().sort().join()) throw new Error('missing: ' + Object.keys(r));
    });

    await check('a non-success body is refused; missing/zero/garbage currencies are skipped', () => {
      let threw = false;
      try { job.parseRates({ result: 'error', 'error-type': 'unsupported-code' }, fx.MARKET_CURRENCIES); } catch (_) { threw = true; }
      if (!threw) throw new Error('error body accepted');
      const r = job.parseRates({ result: 'success', base_code: 'EGP', rates: { USD: 0, GBP: 'x', AED: 0.0727 } }, fx.MARKET_CURRENCIES);
      if (Object.keys(r).join() !== 'AED') throw new Error(JSON.stringify(r));
    });

    await check('a successful pull upserts every market currency, reloads fx, and does not alert', async () => {
      const writes = []; const alerts = []; let refreshed = 0;
      const now = new Date('2026-09-24T03:10:00Z');
      const res = await job.runFxRatesPull({
        now,
        fetchFn: async () => ({ ok: true, json: async () => API_OK }),
        executeFn: async (sql, params) => { writes.push({ sql, params }); },
        queryOneFn: async () => ({ freshest: now.toISOString() }),
        alertFn: async (m, k) => { alerts.push([m, k]); },
        refreshFn: async () => { refreshed++; }
      });
      if (!res.ok || writes.length !== 8) throw new Error('wrote ' + writes.length + ' ' + JSON.stringify(res));
      if (!/ON CONFLICT \(base, quote\) DO UPDATE/.test(writes[0].sql)) throw new Error('not an upsert');
      if (writes.some((w) => w.params[2] !== now.toISOString())) throw new Error('fetched_at not the pull time');
      if (refreshed !== 1) throw new Error('fx not reloaded');
      if (alerts.length) throw new Error('alerted on fresh rates');
    });

    await check('a failed pull keeps the old rates and alerts when the freshest row is > 7 days old', async () => {
      const writes = []; const alerts = [];
      const res = await job.runFxRatesPull({
        now: new Date('2026-09-24T03:10:00Z'),
        fetchFn: async () => { throw new Error('ENOTFOUND open.er-api.com'); },
        executeFn: async (sql, params) => { writes.push(params); },
        queryOneFn: async () => ({ freshest: '2026-07-29T00:00:00Z' }), // the seed
        alertFn: async (m, k) => { alerts.push([m, k]); },
        refreshFn: async () => {}
      });
      if (writes.length) throw new Error('wrote on a failed pull');
      if (!res.stale || alerts.length !== 1) throw new Error('no stale alert: ' + JSON.stringify(res));
      if (alerts[0][1] !== 'fx_rates_stale' || !/57 days old/.test(alerts[0][0])) throw new Error(alerts[0][0]);
    });

    await check('exactly 7 days old is not yet stale', async () => {
      const alerts = [];
      await job.runFxRatesPull({
        now: new Date('2026-09-24T00:00:00Z'),
        fetchFn: async () => { throw new Error('down'); },
        executeFn: async () => {}, refreshFn: async () => {},
        queryOneFn: async () => ({ freshest: '2026-09-17T00:00:00Z' }),
        alertFn: async (m) => { alerts.push(m); }
      });
      if (alerts.length) throw new Error('alerted at exactly 7 days');
    });

    await check('the instance watch alerts even if the job never runs — after 2h uptime, at most every 12h', async () => {
      const alerts = [];
      const stale = async () => ({ freshest: '2026-07-29T00:00:00Z' });
      const w1 = await job.fxStalenessWatchTick({ now: new Date('2026-09-24T01:00:00Z'), uptimeMs: 30 * 60000, queryOneFn: stale, alertFn: async (m, k) => alerts.push(k) });
      if (w1.checked || alerts.length) throw new Error('alerted while warming up');
      await job.fxStalenessWatchTick({ now: new Date('2026-09-24T03:00:00Z'), uptimeMs: 3 * 3600000, queryOneFn: stale, alertFn: async (m, k) => alerts.push(k) });
      if (alerts.join() !== 'fx_rates_stale') throw new Error('no watch alert: ' + alerts);
      await job.fxStalenessWatchTick({ now: new Date('2026-09-24T03:10:00Z'), uptimeMs: 3 * 3600000, queryOneFn: stale, alertFn: async (m, k) => alerts.push(k) });
      if (alerts.length !== 1) throw new Error('re-alerted within 12h');
      await job.fxStalenessWatchTick({ now: new Date('2026-09-24T15:10:00Z'), uptimeMs: 15 * 3600000, queryOneFn: stale, alertFn: async (m, k) => alerts.push(k) });
      if (alerts.length !== 2) throw new Error('did not re-alert after 12h');
    });

    await check('fx.js: empty table → the hardcoded rates (charges unchanged)', async () => {
      await fx.refreshRatesFromDb({ queryAllFn: async () => [] });
      if (fx.ratesStatus().source !== 'fallback') throw new Error('source ' + fx.ratesStatus().source);
      if (fx.toEgp(100, 'USD') !== 5050) throw new Error('USD 100 → ' + fx.toEgp(100, 'USD'));
    });

    await check('fx.js: table rows win; toEgp still rounds the charge to whole EGP', async () => {
      await fx.refreshRatesFromDb({ queryAllFn: async () => [
        { base: 'USD', rate: '50.50505051', fetched_at: '2026-09-24T03:10:00Z' },
        { base: 'GBP', rate: '68.68131868', fetched_at: '2026-09-24T03:10:00Z' }
      ] });
      const st = fx.ratesStatus();
      if (st.source !== 'db' || st.freshestFetchedAt.toISOString() !== '2026-09-24T03:10:00.000Z') throw new Error(JSON.stringify(st));
      if (fx.toEgp(250, 'GBP') !== Math.round(250 * 68.68131868)) throw new Error('GBP ' + fx.toEgp(250, 'GBP'));
      if (!Number.isInteger(fx.toEgp(99.99, 'USD'))) throw new Error('not whole EGP');
      if (fx.toEgp(100, 'AED') !== 1375) throw new Error('a currency missing from the table must keep its fallback rate');
      if (fx.toEgp(1234.5, 'EGP') !== 1234.5) throw new Error('EGP identity lane changed');
    });

    await check('fx.js: a failed read keeps the last good rates', async () => {
      await fx.refreshRatesFromDb({ queryAllFn: async () => { throw new Error('pool timeout'); } });
      if (fx.ratesStatus().source !== 'db') throw new Error('dropped the DB rates on a read error');
    });
  } finally {
    console.warn = origWarn;
    if (savedFx) require.cache[FX] = savedFx; else delete require.cache[FX];
    if (savedJob) require.cache[JOB] = savedJob; else delete require.cache[JOB];
  }

  await check('migration 118 seeds EXACTLY the hardcoded rates, dated 2026-07-29', () => {
    const sql = read('src/migrations/118_fx_rates.sql');
    const { RATES_TO_EGP } = require(FX);
    for (const [ccy, rate] of Object.entries(RATES_TO_EGP)) {
      if (ccy === 'EGP') continue;
      const m = new RegExp("\\('" + ccy + "',\\s*'EGP',\\s*([0-9.]+),\\s*'2026-07-29T00:00:00Z'\\)").exec(sql);
      if (!m) throw new Error(ccy + ' not seeded');
      if (Number(m[1]) !== rate) throw new Error(ccy + ' seeded ' + m[1] + ' vs code ' + rate);
    }
    if (!/ENABLE ROW LEVEL SECURITY/.test(sql)) throw new Error('RLS not enabled');
  });

  await check('the queue is created, worked, scheduled daily and pulled once at boot; server wires it', () => {
    const q = read('src/job_queue.js');
    for (const re of [/boss\.createQueue\('fx-rates-pull'\)/, /boss\.work\('fx-rates-pull'/, /boss\.schedule\('fx-rates-pull'/, /boss\.send\('fx-rates-pull'/]) {
      if (!re.test(q)) throw new Error('job_queue.js missing ' + re);
    }
    const s = read('src/server.js');
    if (!/await scheduleFxRates\(\)/.test(s)) throw new Error('server.js does not schedule it');
    if (!/await _fx\.refreshRatesFromDb\(\);[\s\S]{0,200}setInterval\(function \(\) \{\s*_fx\.refreshRatesFromDb\(\);[\s\S]{0,300}fxStalenessWatchTick\(\);[\s\S]{0,200}intervalIds\.push\(fxRefreshIntervalId\)/.test(s)) throw new Error('instances do not reload rates / run the staleness watch');
  });
})();
