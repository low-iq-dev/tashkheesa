'use strict';

// 25 Oct 2026 — REGISTER-PROVENANCE. On 21 and 24 Oct /register took 69 and 41
// views on days with ZERO services_view and no ads running, and converted at 0%
// against a steady ~1-in-8 on real traffic. funnel_daily_counts holds aggregates
// only, so there was no way to tell a scraper from a customer after the fact.
// bumpRegisterView now also records WHERE the visit came from. These tests pin
// that classification, and pin that it stays aggregate-only — migration 122's
// promise ("no user id, no IP, no user agent") is the thing most easily lost in
// a later edit, so it is asserted here rather than left to code review.
//
// Hermetic: src/pg is replaced in the require cache BEFORE funnel_digest loads,
// because funnel_digest destructures { execute } at import time — stubbing it
// afterwards would not be seen. No DB, no network.
// Run: node --test tests/core/register-view-provenance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ---- stub src/pg before anything pulls it in -------------------------------
// CACHE HYGIENE — tests/run.js require()s every test file into ONE process, so
// require.cache is shared. Leaving src/pg stubbed hands a fake database to
// every file loaded afterwards, which is how this stub turned a handful of
// failures into hundreds. Snapshot, stub, load, then restore exactly.
const pgPath = require.resolve('../../src/pg');
// funnel_digest destructures { execute } at import time, so this stub is the
// only handle on what gets written — reassigning pg.execute later is not seen.
// Every write is kept whole; `bumped` is just the step names from it.
let writes = [];
let bumped = [];

// funnel_digest is usually already loaded (bound to the real pg) by the time
// this file runs inside tests/run.js, so simply installing the stub achieves
// nothing — the cached copy keeps the execute it captured at ITS import. Force
// one private re-evaluation against the stub, then put both entries back.
const fdPath = require.resolve('../../src/services/funnel_digest');
const realFdEntry = require.cache[fdPath];
const realPgEntry = require.cache[pgPath];
delete require.cache[fdPath];
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    queryAll: async () => [],
    queryOne: async () => null,
    execute: async (sql, params) => {
      writes.push({ sql: String(sql), params: params || [] });
      bumped.push(String((params || [])[1] || ''));
      return {};
    },
  },
};

const fd = require('../../src/services/funnel_digest');

// Put both entries back exactly as found. `fd` above keeps the stub it
// captured during its own evaluation; every other file in the suite keeps the
// real pg and the real funnel_digest it already had.
if (realFdEntry) require.cache[fdPath] = realFdEntry; else delete require.cache[fdPath];
if (realPgEntry) require.cache[pgPath] = realPgEntry; else delete require.cache[pgPath];

// A request that looks like a distinct visitor each time, so the in-memory
// per-day dedupe (step|ip|ua) never swallows a case and masks a failure.
let ipSeq = 0;
function makeReq(opts) {
  const o = opts || {};
  const headers = {};
  if (o.referer) headers.referer = o.referer;
  const ua = o.ua || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
  return {
    ip: '203.0.113.' + (++ipSeq),
    query: o.query || {},
    headers: headers,
    get: (h) => headers[String(h).toLowerCase()] || (String(h).toLowerCase() === 'user-agent' ? ua : ''),
  };
}

function run(opts) {
  bumped = [];
  writes = [];
  fd.bumpRegisterView(makeReq(opts));
  return bumped;
}

test('every provenance step is registered in STEPS, or bumpFunnelCount drops it silently', () => {
  // bumpFunnelCount returns early on an unknown step. A counter missing from
  // STEPS would therefore record nothing at all while looking correct at the
  // call site — exactly the kind of silent analytics hole this work exists to
  // close. Proven through behaviour, not by reading the Set.
  for (const step of ['register_view_ref', 'register_view_noref', 'register_view_utm']) {
    bumped = [];
    fd.bumpFunnelCount(step, makeReq({}));
    assert.deepEqual(bumped, [step], step + ' is not in STEPS — it would be silently discarded');
  }
});

test('no referer at all → register_view + register_view_noref (the scraper signature)', () => {
  const steps = run({});
  assert.ok(steps.includes('register_view'), 'the headline count must still be bumped');
  assert.ok(steps.includes('register_view_noref'), 'a direct hit must be counted as no-referer');
  assert.ok(!steps.includes('register_view_ref'), 'a direct hit is not a funnel path');
});

test('referer on our own host → register_view_ref, including a subdomain', () => {
  for (const ref of ['https://tashkheesa.com/ar/services', 'https://www.tashkheesa.com/login?next=%2Fregister']) {
    const steps = run({ referer: ref });
    assert.ok(steps.includes('register_view_ref'), ref + ' should read as the real funnel path');
    assert.ok(!steps.includes('register_view_noref'), ref + ' has a referer and must not count as direct');
  }
});

test('referer from someone ELSE is neither internal nor direct', () => {
  // An inbound link from a forum or a search engine is real traffic, but it is
  // not our funnel path. Crediting it as internal would hide the very drop-off
  // these counters exist to expose, so it deliberately falls through.
  const steps = run({ referer: 'https://www.google.com/' });
  assert.ok(steps.includes('register_view'));
  assert.ok(!steps.includes('register_view_ref'), 'an external referer is not our funnel');
  assert.ok(!steps.includes('register_view_noref'), 'it is not a direct hit either — a referer was sent');
});

test('a look-alike domain does not count as our own host', () => {
  // endsWith('.tashkheesa.com') must not be reachable by a suffix trick.
  for (const ref of ['https://tashkheesa.com.evil.test/x', 'https://nottashkheesa.com/x']) {
    const steps = run({ referer: ref });
    assert.ok(!steps.includes('register_view_ref'), ref + ' must not read as our own host');
  }
});

test('a malformed referer is not credited as a funnel path', () => {
  const steps = run({ referer: 'not a url at all' });
  assert.ok(steps.includes('register_view'), 'the headline count survives a junk header');
  assert.ok(!steps.includes('register_view_ref'), 'unparseable is not evidence of anything');
  assert.ok(!steps.includes('register_view_noref'), 'the header was present, however junk');
});

test('utm_source is counted alongside the referer classification, not instead of it', () => {
  const steps = run({ query: { utm_source: 'meta' }, referer: 'https://tashkheesa.com/ar/services' });
  assert.ok(steps.includes('register_view_utm'));
  assert.ok(steps.includes('register_view_ref'), 'utm must not suppress the referer counter');
  const direct = run({ query: { utm_source: 'meta' } });
  assert.ok(direct.includes('register_view_utm'));
  assert.ok(direct.includes('register_view_noref'), 'a campaign link opened fresh still has no referer');
});

test('an empty or whitespace utm_source is not a campaign visit', () => {
  for (const v of ['', '   ']) {
    const steps = run({ query: { utm_source: v } });
    assert.ok(!steps.includes('register_view_utm'), JSON.stringify(v) + ' must not count as a campaign');
  }
});

test('bots are still skipped, so the provenance split cannot be inflated by crawlers', () => {
  const steps = run({ ua: 'facebookexternalhit/1.1', referer: 'https://tashkheesa.com/ar/services' });
  assert.deepEqual(steps, [], 'a known crawler must record nothing at all');
});

test('a thrown request never reaches the caller — analytics must not break /register', () => {
  const hostile = { get() { throw new Error('header access exploded'); }, query: {}, ip: '203.0.113.254' };
  assert.doesNotThrow(() => fd.bumpRegisterView(hostile));
});

test('the route calls bumpRegisterView, not the bare counter', () => {
  // The whole change is worthless if the call site still bumps register_view
  // directly, and that regression is invisible at runtime: the digest total
  // stays correct while the split silently stays empty.
  const auth = fs.readFileSync(path.join(ROOT, 'src/routes/auth.js'), 'utf8');
  assert.match(auth, /bumpRegisterView\(req\)/, 'GET /register must call bumpRegisterView');
  assert.ok(
    !/bumpFunnelCount\(\s*['"]register_view['"]/.test(auth),
    'the route must not bump register_view directly any more'
  );
});

test('provenance stores counters only — no IP, user agent or user id reaches the database', () => {
  // Migration 122 chose aggregates deliberately. Assert the shape of what is
  // actually written: step names and nothing else resembling a fingerprint.
  run({ referer: 'https://tashkheesa.com/ar/services', query: { utm_source: 'meta' } });

  assert.ok(writes.length >= 3, 'expected the headline plus two provenance counters');
  for (const w of writes) {
    assert.match(w.sql, /funnel_daily_counts/, 'provenance must not write to any other table');
    assert.equal(w.params.length, 2, 'only (day, step) may be bound — anything more is a new field');
    assert.match(String(w.params[0]), /^\d{4}-\d{2}-\d{2}$/, 'first bind is the Cairo day');
    assert.match(String(w.params[1]), /^register_view(_ref|_noref|_utm)?$/, 'second bind is a step name');
    for (const p of w.params) {
      assert.ok(!/203\.0\.113\./.test(String(p)), 'an IP address reached the database');
      assert.ok(!/Mozilla|AppleWebKit|iPhone/i.test(String(p)), 'a user agent reached the database');
    }
  }
});
