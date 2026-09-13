// tests/lint/no-success-redirect-after-catch.test.js
//
// A8 / Part B item 3 (2026-09-13) — the silent-failure family.
//
// Three times this codebase shipped a handler that caught a failed write and
// then redirected with a SUCCESS code, so the operator (or doctor, or patient)
// was told it worked: additional-files approve, refund mark-paid, operator
// mark-paid (A8, fixed in 0c09263); the manual SLA sweep, turnaround-save and
// reject-files (Part B item 3). Each was found by reading, not by a test.
//
// This lint makes the class un-shippable. In src/routes and src/services it
// fails the build on two shapes:
//   (1) a `res.redirect(...)` INSIDE a `catch` block whose target carries a
//       success marker (success=, approved=1, payment=paid, flash=<ok>,
//       sla_ran=1, uploaded=1, saved=1);
//   (2) a `catch` block that SWALLOWS (no return/throw inside it) followed
//       within 4 lines by a success redirect with no other `await` between
//       them — the "try { write } catch (_) {} return res.redirect(
//       '?flash=created')" shape. (An await in between means the redirect
//       reports THAT later write, which throws into the outer catch.)
//       Promise `.catch(fn)` is not a catch block.
// A redirect that carries an error / warning code alongside is fine — that is
// the fix.
//
// Allowlist: a comment containing `silent-failure-ok:` within 3 lines ABOVE
// the redirect exempts it (same shape as `include-deleted-ok`). Use it only
// for a redirect inside a catch that genuinely reports success — e.g. the
// primary write already committed and the catch wraps a best-effort follow-up
// whose failure is logged loudly AND surfaced by another code on the same
// redirect. Say why in the comment.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔇 lint — no success redirect inside a catch block\n');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['src/routes', 'src/services'];

const SUCCESS_MARKERS = /(\?|&)(success=|approved=1|payment=paid(?![_a-z])|flash=(created|approved|denied|paid|superseded|saved|ok)|sla_ran=1|uploaded=1|saved=1|ok=1)/;
const ERROR_MARKERS = /(\?|&)(error=|err=|warn=|warning=|flash=[a-z_]*(fail|error)|[a-z_]+_failed|[a-z_]+=[a-z_]*fail)/;

function listJs(dir, out) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) listJs(rel, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// Walk the file; when a `catch` opens a block, track brace depth until it
// closes, and inspect every `res.redirect(` inside it. Braces inside strings
// and comments are not tracked — the routes here are formatted conventionally
// enough that this has no false catch-boundaries today (the fixtures below
// pin that assumption on the sites this lint exists for).
function scan(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = src.split('\n');
  const hits = [];
  let depth = 0;          // brace depth relative to the catch block's opening brace
  let inCatch = false;
  let catchExits = false; // did the current catch block return / throw?
  let swallowedAt = -1;   // line index where a swallowing catch closed
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    if (!inCatch) {
      // Rule (2): a success redirect shortly after a swallowing catch closed.
      if (swallowedAt >= 0 && /\bawait\b/.test(line) && !/res\.redirect\(/.test(line)) swallowedAt = -1;
      if (swallowedAt >= 0 && i - swallowedAt <= 4 && /res\.redirect\(/.test(line)) {
        let stmt = line; let j = i;
        while (!/\);\s*$/.test(stmt) && j < i + 8 && j + 1 < lines.length) { j++; stmt += '\n' + lines[j]; }
        if (SUCCESS_MARKERS.test(stmt) && !ERROR_MARKERS.test(stmt)) {
          const above = lines.slice(Math.max(0, i - 3), i).join('\n');
          if (!/silent-failure-ok:/.test(above)) hits.push(rel + ':' + (i + 1) + '  (after swallowing catch) ' + trimmed.slice(0, 90));
        }
      }
      if (swallowedAt >= 0 && i - swallowedAt > 4) swallowedAt = -1;
      if (/(?<!\.)\bcatch\s*(\([^)]*\))?\s*\{/.test(line)) {
        inCatch = true;
        catchExits = false;
        // count braces AFTER the catch keyword on this line
        const after = line.slice(line.search(/(?<!\.)\bcatch\b/));
        depth = (after.match(/\{/g) || []).length - (after.match(/\}/g) || []).length;
        if (depth <= 0) {
          // A one-line catch: `} catch (_) { /* best-effort */ }`. It swallows
          // unless it returns or throws on that same line.
          inCatch = false;
          swallowedAt = /\b(return|throw)\b/.test(after) ? -1 : i;
          continue;
        }
        continue;
      }
      continue;
    }
    // inside a catch block
    if (/^\s*(return|throw)\b/.test(line) || /\bthrow\b/.test(line)) catchExits = true;
    if (/res\.redirect\(/.test(line)) {
      // gather the redirect statement (may span lines) up to the closing ');'
      let stmt = line;
      let j = i;
      while (!/\);\s*$/.test(stmt) && j < i + 8 && j + 1 < lines.length) { j++; stmt += '\n' + lines[j]; }
      if (SUCCESS_MARKERS.test(stmt) && !ERROR_MARKERS.test(stmt)) {
        const above = lines.slice(Math.max(0, i - 3), i).join('\n');
        if (!/silent-failure-ok:/.test(above)) {
          hits.push(rel + ':' + (i + 1) + '  ' + trimmed.slice(0, 110));
        }
      }
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth <= 0) { inCatch = false; swallowedAt = catchExits ? -1 : i; }
  }
  return hits;
}

const files = DIRS.reduce((acc, d) => listJs(d, acc), []);
const all = files.reduce((acc, f) => acc.concat(scan(f)), []);

if (all.length) {
  t.fail('no `catch` block redirects with a success code (' + all.length + ' hit(s))',
    new Error('\n    ' + all.join('\n    ') +
      '\n  Each of these tells the user it worked after the write failed. Carry an error/warning code the page renders, or add a `silent-failure-ok: <why>` comment within 3 lines above.'));
} else {
  t.pass('no `catch` block in src/routes or src/services redirects with a success code (' + files.length + ' files scanned)');
}

// Self-test on fixtures, so a regex edit cannot silently blind the lint.
const FIX = path.join(ROOT, 'tests', '_helpers');
function fixture(text) {
  const p = path.join(FIX, '.lint-fixture-' + process.pid + '.js');
  fs.writeFileSync(p, text);
  try { return scan(path.relative(ROOT, p)); } finally { fs.unlinkSync(p); }
}
(function selfTest() {
  const bad = fixture("router.post('/x', async (req, res) => {\n  try {\n    await save();\n  } catch (err) {\n    logErrorToDb(err, {});\n    return res.redirect('/x?success=' + encodeURIComponent('saved'));\n  }\n});\n");
  const good = fixture("router.post('/x', async (req, res) => {\n  try {\n    await save();\n  } catch (err) {\n    logErrorToDb(err, {});\n    return res.redirect('/x?error=save_failed');\n  }\n  return res.redirect('/x?success=1');\n});\n");
  const allow = fixture("router.post('/x', async (req, res) => {\n  try {\n    await followUp();\n  } catch (err) {\n    // silent-failure-ok: primary write committed above; follow-up failure is logged\n    return res.redirect('/x?flash=created&warn=notify_failed');\n  }\n});\n");
  if (bad.length !== 1) t.fail('lint self-test: flags a success redirect inside a catch', new Error('got ' + bad.length + ' hits'));
  else t.pass('lint self-test: flags a success redirect inside a catch');
  if (good.length !== 0) t.fail('lint self-test: ignores an error redirect in a catch and a success redirect outside it', new Error('got ' + good.length + ' hits'));
  else t.pass('lint self-test: ignores an error redirect in a catch and a success redirect outside it');
  if (allow.length !== 0) t.fail('lint self-test: honours silent-failure-ok / an accompanying warn code', new Error('got ' + allow.length));
  else t.pass('lint self-test: honours silent-failure-ok / an accompanying warn code');
  const swallow = fixture("router.post('/x', async (req, res) => {\n  try {\n    await notify();\n  } catch (_) { /* best-effort */ }\n\n  return res.redirect('/x?flash=created');\n});\n");
  const swallowOk = fixture("router.post('/x', async (req, res) => {\n  let failed = false;\n  try {\n    await notify();\n  } catch (_) { failed = true; }\n\n  return res.redirect('/x?flash=created' + (failed ? '&warn=notify_failed' : ''));\n});\n");
  if (swallow.length !== 1) t.fail('lint self-test: flags a swallowing catch followed by a success redirect', new Error('got ' + swallow.length));
  else t.pass('lint self-test: flags a swallowing catch followed by a success redirect');
  if (swallowOk.length !== 0) t.fail('lint self-test: accepts a swallowing catch whose redirect carries a warn code', new Error('got ' + swallowOk.length));
  else t.pass('lint self-test: accepts a swallowing catch whose redirect carries a warn code');
})();
