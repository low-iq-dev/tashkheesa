// tests/core/theme6-video-scheduler-notifications.test.js
//
// Theme 6 sub-issue D regression guard.
//
// Scope: src/video_scheduler.js — the file that handles
// `sweepStalePendingSlots`, the 24h escalation + 48h auto-cancel
// flow for video appointment slots.
//
// Bug pattern (3 sites pre-fix, all in `sweepStalePendingSlots`):
//
//   Site 1 (patient at line 252-259, P3-WORKER-N6):
//     queueNotification({
//       userId: slot.patient_id,    // ❌ canonical field is `toUserId`
//       type: 'whatsapp',           // ❌ canonical field is `channel`
//       data: { ... },              // ❌ canonical field is `response`
//       template: 'video_slot_auto_cancelled_patient', ...
//     });
//     → returns { ok:false, reason:'invalid_to_user_id' } at notify.js:233
//       (toUserId was undefined). Patient never told their slot was
//       auto-cancelled and their refund issued.
//
//   Sites 2+3 (admin alerts at 262-268 + 273-285, P3-WORKER-N2):
//     queueNotification({
//       type: 'admin_alert',        // ❌ not a queueNotification field
//       data: { ... },              // ❌ canonical is `response`
//       // ↑↑↑ no `toUserId` AT ALL — silently dropped.
//       ...
//     });
//     → admin alerts for stuck video slots have never reached anyone.
//
// Fix (Theme 6 Phase 4 / Sub-issue D):
//   - Patient call: `toUserId: ... channel: 'whatsapp', response: JSON.stringify(...)`
//     (and `await`-ed for consistency with the surrounding async loop).
//   - Admin calls: replaced with `notifyAdmins(...)` helper at the top
//     of the file, which fans out one queueNotification per active
//     superadmin (canonical pattern, mirrors notify.js dispatchSlaBreach).
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

console.log('\n📺 Theme 6 sub-D — video_scheduler queueNotification field shapes\n');

const VS = path.join(__dirname, '..', '..', 'src', 'video_scheduler.js');
const src = fs.readFileSync(VS, 'utf8');

// Strip JS comments so audit-narrative comments quoting the OLD shape
// (`userId:`, `type:`, `data:`) don't trigger false positives.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const code = stripComments(src);

// ── 1. No `userId:` field anywhere as a queueNotification arg ─────
//
// Walk every queueNotification(...) call body and confirm none of them
// contain a literal `userId:` field. (We can't simply grep `userId:`
// across the whole file because comments are now stripped, but in
// principle that grep also works.)
function findCallBodies(text, fnName) {
  const re = new RegExp('\\b' + fnName + '\\s*\\(\\s*\\{', 'g');
  const bodies = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 0;
    let close = -1;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue;
    bodies.push({ start: m.index, body: text.slice(m.index, close + 1) });
  }
  return bodies;
}

try {
  const bodies = findCallBodies(code, 'queueNotification');
  if (bodies.length === 0) throw new Error('expected at least one queueNotification call in src/video_scheduler.js');
  const offenders = [];
  for (const b of bodies) {
    if (/\buserId\s*:/.test(b.body)) {
      const lineNo = code.slice(0, b.start).split('\n').length;
      offenders.push('  src/video_scheduler.js:' + lineNo);
    }
  }
  if (offenders.length) {
    throw new Error('queueNotification call(s) still use `userId:` instead of `toUserId:`:\n' + offenders.join('\n'));
  }
  t.pass('no queueNotification call in video_scheduler.js uses `userId:` as a recipient field');
} catch (e) { t.fail('userId: → toUserId:', e); }

// ── 2. No `type:` field as a queueNotification arg (canonical is channel:) ─
try {
  const bodies = findCallBodies(code, 'queueNotification');
  const offenders = [];
  for (const b of bodies) {
    // Match `type: '<literal>'` (the broken shape). We don't disallow
    // `type` inside a JSON.stringify({...}) because that's part of the
    // payload, not a queueNotification arg. We catch only top-level
    // shapes by requiring `\n\s*type\s*:\s*['"]`.
    if (/\n\s*type\s*:\s*['"]/.test(b.body)) {
      const lineNo = code.slice(0, b.start).split('\n').length;
      offenders.push('  src/video_scheduler.js:' + lineNo);
    }
  }
  if (offenders.length) {
    throw new Error("queueNotification call(s) still use `type: '...'` (queueNotification has no `type` field; should be `channel`):\n" + offenders.join('\n'));
  }
  t.pass('no queueNotification call uses `type:` (only `channel:` is canonical)');
} catch (e) { t.fail("type: → channel:", e); }

// ── 3. No `data:` field as a queueNotification arg (canonical is response:) ─
try {
  const bodies = findCallBodies(code, 'queueNotification');
  const offenders = [];
  for (const b of bodies) {
    if (/\n\s*data\s*:/.test(b.body)) {
      const lineNo = code.slice(0, b.start).split('\n').length;
      offenders.push('  src/video_scheduler.js:' + lineNo);
    }
  }
  if (offenders.length) {
    throw new Error('queueNotification call(s) still use `data:` (queueNotification has no `data` field; should be `response: JSON.stringify(...)`):\n' + offenders.join('\n'));
  }
  t.pass('no queueNotification call uses `data:` (only `response:` is canonical)');
} catch (e) { t.fail('data: → response:', e); }

// ── 4. Every queueNotification call has a `toUserId:` field ────────
//
// Sites that fan out to multiple recipients (the new admin-alert path)
// invoke a helper `notifyAdmins(...)` instead — those don't need a
// per-call `toUserId:` because the helper provides one per superadmin.
// Direct queueNotification calls in this file MUST carry `toUserId:`.
try {
  const bodies = findCallBodies(code, 'queueNotification');
  const offenders = [];
  for (const b of bodies) {
    if (!/\btoUserId\s*:/.test(b.body)) {
      const lineNo = code.slice(0, b.start).split('\n').length;
      offenders.push('  src/video_scheduler.js:' + lineNo);
    }
  }
  if (offenders.length) {
    throw new Error('queueNotification call(s) missing `toUserId:` field (the call will silently drop at notify.js:233):\n' + offenders.join('\n'));
  }
  t.pass('every queueNotification call in video_scheduler.js carries a `toUserId:` field');
} catch (e) { t.fail('toUserId: present on every call', e); }

// ── 5. `notifyAdmins` helper exists with canonical fan-out shape ───
try {
  if (!/async\s+function\s+notifyAdmins\s*\(/.test(code)) {
    throw new Error('helper `async function notifyAdmins(...)` not defined in video_scheduler.js');
  }
  // The helper must SELECT active superadmins (mirrors notify.js dispatchSlaBreach).
  if (!/SELECT\s+id\s+FROM\s+users\s+WHERE\s+role\s*=\s*'superadmin'/i.test(code)) {
    throw new Error("notifyAdmins does not query active superadmins via `SELECT id FROM users WHERE role = 'superadmin'`");
  }
  // The helper must use queueNotification with toUserId AND a per-recipient dedupe-key suffix.
  if (!/queueNotification\s*\(\s*\{[\s\S]{0,400}toUserId\s*:\s*r\.id/.test(code)) {
    throw new Error('notifyAdmins does not invoke queueNotification with `toUserId: r.id` per recipient');
  }
  if (!/dedupe_key\s*:\s*`\$\{dedupeKey\}:\$\{r\.id\}`/.test(code)) {
    throw new Error('notifyAdmins does not append `:${r.id}` to the dedupe key — fan-out would collide on the unique index');
  }
  t.pass('notifyAdmins helper present with canonical dispatchSlaBreach-style fan-out');
} catch (e) { t.fail('notifyAdmins helper shape', e); }

// ── 6. Both admin-alert call sites use the helper, not direct queueNotification with type:'admin_alert' ─
try {
  // The admin-alert templates should now appear inside a notifyAdmins(...) call.
  for (const tmpl of ['video_slot_auto_cancelled_admin', 'video_slot_stale_admin']) {
    const re = new RegExp('notifyAdmins\\s*\\(\\s*\\{[\\s\\S]{0,400}template\\s*:\\s*[\'"]' + tmpl + '[\'"]');
    if (!re.test(code)) {
      throw new Error('admin alert template `' + tmpl + '` not invoked via notifyAdmins(...) — fan-out missing');
    }
  }
  t.pass('both admin-alert templates dispatched via notifyAdmins fan-out');
} catch (e) { t.fail('admin alerts use notifyAdmins helper', e); }
