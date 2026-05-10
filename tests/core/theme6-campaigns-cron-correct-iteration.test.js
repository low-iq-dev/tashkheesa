// tests/core/theme6-campaigns-cron-correct-iteration.test.js
//
// Theme 6 sub-issue C regression guard.
//
// The campaign cron at src/server.js was carrying THREE bugs that
// only manifested at fire time:
//
//   1. `var ci` hoisting — every `setImmediate(() => processCampaign(scheduled[ci].id))`
//      captured the SAME loop binding. By the time the setImmediate
//      fired, `ci === scheduled.length`, so `scheduled[ci]` was
//      `undefined` and `processCampaign(undefined)` silently returned
//      at routes/campaigns.js:309 (queryOne by id=undefined → null).
//      Net effect: every approved campaign was UPDATEd to 'sending'
//      and stayed there forever, no recipients ever emailed.
//
//   2. UPDATE rowCount not checked (P3-WORKER-N1) — even after fixing
//      the hoisting bug, the
//      `UPDATE email_campaigns SET status='sending' WHERE id=$1
//       AND status='scheduled'`
//      is a write-once race. If a second instance ever runs the cron,
//      only one wins the UPDATE; without the rowCount guard, BOTH
//      instances still call processCampaign and double-send. Fix:
//      `if (result.rowCount > 0) setImmediate(...)`.
//
//   3. `try { processCampaign(...) } catch (_) {}` — sibling of the
//      Sub-issue B pattern. processCampaign is async; the sync try
//      can't catch async rejections. Fix: `processCampaign(...).catch(...)`.
//
// All three are fixed under Theme 6 Phase 3 (Sub-issue C). This test
// asserts the fixed shape so a future regression is caught at lint time.
//
// Source-grep style — matches Theme 1/5/6/7 lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📨 Theme 6 sub-C — campaigns cron iterates correctly + checks rowCount\n');

const SERVER = path.join(__dirname, '..', '..', 'src', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

// Slice the campaign cron block: from `// Campaign cron` comment to the
// matching `} catch (campaignCronErr) {` close. Anchored on text we
// own and don't expect to drift.
function sliceCampaignCron(text) {
  const start = text.indexOf("// Campaign cron");
  if (start < 0) return null;
  const end = text.indexOf("} catch (campaignCronErr) {", start);
  if (end < 0) return null;
  return text.slice(start, end);
}

// Strip line + block comments before running shape regexes. The
// audit-narrative comments inside the cron block legitimately contain
// substrings like `try { processCampaign(` (quoting the OLD shape we
// just removed); we don't want those to trigger false positives.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')      // /* block comments */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // // line comments (not URLs)
}

const cronRaw = sliceCampaignCron(src);
const cron = cronRaw ? stripComments(cronRaw) : null;
if (!cron) {
  t.fail('locate campaign cron block', new Error("could not slice from `// Campaign cron` to `} catch (campaignCronErr) {` in src/server.js"));
} else {

  // ── 1. var ci → let ci ────────────────────────────────────────
  try {
    if (/for\s*\(\s*var\s+ci\b/.test(cron)) {
      throw new Error('campaign cron still uses `for (var ci ...)` — hoisting bug not fixed');
    }
    if (!/for\s*\(\s*let\s+ci\b/.test(cron)) {
      throw new Error('campaign cron does not use `for (let ci ...)` — block-scoping not in place');
    }
    t.pass('campaign cron uses `for (let ci ...)` — closure captures per-iteration binding');
  } catch (e) { t.fail('var ci → let ci', e); }

  // ── 2. id is hoisted into a const inside the loop ─────────────
  // (The fix uses `const campaignId = scheduled[ci].id;` — this makes
  // the closure intent explicit and survives even if a future refactor
  // reverts let → var by accident.)
  try {
    if (!/const\s+campaignId\s*=\s*scheduled\[\s*ci\s*\]\.id/.test(cron)) {
      throw new Error('campaign cron does not hoist `const campaignId = scheduled[ci].id` inside the loop');
    }
    t.pass('campaign cron hoists `const campaignId` inside the loop body');
  } catch (e) { t.fail('campaignId hoisted', e); }

  // ── 3. setImmediate uses the hoisted const, not scheduled[ci].id ─
  try {
    // Bad shape: `setImmediate(...processCampaign(scheduled[ci].id)...)`
    if (/setImmediate\s*\([\s\S]{0,200}processCampaign\s*\(\s*scheduled\s*\[\s*ci\s*\]\s*\.id/.test(cron)) {
      throw new Error('setImmediate still references `scheduled[ci].id` directly — closure-binding regression');
    }
    // Good shape: setImmediate body invokes processCampaign(campaignId)
    if (!/setImmediate\s*\([\s\S]{0,200}processCampaign\s*\(\s*campaignId\s*\)/.test(cron)) {
      throw new Error('setImmediate body does not invoke `processCampaign(campaignId)` — wrong identifier');
    }
    t.pass('setImmediate body uses the hoisted `campaignId`, not `scheduled[ci].id`');
  } catch (e) { t.fail('setImmediate identifier', e); }

  // ── 4. UPDATE result captured + rowCount checked (P3-WORKER-N1) ─
  try {
    // Must capture the UPDATE result.
    if (!/(?:const|var|let)\s+result\s*=\s*await\s+execute\s*\(\s*"UPDATE\s+email_campaigns/.test(cron)) {
      throw new Error('campaign cron does not capture the UPDATE result (`const result = await execute("UPDATE email_campaigns ...")`)');
    }
    // Must guard on rowCount > 0 before queueing setImmediate.
    if (!/if\s*\(\s*result\s*&&\s*result\.rowCount\s*>\s*0\s*\)\s*\{[\s\S]{0,300}setImmediate/.test(cron)) {
      throw new Error('campaign cron does not gate `setImmediate(processCampaign(...))` on `if (result && result.rowCount > 0)`');
    }
    t.pass('campaign cron checks UPDATE rowCount before dispatching processCampaign (P3-WORKER-N1)');
  } catch (e) { t.fail('rowCount guard', e); }

  // ── 5. processCampaign uses .catch(...) instead of bare try/catch ─
  try {
    // Bad shape: `try { processCampaign(...); } catch (_) {}`
    if (/try\s*\{\s*processCampaign\s*\(/.test(cron)) {
      throw new Error('processCampaign is still wrapped in a sync `try { processCampaign(...); } catch` — async rejection escape');
    }
    // Good shape: `processCampaign(...).catch(...)`
    if (!/processCampaign\s*\(\s*campaignId\s*\)\s*\.catch\s*\(/.test(cron)) {
      throw new Error('processCampaign call site does not use `.catch(...)` — async rejection would escape');
    }
    t.pass('processCampaign uses `.catch(...)` for async rejection (Sub-issue B pattern)');
  } catch (e) { t.fail('processCampaign .catch()', e); }

  // ── 6. cron is still inside the primary block (Phase 1 contract) ─
  // Belt-and-suspenders: assert the cron sits between the `if (CONFIG.SLA_MODE === 'primary') {`
  // (worker-block opener — not the boot warning) and its matching `} else {`.
  try {
    const PRIMARY_OPEN = "if (CONFIG.SLA_MODE === 'primary') {";
    const PRIMARY_BODY_MARKER = "SLA MODE: primary (single writer enabled)";
    let openLine = -1;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(PRIMARY_OPEN) < 0) continue;
      const peek = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
      if (peek.indexOf(PRIMARY_BODY_MARKER) >= 0) { openLine = i; break; }
    }
    if (openLine < 0) throw new Error('worker primary-block opener not located');
    const PRIMARY_END_RE = /^  } else \{\s*$/;
    let closeLine = -1;
    for (let i = openLine + 1; i < lines.length; i++) {
      if (PRIMARY_END_RE.test(lines[i])) { closeLine = i; break; }
    }
    if (closeLine < 0) throw new Error("`  } else {` line not found after worker-block opener");
    const cronLine = lines.findIndex(function (l, i) { return i > openLine && i < closeLine && l.indexOf('campaignCron.schedule(') >= 0; });
    if (cronLine < 0) throw new Error('campaignCron.schedule() not inside the primary block');
    t.pass('campaign cron is still gated on SLA_MODE=primary (Phase 1 contract preserved)');
  } catch (e) { t.fail('campaign cron primary-gated', e); }

  // ── 7. existing side-effect logging is preserved ─────────────
  // (The "Triggered N scheduled campaign(s)" log at the end of the
  // tick should still fire after the loop. Same for the boot-time
  // "Campaign scheduler cron registered" log.)
  try {
    if (!/logMajor\s*\(\s*'\[campaigns\] Triggered '/.test(cron)) {
      throw new Error('campaign cron lost the per-tick `[campaigns] Triggered N scheduled campaign(s)` log');
    }
    if (!/logMajor\s*\(\s*'Campaign scheduler cron registered/.test(cron)) {
      throw new Error('campaign cron lost the boot-time registration log');
    }
    t.pass('existing logging side-effects preserved');
  } catch (e) { t.fail('logging preserved', e); }
}
