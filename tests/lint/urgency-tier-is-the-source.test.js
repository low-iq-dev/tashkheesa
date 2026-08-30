'use strict';
// Guard: urgency_tier decides a case's urgency. orders.tier does not.
//
// WHY THIS FILE EXISTS
//
// orders.tier (migration 010) and orders.urgency_tier (migration 016) both hold
// the same idea. tier has a DEFAULT of 'standard' and is only ever written back
// by notify/broadcast.js, so an order that has not yet been broadcast reads
// 'standard' no matter what the patient paid for — which was true of all 39
// orders in production on 2026-08-30, two of them urgent or VIP.
//
// Both live readers already prefer urgency_tier; migration 105 makes the stored
// values agree. This stops a NEW reader picking the wrong one, which is easy to
// do because `tier` is the more obvious name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Reading `tier` is fine in these; each was checked on 2026-08-30.
const ALLOWED = new Set([
  'src/notify/broadcast.js',            // derives from urgency_tier, writes tier back
  'src/services/superadmin_dashboard.js', // selects COALESCE(o.urgency_tier,...) AS tier
  'src/workers/acceptance_watcher.js',  // reads urgency_tier first; tier only as fallback
  'src/acceptance_window.js'            // reads urgency_tier first; tier only as fallback
]);

test('no new code reads orders.tier to decide urgency', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
      // `o.tier`, `order.tier`, `orders.tier` — but never `*_tier`.
      const re = /(^|[^_\w])(o|order|orders|row)\.tier\b/g;
      let m;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        hits.push(rel + ':' + line);
      }
    }
  };
  walk('src');
  assert.deepStrictEqual(hits, [],
    'These read orders.tier. urgency_tier is the source of truth for what the\n' +
    'patient paid for; orders.tier defaults to "standard" and is only written\n' +
    'once a case has been broadcast, so it reads "standard" for an urgent case\n' +
    'that has not been broadcast yet. Read urgency_tier, or add the file to\n' +
    'ALLOWED here with a note saying why it is safe:\n  ' + hits.join('\n  '));
});

test('the acceptance window prefers urgency_tier over tier', () => {
  // The exact precedence, asserted as source text, because the failure it
  // guards is silent: orders.tier defaults to 'standard' — TRUTHY — so
  // `order.tier || order.urgency_tier` never falls through, and an urgent case
  // that has not been broadcast yet is handed the standard window. There is no
  // error, no log line, and no visible symptom until a doctor does not get
  // paged in time.
  for (const rel of ['src/acceptance_window.js', 'src/workers/acceptance_watcher.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
    assert.doesNotMatch(src, /order\.tier\s*\|\|\s*order\.urgency_tier/,
      rel + ' reads `order.tier || order.urgency_tier`. orders.tier defaults to ' +
      "'standard', which is truthy, so urgency_tier is never reached and every " +
      'not-yet-broadcast urgent case gets the standard acceptance window. ' +
      'Read `order.urgency_tier || order.tier`.');
    assert.match(src, /order\.urgency_tier\s*\|\|\s*order\.tier/,
      rel + ' must resolve the tier as `order.urgency_tier || order.tier` — the ' +
      'creation-time column first, the broadcast-written one only as a fallback.');
  }
});
