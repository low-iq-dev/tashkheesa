'use strict';
// Guard: marking a notification READ must not overwrite what the dispatcher
// recorded about DELIVERY.
//
// notifications.status was carrying two unrelated lifecycles at once — the
// dispatcher's outcome ('sent' / 'failed' / 'cancelled' / 'skipped') and the
// recipient's bell state ('seen'). Six routes wrote status='seen' alongside
// is_read=true when a user opened their notifications, so opening the bell
// erased the delivery outcome of every notification in it.
//
// Measured in production on 2026-08-29: 26 rows had lost their outcome that
// way, nine of them emails that genuinely never sent. Counting failures by
// status said "4 failed"; counting by the error still sitting in `response`
// said 48. The failures were invisible to /ops/silent-failures, which is the
// one place anybody would look.
//
// is_read is the read-state column and countUnseenNotifications already
// prefers it. A status='seen' write is therefore redundant wherever is_read
// exists — and destructive. It stays ONLY in the legacy fallback branches,
// which run against a schema that has no is_read column and so have nowhere
// else to put read state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no UPDATE sets is_read and status=seen in the same statement', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/UPDATE\s+notifications/i.test(line)) return;
      // The destructive shape: one statement that writes BOTH columns. A
      // statement writing only status='seen' is the legacy fallback and is
      // allowed; one writing only is_read is the fix.
      if (/is_read\s*=\s*true/.test(line) && /status\s*=\s*'seen'/.test(line)) {
        offenders.push(path.relative(ROOT, file) + ':' + (i + 1));
      }
    });
  }
  assert.deepEqual(
    offenders, [],
    'these overwrite the delivery outcome when a user reads their bell:\n  ' +
    offenders.join('\n  ') +
    "\nDrop the status='seen' write — is_read already carries read state."
  );
});

test('the unread count still prefers is_read over status', () => {
  // If this ever flips back to counting on status, the fix above would make
  // every notification look permanently unread.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'notifications.js'), 'utf8');
  const idx = src.indexOf('countUnseenNotifications');
  assert.ok(idx > 0, 'countUnseenNotifications not found');
  const body = src.slice(idx, idx + 1400);
  const isReadAt = body.indexOf('COALESCE(is_read, false) = false');
  const statusAt = body.indexOf("NOT IN ('seen','read')");
  assert.ok(isReadAt > 0, 'expected the is_read branch to still exist');
  assert.ok(
    statusAt === -1 || isReadAt < statusAt,
    'the status-based count must remain the FALLBACK, not the primary branch'
  );
});
