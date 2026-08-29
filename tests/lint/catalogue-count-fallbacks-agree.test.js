'use strict';
// Guard: the public catalogue numbers have ONE fallback, not five.
//
// WHY THIS FILE EXISTS
//
// 2026-08-29, visual/copy audit. Four public pages print "<N> specialties and
// <M> services available" via `typeof serviceCount !== 'undefined' ? ... : 140`.
// The live values come from services/site_stats.js; the literals after the `:`
// are what a visitor sees if the DB blips mid-request.
//
// Those literals were 19 and 140. Production had 6 visible specialties (22 were
// hidden by migrations 060/066 and the pediatrics work) and 55 bookable
// services. So the failure mode was not "the page errors" — it was "the page
// calmly advertises three times the specialties and 2.6x the catalogue we can
// actually sell", in marketing copy, under our own name.
//
// Nothing caught it because each literal is individually valid JavaScript and
// the happy path never reads it. The only thing that can catch it is a check
// that the numbers AGREE — so that updating site_stats.js and forgetting the
// views is a test failure rather than a silent lie.
//
// This does not assert the numbers are *correct* (only production knows that).
// It asserts they cannot DIVERGE, which is the bug that actually happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The single source: the third argument to _cachedCount() in each getter.
function sourceOfTruth() {
  const src = read('src/services/site_stats.js');
  const grab = (fnName) => {
    const at = src.indexOf('async function ' + fnName + '(');
    assert.notStrictEqual(at, -1, fnName + ' is gone from site_stats.js — update this test');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    // `_cachedCount(key, sql, fallback)` — fallback is the last bare integer
    // before the closing paren, and comments are stripped so a number inside
    // one (there are several) cannot be mistaken for it.
    const code = body.replace(/\/\/[^\n]*/g, '');
    const m = code.match(/,\s*(\d+)\s*\)\s*;/);
    assert.ok(m, 'could not find the fallback literal in ' + fnName);
    return Number(m[1]);
  };
  return { specialties: grab('getVisibleSpecialtyCount'), services: grab('getVisibleServiceCount') };
}

// Every view that prints one of these numbers with its own inline fallback.
const VIEWS = [
  'src/views/blog_how_tashkheesa_works.ejs',
  'src/views/blog_when_to_get_second_opinion.ejs',
  'src/views/index.ejs',
  'src/views/terms.ejs'
];

const SPEC_RE = /specialtyCount\s*!==\s*'undefined'\s*\?\s*specialtyCount\s*:\s*(\d+)/g;
const SVC_RE  = /serviceCount\s*!==\s*'undefined'\s*\?\s*serviceCount\s*:\s*(\d+)/g;

test('view fallbacks match site_stats.js', () => {
  const truth = sourceOfTruth();
  let found = 0;
  for (const rel of VIEWS) {
    const src = read(rel);
    for (const [re, key] of [[SPEC_RE, 'specialties'], [SVC_RE, 'services']]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        found++;
        assert.strictEqual(Number(m[1]), truth[key],
          rel + ' falls back to ' + m[1] + ' for the ' + key + ' count, but ' +
          'site_stats.js falls back to ' + truth[key] + '. These are printed to ' +
          'the public as a factual claim — change both, or neither.');
      }
    }
  }
  assert.ok(found >= 4, 'expected to find the inline fallbacks; found ' + found +
    ' — if the views stopped using them, shorten VIEWS in this file');
});

test('no view hardcodes a catalogue count in prose', () => {
  // The numbers must arrive as a variable. A bare "146 services" in a template
  // is the original defect this whole audit started from.
  const BARE = /\b\d{1,3}\s+(specialt(y|ies)|services)\b/i;
  for (const rel of VIEWS.concat(['src/views/services.ejs', 'src/views/faq.ejs'])) {
    for (const line of read(rel).split('\n')) {
      // A line that interpolates is fine — that IS the variable being printed.
      if (/<%[-=]/.test(line)) continue;
      assert.ok(!BARE.test(line),
        rel + ' hardcodes a catalogue count: ' + line.trim().slice(0, 120));
    }
  }
});
