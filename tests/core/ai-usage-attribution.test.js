// tests/core/ai-usage-attribution.test.js
//
// Guards the AI-credits ledger — the answer to "where are my API credits going".
//
// THE FAILURE THIS EXISTS TO PREVENT is not a crash. `agent_token_log` sat in
// production for a year with a reader, a writer nobody called, and ZERO rows,
// because none of the real Anthropic call sites logged anything. Nothing was
// broken; the feature simply was not wired. A test that only exercised
// recordAiUsage() in isolation would have passed the entire time.
//
// So the load-bearing assertion here is the WIRING one: every place in src/
// that calls Anthropic must also record the usage. If someone adds a new call
// site and forgets, this fails and names the file.
//
// The rest guards the three ways the numbers can be quietly wrong:
//   * cached prefix tokens dropped → the two most expensive call sites
//     under-report by most of their cost
//   * an unknown model priced at zero → a rotation makes spend vanish
//   * a purpose with no calls omitted → "the wizard cost nothing" becomes
//     indistinguishable from "the wizard is missing from the report"

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n💳 AI credit attribution — every Anthropic call is on the ledger\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const usage = require('../../src/services/ai_usage');

function check(name, fn) {
  try { fn(); t.pass(fileTag + ': ' + name); }
  catch (e) { t.fail(fileTag + ': ' + name, e); }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push.apply(out, walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// ── 1. WIRING: every Anthropic call site records its usage ──────────────────
//
// Scans STRIPPED source, so the prose above and the comments at each call site
// explaining the accounting are not themselves mistaken for the call. That trap
// has caught three tests in this repo already — see tests/_helpers.
check('every file that calls Anthropic also calls recordAiUsage()', function () {
  // `messages.create(` also matches the Twilio SMS client in notify/, which is
  // a different `messages` entirely. Anchor on the Anthropic host or on a file
  // that pulls a model id from the central config — both are true of every real
  // Anthropic call site and neither is true of Twilio.
  const missing = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join('src', 'services', 'ai_usage.js')) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));

    const hitsAnthropicHost = code.indexOf('api.anthropic.com') !== -1;
    const usesModelHelper = /model(Sonnet|Haiku|Vision)\s*\(/.test(code);
    const createsMessages = /messages\.create\s*\(/.test(code);
    const callsAnthropic = hitsAnthropicHost || (usesModelHelper && createsMessages);
    if (!callsAnthropic) continue;

    // The trailing paren is load-bearing. `const { recordAiUsage } = require(…)`
    // contains the name but calls nothing, and an import-without-a-call is
    // exactly what a half-finished wiring change looks like — it must fail.
    if (!/recordAiUsage\s*\(/.test(code)) missing.push(rel);
  }
  if (missing.length) {
    throw new Error(
      'These files call Anthropic but never record the spend:\n  ' + missing.join('\n  ') +
      "\n\nFix: require recordAiUsage from services/ai_usage and call it with the response's " +
      '`usage` block right after the call. Without it the credits for this feature are ' +
      'invisible, which is the exact state agent_token_log was in for a year.'
    );
  }
});

// A floor, so the scan above cannot pass by finding nothing. If the detection
// regexes ever regress, "0 files call Anthropic, 0 are missing" would be green.
check('the Anthropic call-site scan actually finds call sites', function () {
  let found = 0;
  for (const file of walk(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (code.indexOf('api.anthropic.com') !== -1) { found++; continue; }
    if (/model(Sonnet|Haiku|Vision)\s*\(/.test(code) && /messages\.create\s*\(/.test(code)) found++;
  }
  if (found < 6) {
    throw new Error('Detected only ' + found + ' Anthropic call site(s); expected at least 6. ' +
      'The detection in this test has probably regressed, which would make the wiring ' +
      'assertion above pass vacuously.');
  }
});

// ── 2. Cached prefix tokens are priced, not dropped ─────────────────────────
check('cache read/write tokens are counted, not silently free', function () {
  const uncached = usage.estimateCostUsd('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 0 });
  const cachedRead = usage.estimateCostUsd('claude-sonnet-4-6', {
    input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 100000,
  });
  if (!(cachedRead > uncached)) {
    throw new Error(
      '100k cached-read tokens added nothing to the estimate. Case intelligence and the ' +
      'support assistant both send a large cache_control prefix, so `input_tokens` on those ' +
      'calls is only the uncached remainder — ignoring the cache fields under-reports the ' +
      'platform\'s two most expensive features by most of their cost.'
    );
  }
  const cachedWrite = usage.estimateCostUsd('claude-sonnet-4-6', {
    input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 100000,
  });
  if (!(cachedWrite > cachedRead)) {
    throw new Error('A cache WRITE must cost more than a cache READ (1.25x vs 0.1x of input rate).');
  }
});

// ── 3. An unpriced model is expensive, never free ───────────────────────────
check('an unknown model prices at the expensive rate, not zero', function () {
  const unknown = usage.estimateCostUsd('some-model-nobody-listed', { input_tokens: 1000000, output_tokens: 0 });
  if (unknown <= 0) {
    throw new Error(
      'An unrecognised model estimated at ' + unknown + '. It must fall back to the expensive ' +
      'rate: a model rotation would otherwise make an entire feature\'s spend vanish from the ' +
      'report on exactly the day the numbers matter most.'
    );
  }
  const sonnet = usage.estimateCostUsd('claude-sonnet-4-6', { input_tokens: 1000000, output_tokens: 0 });
  if (unknown < sonnet) throw new Error('Unknown model priced BELOW Sonnet — the fallback is meant to be the ceiling.');
});

check('a haiku-family id still prices as haiku after a rotation', function () {
  const rotated = usage.estimateCostUsd('claude-haiku-99-9', { input_tokens: 1000000, output_tokens: 0 });
  const sonnet = usage.estimateCostUsd('claude-sonnet-4-6', { input_tokens: 1000000, output_tokens: 0 });
  if (!(rotated < sonnet)) {
    throw new Error('A future haiku id priced as Sonnet. The family fallback in priceFor() has regressed, ' +
      'which would overstate the cheapest and busiest call site on the platform.');
  }
});

// ── 4. Missing usage is a zero-token row, never a throw ─────────────────────
check('a response with no usage block does not throw', function () {
  const v = usage.estimateCostUsd('claude-haiku-4-5', undefined);
  if (v !== 0) throw new Error('Expected 0 for an absent usage block, got ' + v);
});

// ── 5. recordAiUsage is non-throwing by contract ────────────────────────────
//
// It is called from inside the classifier, the image check and the assistant.
// Accounting must never be the reason a patient's case fails to route, so a
// dead database has to be swallowed here rather than surface as a 500.
check('recordAiUsage swallows a database failure', function () {
  const src = fs.readFileSync(path.join(SRC, 'services', 'ai_usage.js'), 'utf8');
  const body = src.slice(src.indexOf('async function recordAiUsage'));
  if (!/try\s*\{/.test(body) || !/catch/.test(body)) {
    throw new Error('recordAiUsage no longer wraps its INSERT in try/catch. It is called from the ' +
      'classifier and the assistant — an accounting failure must never fail a patient request.');
  }
});

// ── 6. The INSERT matches the migration ─────────────────────────────────────
//
// Cheaper than a database round trip and catches the real failure: a column
// added to the INSERT without a migration means every write silently lands in
// the catch above and the ledger stays empty — the original bug, restored.
check('every column recordAiUsage writes exists in a migration', function () {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'services', 'ai_usage.js'), 'utf8'));
  const m = src.match(/INSERT INTO agent_token_log\s*\(([^)]*)\)/);
  if (!m) throw new Error('Could not find the agent_token_log INSERT — this test needs updating.');
  const columns = m[1].split(',').map(function (c) { return c.trim(); }).filter(Boolean);

  const migrationsDir = path.join(SRC, 'migrations');
  const schema = fs.readdirSync(migrationsDir)
    .filter(function (f) { return f.endsWith('.sql'); })
    .map(function (f) { return fs.readFileSync(path.join(migrationsDir, f), 'utf8'); })
    .join('\n')
    .toLowerCase();

  const absent = columns.filter(function (c) {
    return schema.indexOf(c.toLowerCase()) === -1;
  });
  if (absent.length) {
    throw new Error(
      'recordAiUsage writes column(s) no migration creates: ' + absent.join(', ') +
      '. Every INSERT would fail, be swallowed by the non-throwing contract, and the ' +
      'credits screen would show zeros forever with nothing in the logs.'
    );
  }
  if (columns.indexOf('purpose') === -1) {
    throw new Error('The INSERT no longer writes `purpose` — the whole point of the table is the split.');
  }
});

// ── 7. The endpoint is mounted where the app looks for it ───────────────────
check('GET /ai-usage is served from the superadmin-gated admin router', function () {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'api', 'admin.js'), 'utf8'));
  const routeAt = src.indexOf("router.get('/ai-usage'");
  if (routeAt === -1) throw new Error("routes/api/admin.js no longer defines GET '/ai-usage'.");
  const gateAt = src.indexOf("router.use(requireRole('superadmin'))");
  if (gateAt === -1) throw new Error('The superadmin gate is gone from routes/api/admin.js.');
  if (routeAt < gateAt) {
    throw new Error(
      "GET /ai-usage is declared BEFORE requireRole('superadmin'), so it would answer without " +
      'the gate. Spend data is founder-only.'
    );
  }
});

// ── 8. Every purpose the writers use is a purpose the reader reports ────────
//
// A typo'd purpose at a call site is silently coerced to 'other' by design, so
// it can never be caught at runtime — the spend just quietly stops being
// attributed. This catches it at build time instead.
check('every purpose passed at a call site is in the PURPOSES vocabulary', function () {
  const known = Object.keys(usage.PURPOSES);
  const bad = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join('src', 'services', 'ai_usage.js')) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /purpose:\s*'([a-z_]+)'/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      if (known.indexOf(m[1]) === -1) bad.push(rel + " → '" + m[1] + "'");
    }
  }
  if (bad.length) {
    throw new Error(
      'Call site(s) record a purpose the reader does not know:\n  ' + bad.join('\n  ') +
      '\n\nIt would be filed under "other" and the feature would never appear on the credits ' +
      'screen. Add it to PURPOSES in services/ai_usage.js, or fix the typo.'
    );
  }
});

// ── 9. Zero-call purposes are still reported ────────────────────────────────
check('usageByPurpose returns a row for every purpose, including empty ones', function () {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'services', 'ai_usage.js'), 'utf8'));
  const body = src.slice(src.indexOf('async function usageByPurpose'));
  if (body.indexOf('Object.keys(PURPOSES)') === -1) {
    throw new Error(
      'usageByPurpose no longer maps over the full PURPOSES list. Dropping empty purposes makes ' +
      '"the order wizard cost nothing this month" indistinguishable from "the order wizard is ' +
      'missing from this report" — one is a quiet month, the other is a broken classifier.'
    );
  }
});
