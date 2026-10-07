// tests/core/meta-pixel-production-only.test.js
//
// 7 Oct 2026 — the Meta Pixel fires on tashkheesa.com and nowhere else.
//
// public/js/meta_pixel.js used to run on any host that served it: every local
// preview, every screenshot run, the *.onrender.com address and any staging
// deploy loaded fbevents.js and sent a real PageView to the live pixel
// (857477276921931) — noise in the ads data that looks like traffic.
//
// The guard is a hostname check in the browser, so this runs the real file in
// a sandbox with a stub document and asserts what it does per host:
//   * production (and www, which 301s to it) → fbevents.js is injected, the
//     pixel is initialised and PageView is tracked, exactly as before
//   * everything else → nothing is injected and window.fbq is never created
// The lookalike hosts are the point of the EXACT match: a suffix or substring
// test would pass for them.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n📡 Meta Pixel — production hostname only\n');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'meta_pixel.js'), 'utf8');

// Run meta_pixel.js as a browser would on `hostname`, and report what it did.
function run(hostname, opts) {
  opts = opts || {};
  const injected = [];
  const firstScript = { parentNode: { insertBefore: (el) => { injected.push(el.src); } } };
  const document = {
    body: opts.noBody ? null : { getAttribute: (n) => (n === 'data-meta-pixel' ? (opts.flag === undefined ? '1' : opts.flag) : null) },
    createElement: () => ({}),
    getElementsByTagName: () => [firstScript]
  };
  const window = { document, location: { hostname } };
  window.window = window;
  const sandbox = vm.createContext(window);
  vm.runInContext(SOURCE, sandbox, { filename: 'meta_pixel.js' });
  // Array.from in THIS realm: the sandbox's arrays have another realm's prototype, which deepStrictEqual rejects.
  const queue = (window.fbq && window.fbq.queue) ? Array.from(window.fbq.queue, (a) => Array.from(a)) : null;
  return { injected, hasFbq: typeof window.fbq === 'function', queue };
}

const PRODUCTION = ['tashkheesa.com', 'www.tashkheesa.com', 'TASHKHEESA.COM'];
const ELSEWHERE = [
  'localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'app.localhost', 'tashkheesa.test',
  'tashkheesa.onrender.com', 'tashkheesa-portal-pr-12.onrender.com', 'staging.tashkheesa.com',
  // Lookalikes: these end with, start with or contain the production name.
  'eviltashkheesa.com', 'nottashkheesa.com', 'tashkheesa.com.example.org', 'tashkheesa.com.', 'tashkheesa.co', ''
];

try {
  for (const host of PRODUCTION) {
    const r = run(host);
    assert.deepStrictEqual(r.injected, ['https://connect.facebook.net/en_US/fbevents.js'], host + ' must load fbevents.js once');
    assert.ok(r.hasFbq, host + ': fbq is not defined');
    assert.deepStrictEqual(r.queue, [['init', '857477276921931'], ['track', 'PageView']], host + ': init + PageView');
  }
  t.pass('production: fbevents.js is loaded and PageView is tracked (' + PRODUCTION.join(', ') + ')');
} catch (e) { t.fail('production: fbevents.js is loaded and PageView is tracked', e); }

try {
  for (const host of ELSEWHERE) {
    const r = run(host);
    assert.deepStrictEqual(r.injected, [], JSON.stringify(host) + ' loaded ' + r.injected.join(', '));
    assert.strictEqual(r.hasFbq, false, JSON.stringify(host) + ' created window.fbq');
  }
  t.pass('everywhere else: nothing is loaded and fbq is never created (' + ELSEWHERE.length + ' hosts, lookalikes included)');
} catch (e) { t.fail('everywhere else: nothing is loaded and fbq is never created', e); }

try {
  // The existing opt-in still applies on production: a page without the body flag does not fire.
  assert.deepStrictEqual(run('tashkheesa.com', { flag: '0' }).injected, []);
  assert.deepStrictEqual(run('tashkheesa.com', { flag: null }).injected, []);
  assert.deepStrictEqual(run('tashkheesa.com', { noBody: true }).injected, []);
  t.pass('production pages without data-meta-pixel="1" still do not fire');
} catch (e) { t.fail('production pages without data-meta-pixel="1" still do not fire', e); }

try {
  // Exact comparison, written as such — not endsWith / includes / a regex someone can loosen.
  assert.ok(/host !== 'tashkheesa\.com' && host !== 'www\.tashkheesa\.com'/.test(SOURCE), 'the guard must compare the hostname exactly');
  assert.ok(!/endsWith\(|includes\(|indexOf\(|\.match\(|\.test\(/.test(SOURCE), 'no suffix, substring or pattern matching on the hostname');
  // Both pages that load the pixel still do, unchanged: the guard lives in the script, not in the views.
  for (const rel of ['src/views/index.ejs', 'src/views/layouts/public.ejs']) {
    const view = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/data-meta-pixel="1"/.test(view) && /<script src="\/js\/meta_pixel\.js" defer><\/script>/.test(view), rel + ' lost its pixel wiring');
  }
  t.pass('the guard is an exact hostname comparison; the views\' pixel wiring is unchanged');
} catch (e) { t.fail('the guard is an exact hostname comparison; the views\' pixel wiring is unchanged', e); }
