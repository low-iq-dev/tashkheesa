'use strict';

// 26 Oct 2026 — a patient from ANY country can sign up, is quoted a price in
// a sensible currency, and pays (always in EGP). Hermetic: src/pg is replaced
// by a fake, no database and no network. Run: node tests/core/any-country-signup.test.js
//
// What is held here:
//   1. pricingMarketFor — the one resolver every price lookup goes through;
//   2. the public pages quote the same list the checkout charges;
//   3. the intake pricer charges a Libyan the Egyptian base price (never an EG
//      row) and a German the GB list;
//   4. POST /register accepts a German, a Libyan and a Japanese patient and
//      stores their real country, and refuses a code that is not a country;
//   5. every register outcome is a funnel count, and prefetches are not views;
//   6. any country's number normalises with its dial code.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = (p) => path.join(ROOT, 'src', p);

const { pricingMarketFor, pricingProxyFor, PRICED_MARKETS, EUROPE_TO_GB, ARAB_TO_EG } =
  require(SRC('services/pricing_market'));
const { COUNTRIES, isValidCountry, countryForDial } = require(SRC('lib/countries'));

// ── 1. the resolver ─────────────────────────────────────────────────────────
test('pricingMarketFor: the nine priced markets map to themselves', () => {
  assert.equal(pricingMarketFor('EG'), 'EG');
  for (const cc of PRICED_MARKETS) assert.equal(pricingMarketFor(cc), cc, cc);
});

test('pricingMarketFor: Europe → GB, everything else (incl. non-Gulf Arab) → US', () => {
  for (const cc of ['DE', 'FR', 'PL', 'IT', 'IE', 'UA', 'RS', 'CH']) assert.equal(pricingMarketFor(cc), 'GB', cc);
  for (const cc of EUROPE_TO_GB) assert.equal(pricingMarketFor(cc), 'GB', cc);
  for (const cc of ['JO', 'LB', 'IQ', 'LY', 'SD', 'YE', 'SY', 'PS', 'MA', 'TN', 'DZ', 'MR']) assert.equal(pricingMarketFor(cc), 'US', cc);
  assert.deepEqual([...ARAB_TO_EG], [], 'only Egypt pays the Egyptian price');
  for (const cc of ['JP', 'NG', 'BR', 'IN', 'AU', 'CA', 'TR', 'RU', 'ZA', 'CN']) assert.equal(pricingMarketFor(cc), 'US', cc);
});

test('pricingMarketFor: dirty input — names, casing, junk', () => {
  assert.equal(pricingMarketFor('Egypt'), 'EG');
  assert.equal(pricingMarketFor(' eg '), 'EG');
  assert.equal(pricingMarketFor('de'), 'GB');
  assert.equal(pricingMarketFor('Libya'), 'US');
  assert.equal(pricingMarketFor('UK'), 'GB');
  for (const v of [null, undefined, '', 'Wakanda']) assert.equal(pricingMarketFor(v), 'US', String(v));
});

test('pricingMarketFor: every signup country resolves to a list that exists', () => {
  const lists = new Set(['EG'].concat(PRICED_MARKETS));
  for (const c of COUNTRIES) assert.ok(lists.has(pricingMarketFor(c.iso)), c.iso + ' → ' + pricingMarketFor(c.iso));
});

test('pricingProxyFor: null when the country prices itself, else its proxy list', () => {
  assert.equal(pricingProxyFor('EG'), null);
  assert.equal(pricingProxyFor('GB'), null);
  assert.equal(pricingProxyFor('LY'), 'US');
  assert.equal(pricingProxyFor('DE'), 'GB');
  assert.equal(pricingProxyFor('JP'), 'US');
});

// ── 2. public pages agree with checkout ─────────────────────────────────────
test('public_market.marketFor quotes the same list as pricingMarketFor for every country', () => {
  const pm = require(SRC('services/public_market'));
  for (const c of COUNTRIES) assert.equal(pm.marketFor(c.iso), pricingMarketFor(c.iso), c.iso);
  assert.equal(pm.marketFor(null), 'EG', 'a visitor we cannot place keeps the home page');
});

// ── fake pg harness ─────────────────────────────────────────────────────────
const PG = require.resolve(SRC('pg.js'));
function withFakePg(fake, mods, fn) {
  const realPg = require(PG);
  const ids = [PG].concat(mods.map((m) => require.resolve(SRC(m))));
  const saved = {};
  for (const id of ids) saved[id] = require.cache[id];
  require.cache[PG] = { id: PG, filename: PG, loaded: true, exports: Object.assign({}, realPg, fake) };
  for (const id of ids.slice(1)) delete require.cache[id];
  const restore = () => { for (const id of ids) { if (saved[id]) require.cache[id] = saved[id]; else delete require.cache[id]; } };
  return Promise.resolve().then(fn).finally(restore);
}

// ── 3. the intake pricer ────────────────────────────────────────────────────
test('intake pricer: a Libyan pays the US list, a German the GB list — both charged in EGP, above the Egyptian price', async () => {
  const seen = [];
  const fake = {
    queryOne: async (sql, params) => {
      seen.push(params);
      if (/service_regional_prices/.test(sql) && params[1] === 'GB') return { tashkheesa_price: 250, currency: 'GBP' };
      if (/service_regional_prices/.test(sql) && params[1] === 'US') return { tashkheesa_price: 200, currency: 'USD' };
      return null;
    }
  };
  await withFakePg(fake, ['services/case_intake_pricing.js'], async () => {
    const cip = require(SRC('services/case_intake_pricing'));
    const service = { id: 'svc-mri', base_price: 2400, currency: 'EGP' };

    seen.length = 0;
    const ly = await cip.priceCaseForMarket({ service, country: 'LY', urgencyTier: 'standard' });
    assert.equal(ly.pricingMarket, 'US');
    assert.equal(ly.charge.displayCurrency, 'USD');
    assert.ok(ly.charge.egpBase > 2400, 'Libya pays the international fee, not the Egyptian price');
    assert.ok(!seen.some((p) => p && p[1] === 'EG'), 'never reads an EG row from service_regional_prices');

    seen.length = 0;
    const de = await cip.priceCaseForMarket({ service, country: 'DE', urgencyTier: 'standard' });
    assert.equal(de.pricingMarket, 'GB');
    assert.equal(de.charge.displayCurrency, 'GBP');
    assert.equal(de.charge.displayPrice, 250);
    assert.ok(de.charge.egpBase > 2400, 'the GB list, converted to EGP, not the Egyptian price');
  });
});

// ── 4 + 5. POST /register ───────────────────────────────────────────────────
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-any-country';

function makeRegisterHarness() {
  const rec = { inserts: [], funnel: [] };
  const fake = {
    queryOne: async () => null,
    queryAll: async () => [],
    execute: async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO funnel_daily_counts/.test(s)) { rec.funnel.push(params[1]); return { rowCount: 1 }; }
      if (/INSERT INTO users/.test(s)) { rec.inserts.push({ sql: s.replace(/\s+/g, ' '), params }); return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    }
  };
  return { rec, fake };
}

let uaSeq = 0;
function fakeReqRes(body, headers) {
  const h = Object.assign({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) test/' + (++uaSeq) }, headers || {});
  const req = {
    body, query: {}, cookies: {}, headers: h, ip: '203.0.113.' + (uaSeq % 250),
    get: (k) => h[String(k).toLowerCase()], user: null
  };
  const out = { status: 200, view: null, locals: null, redirect: null };
  const res = {
    locals: {},
    status(c) { out.status = c; return res; },
    render(v, l) { out.view = v; out.locals = l; return res; },
    redirect(a, b) { out.status = typeof a === 'number' ? a : 302; out.redirect = typeof a === 'number' ? b : a; return res; },
    cookie() { return res; }, clearCookie() { return res; }, set() { return res; }
  };
  return { req, res, out };
}

function registerHandler() {
  const router = require(SRC('routes/auth.js'));
  const layer = router.stack.find((l) => l.route && l.route.path === '/register' && l.route.methods.post);
  assert.ok(layer, 'POST /register is on the router');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const MODS = ['routes/auth.js', 'services/funnel_digest.js'];

test('POST /register: a German, a Libyan and a Japanese patient can sign up, with their real country', async () => {
  const { rec, fake } = makeRegisterHarness();
  await withFakePg(fake, MODS, async () => {
    const handle = registerHandler();
    const cases = [
      ['DE', '01512 3456789', '+4915123456789'],
      ['LY', '091 234 5678', '+218912345678'],
      ['JP', '090-1234-5678', '+819012345678']
    ];
    for (const [cc, local, e164] of cases) {
      const { req, res, out } = fakeReqRes({ name: 'Patient ' + cc, country_code: cc, phone: local, terms: 'on' });
      await handle(req, res, () => {});
      assert.equal(out.status, 302, cc + ' should be signed up and redirected, got ' + out.status + ' ' + (out.locals && out.locals.error));
      const ins = rec.inserts[rec.inserts.length - 1];
      assert.ok(ins, cc + ': a users row was inserted');
      assert.match(ins.sql, /country, country_code/, 'both country columns are written');
      assert.ok(ins.params.includes(cc), cc + ' stored as the real country: ' + JSON.stringify(ins.params));
      assert.ok(ins.params.includes(e164), cc + ' phone normalised with its dial code: ' + JSON.stringify(ins.params));
    }
  });
});

test('POST /register: a code that is not a country is still refused', async () => {
  const { rec, fake } = makeRegisterHarness();
  await withFakePg(fake, MODS, async () => {
    const handle = registerHandler();
    for (const bad of ['XX', 'ZZ', 'EGY']) {
      const { req, res, out } = fakeReqRes({ name: 'P', country_code: bad, phone: '0123456789', terms: 'on' });
      await handle(req, res, () => {});
      assert.equal(out.status, 400, bad);
      assert.equal(out.view, 'register');
      assert.match(String(out.locals.error), /valid country/i, bad);
    }
    assert.equal(rec.inserts.length, 0, 'nothing inserted for an invalid country');
  });
});

test('POST /register: every outcome is a funnel count, by reason', async () => {
  const { rec, fake } = makeRegisterHarness();
  await withFakePg(fake, MODS, async () => {
    const handle = registerHandler();
    const run = async (body) => { const x = fakeReqRes(body); await handle(x.req, x.res, () => {}); return x.out; };
    await run({ name: '', country_code: 'EG', phone: '01012345678', terms: 'on' });          // required
    await run({ name: 'A', country_code: 'EG', phone: '01012345678' });                       // terms
    await run({ name: 'A', country_code: 'XX', phone: '01012345678', terms: 'on' });          // country
    await run({ name: 'A', country_code: 'EG', phone: '12', terms: 'on' });                   // phone
    await run({ name: 'A', country_code: 'EG', phone: '01012345678', terms: 'on', email: 'nope' }); // email
    await run({ name: 'A', country_code: 'EG', phone: '01012345678', terms: 'on' });          // ok
    for (const step of ['register_submit', 'register_err_required', 'register_err_terms', 'register_err_country',
      'register_err_phone', 'register_err_email', 'register_ok']) {
      assert.ok(rec.funnel.includes(step), step + ' counted; got ' + JSON.stringify(rec.funnel));
    }
    assert.equal(rec.funnel.filter((s) => s === 'register_submit').length, 6, 'one submit per POST');
  });
});

test('POST /register: a taken phone and a failed insert are counted separately', async () => {
  const { rec, fake } = makeRegisterHarness();
  let mode = 'taken';
  const exec = fake.execute;
  fake.execute = async (sql, params) => {
    if (/INSERT INTO users/.test(String(sql))) {
      if (mode === 'taken') { const e = new Error('dup'); e.code = '23505'; e.constraint = 'users_phone_unique_idx'; throw e; }
      throw new Error('connection reset');
    }
    return exec(sql, params);
  };
  await withFakePg(fake, MODS, async () => {
    const handle = registerHandler();
    let x = fakeReqRes({ name: 'A', country_code: 'DE', phone: '015123456789', terms: 'on' });
    await handle(x.req, x.res, () => {});
    assert.equal(x.out.status, 400);
    mode = 'server';
    x = fakeReqRes({ name: 'A', country_code: 'DE', phone: '015123456780', terms: 'on' });
    await handle(x.req, x.res, () => {});
    assert.equal(x.out.status, 500);
    assert.ok(rec.funnel.includes('register_err_phone_taken'));
    assert.ok(rec.funnel.includes('register_err_server'));
  });
});

test('funnel: a prefetch / preload is not a view; the digest shows the register breakdown', async () => {
  const { rec, fake } = makeRegisterHarness();
  await withFakePg(fake, ['services/funnel_digest.js'], async () => {
    const fd = require(SRC('services/funnel_digest'));
    for (const hdr of [{ 'sec-purpose': 'prefetch' }, { purpose: 'prefetch' }, { 'x-purpose': 'preview' }, { 'x-moz': 'prefetch' }]) {
      assert.equal(fd.isPrefetch({ headers: hdr }), true, JSON.stringify(hdr));
      const x = fakeReqRes({}, hdr);
      fd.bumpFunnelCount('register_get', x.req);
    }
    assert.equal(rec.funnel.length, 0, 'no prefetch was counted');
    assert.equal(fd.isPrefetch({ headers: {} }), false);
    const x = fakeReqRes({});
    fd.bumpFunnelCount('register_get', x.req);
    assert.deepEqual(rec.funnel, ['register_get'], 'a real browser GET is counted');

    const txt = fd.formatDigest({ day: '2026-10-25', register_view: 40, register_get: 180, register_submit: 10,
      register_ok: 3, register_err_country: 5, register_err_phone: 2, signups: 3 }, {});
    assert.match(txt, /Register page views: 40 \(server GETs 180\)/);
    assert.match(txt, /Register form sent: 10 \(25%\) · account created 3 \(30%\)/);
    assert.match(txt, /Refused: country 5 · phone invalid 2/);
    const quiet = fd.formatDigest({ day: '2026-10-25', register_view: 4, signups: 0 }, {});
    assert.ok(!/Register form sent/.test(quiet), 'no breakdown line when nobody submitted');
  });
});

// ── 6. phone numbers from anywhere ──────────────────────────────────────────
test('normalizePhone: any country, with its dial code', () => {
  const { normalizePhone } = require(SRC('validators/phone_identity'));
  const cases = [
    ['DE', '01512 3456789', '+4915123456789'],
    ['DE', '+49 0151 23456789', '+4915123456789'],
    ['DE', '0049 1512 3456789', '+4915123456789'],
    ['FR', '06 12 34 56 78', '+33612345678'],
    ['IT', '06 1234 5678', '+390612345678'],      // Italian landline keeps its 0
    ['IT', '333 123 4567', '+393331234567'],
    ['LY', '091 234 5678', '+218912345678'],
    ['JO', '079 123 4567', '+962791234567'],
    ['JP', '090-1234-5678', '+819012345678'],
    ['NG', '0803 123 4567', '+2348031234567'],
    ['EG', '01012345678', '+201012345678'],        // unchanged home behaviour
    ['EG', '001012345678', '+201012345678'],       // a doubled 0 is still read as local
    ['GB', '07400 123456', '+447400123456']
  ];
  for (const [cc, input, want] of cases) {
    const r = normalizePhone(input, cc, 'en');
    assert.ok(r.ok && r.normalized === want, cc + ' ' + input + ' → ' + JSON.stringify(r) + ', want ' + want);
  }
});

test('country data: every country has a dial code; dial codes map back', () => {
  assert.ok(COUNTRIES.length >= 190);
  for (const c of COUNTRIES) {
    assert.match(c.dial, /^\+[1-9]\d{0,3}$/, c.iso);
    assert.ok(c.en && c.ar, c.iso + ' has both names');
  }
  assert.equal(countryForDial('+49'), 'DE');
  assert.equal(countryForDial('+1'), 'US');
  assert.equal(countryForDial('218'), 'LY');
  assert.equal(isValidCountry('jp'), true);
  assert.equal(isValidCountry('XX'), false);
  const lm = require(SRC('launch-market'));
  assert.equal(lm.marketFromDialCode('+962'), 'JO', 'non-market dial codes resolve now');
  assert.equal(lm.signupCountry('Egypt'), 'EG');
  assert.equal(lm.signupCountry('XX'), null);
});

test('signup form offers every country with its dial code and a matching placeholder', () => {
  const ejs = require('ejs');
  const fs = require('fs');
  const file = SRC('views/partials/country_options.ejs');
  const c = require(SRC('lib/countries'));
  const html = ejs.render(fs.readFileSync(file, 'utf8'),
    { _selectedCountry: 'DE', _isAr: false, _withDial: true, COUNTRIES: c.COUNTRIES, POPULAR_COUNTRIES: c.POPULAR }, { filename: file });
  for (const cc of ['DE', 'LY', 'JP', 'EG', 'NG']) assert.ok(html.includes('value="' + cc + '"'), cc + ' offered');
  assert.match(html, /value="DE" data-dial="\+49" data-ph="015X XXXXXXXX" selected/);
  assert.equal((html.match(/selected/g) || []).length, 1, 'one option selected');
  const reg = fs.readFileSync(SRC('views/register.ejs'), 'utf8');
  assert.ok(!/placeholder="01X XXXX XXXX"/.test(reg), 'the register phone placeholder is no longer hard-coded Egyptian');
  assert.match(reg, /data-ph/);
});
