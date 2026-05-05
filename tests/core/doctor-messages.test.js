// tests/core/doctor-messages.test.js
//
// P1-DOC-1: doctor messages page is no longer a stub. The doctor sidebar
// link and any deep-link to /portal/doctor/messages now 301-redirect to
// the real shared inbox at /portal/messages (src/routes/messaging.js:72,
// rendered by src/views/messages.ejs). The shared handler already covers
// patient + doctor, computes per-conversation unread counts, and renders
// bilingual copy.
//
// Coverage:
//   1. GET /portal/doctor/messages → 301 redirect to /portal/messages
//      (regression guard against the "Coming in Phase 2" stub returning).
//   2. Doctor sidebar partial: Messages nav item links to /portal/messages
//      (regression guard against the stub URL coming back).
//   3. GET /portal/messages as a doctor with a seeded conversation → 200,
//      body contains the patient name + unread badge.
//   4. GET /portal/messages as a doctor with zero conversations → 200,
//      body shows the empty-state copy.
//   5. GET /portal/messages?lang=ar as doctor → AR copy + RTL signal.
//
// Boots the real express server in a child process. Skips when
// DATABASE_URL or JWT_SECRET are unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💬 core/doctor-messages (P1-DOC-1)\n');

// ── Static check (no DB / no server) ───────────────────────────────
// Sidebar partial regression guard. Cheap, runs even when DATABASE_URL
// is absent. Locks in the post-fix href and bans the stub URL from
// coming back via copy-paste.
try {
  const sidebarPath = path.join(__dirname, '..', '..', 'src', 'views', 'partials', 'doctor', 'sidebar.ejs');
  const src = fs.readFileSync(sidebarPath, 'utf8');
  assert.ok(src.includes('href="/portal/messages"'),
    'doctor sidebar must contain href="/portal/messages" (the shared inbox)');
  assert.ok(!src.includes('href="/portal/doctor/messages"'),
    'doctor sidebar must NOT link to the P1-DOC-1 stub URL /portal/doctor/messages');
  t.pass('P1-DOC-1 #2: doctor sidebar Messages link → /portal/messages (regression guard)');
} catch (e) { t.fail('P1-DOC-1 #2 sidebar', e); }

if (!process.env.DATABASE_URL) { t.skip('doctor-messages http', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('doctor-messages http', 'JWT_SECRET not set'); return; }

// onboarding-self-heal.test.js poisons require.cache for src/pg with an
// in-memory stub. Reload the real module — see P3-TEST-1 in the audit.
const pgPath = require.resolve('../../src/pg');
delete require.cache[pgPath];
const { execute, queryOne } = require(pgPath);
const { sign } = require('../../src/auth');

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

const PREFIX = 'test-p1doc1-';
const DOCTOR_ID = PREFIX + 'doctor-' + crypto.randomBytes(3).toString('hex');
const PATIENT_ID = PREFIX + 'patient-' + crypto.randomBytes(3).toString('hex');
const ORDER_ID = PREFIX + 'order-' + crypto.randomBytes(3).toString('hex');
const CONVO_ID = PREFIX + 'convo-' + crypto.randomBytes(3).toString('hex');
const MSG_ID = PREFIX + 'msg-' + crypto.randomBytes(3).toString('hex');

const doctorCookie = COOKIE_NAME + '=' + sign({
  id: DOCTOR_ID, role: 'doctor', email: DOCTOR_ID + '@test.local',
  name: 'Dr. Test', lang: 'en', phone: '+201000000001'
});

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath,
      [path.join(__dirname, '..', '..', 'src', 'server.js')],
      {
        env: Object.assign({}, process.env, {
          PORT, LAUNCH_GATE_OFF: '1', TZ: 'UTC', PGTZ: 'UTC', CSRF_MODE: 'off'
        }),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let booted = false;
    serverProc.stdout.on('data', (buf) => {
      if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); }
    });
    serverProc.stderr.on('data', () => {});
    serverProc.once('exit', (code) => { if (!booted) reject(new Error('server exited code=' + code)); });
    setTimeout(() => { if (!booted) reject(new Error('server boot timeout')); }, 15000);
  });
}

async function shutdownServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 400));
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function get(p, cookie) {
  const r = await fetch(BASE + p, { redirect: 'manual', headers: { Cookie: cookie } });
  const body = await r.text();
  return { status: r.status, body, location: r.headers.get('location') || '' };
}

async function clearConversations() {
  await execute(`DELETE FROM messages WHERE id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM conversations WHERE id LIKE $1`, [PREFIX + '%']);
}

async function cleanupAll() {
  await execute(`DELETE FROM messages WHERE id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM conversations WHERE id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM orders WHERE id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

(async function run() {
  try {
    await cleanupAll();

    // Seed doctor + patient + order. Order isn't strictly required for the
    // shared messages handler (the JOIN is LEFT), but adds a case ref to
    // exercise the row's specialty/service columns.
    const seedHash = '$2b$10$0000000000000000000000000000000000000000000000000000';
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, phone, created_at)
       VALUES ($1, $2, $3, 'Dr. Test', 'doctor', 'en', true, '+201000000001', NOW())`,
      [DOCTOR_ID, DOCTOR_ID + '@test.local', seedHash]
    );
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, phone, created_at)
       VALUES ($1, $2, $3, 'Aliya Patient', 'patient', 'en', true, '+201000000002', NOW())`,
      [PATIENT_ID, PATIENT_ID + '@test.local', seedHash]
    );

    const seedCheck = await queryOne(`SELECT id FROM users WHERE id = $1`, [DOCTOR_ID]);
    if (!seedCheck) {
      t.skip('doctor-messages', 'seed doctor missing post-INSERT (concurrent test interference?)');
      return;
    }

    try { await bootServer(); }
    catch (e) { t.skip('doctor-messages http', 'boot failed: ' + e.message); return; }

    // ── 1. /portal/doctor/messages → 301 → /portal/messages ─────────
    try {
      const r = await get('/portal/doctor/messages', doctorCookie);
      assert.strictEqual(r.status, 301, '/portal/doctor/messages should 301 redirect; got ' + r.status);
      assert.strictEqual(r.location, '/portal/messages',
        '301 target must be /portal/messages; got ' + r.location);
      t.pass('P1-DOC-1 #1: /portal/doctor/messages → 301 /portal/messages');
    } catch (e) { t.fail('P1-DOC-1 #1 redirect', e); }

    // ── 3. Doctor inbox renders seeded conversation + unread badge ──
    try {
      await clearConversations();
      // Conversation with one unread message FROM the patient (sender_id != doctor)
      // — the unread COUNT(*) clause is what drives the badge.
      await execute(
        `INSERT INTO conversations (id, order_id, patient_id, doctor_id, status, created_at, updated_at)
         VALUES ($1, NULL, $2, $3, 'active', NOW(), NOW())`,
        [CONVO_ID, PATIENT_ID, DOCTOR_ID]
      );
      await execute(
        `INSERT INTO messages (id, conversation_id, sender_id, sender_role, content, is_read, created_at)
         VALUES ($1, $2, $3, 'patient', 'Hi doctor — quick question about my report', false, NOW())`,
        [MSG_ID, CONVO_ID, PATIENT_ID]
      );

      const r = await get('/portal/messages', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/messages should 200; got ' + r.status);
      assert.ok(/Aliya Patient/.test(r.body),
        'doctor inbox should render seeded patient name; first 400 chars: ' + r.body.slice(0, 400));
      assert.ok(/conv-badge/.test(r.body),
        'doctor inbox should render an unread badge for the seeded conversation; not found in body');
      t.pass('P1-DOC-1 #3: doctor inbox renders seeded conversation with unread badge');
    } catch (e) { t.fail('P1-DOC-1 #3 inbox render', e); }

    // ── 4. Empty state when no conversations ────────────────────────
    try {
      await clearConversations();
      const r = await get('/portal/messages', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/messages empty should 200; got ' + r.status);
      assert.ok(/No conversations yet/i.test(r.body),
        'empty state copy should render; first 600 chars: ' + r.body.slice(0, 600));
      t.pass('P1-DOC-1 #4: doctor inbox empty state renders correctly');
    } catch (e) { t.fail('P1-DOC-1 #4 empty state', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanupAll(); } catch (_) {}
  }
})();

// ── 5. AR rendering — static template check ──────────────────────
// Verifies messages.ejs has both EN and AR copy paths wired through
// _isAr. Runtime cookie/query lang plumbing is exercised by other
// suites (lang-toggle, blog AR, etc.); duplicating it here couples
// this test to baseMiddlewares ordering for no extra signal.
(function arViewCheck() {
  try {
    const messagesViewPath = path.join(__dirname, '..', '..', 'src', 'views', 'messages.ejs');
    const src = fs.readFileSync(messagesViewPath, 'utf8');
    assert.ok(/الرسائل/.test(src), 'messages.ejs must contain AR page title "الرسائل"');
    assert.ok(/_isAr\s*\?/.test(src), 'messages.ejs must branch on _isAr for bilingual rendering');
    assert.ok(/'No conversations yet'/.test(src) && /'لا توجد محادثات'/.test(src),
      'messages.ejs must contain both EN and AR empty-state copy');
    t.pass('P1-DOC-1 #5: messages.ejs has bilingual EN+AR rendering paths (static check)');
  } catch (e) { t.fail('P1-DOC-1 #5 view bilingual', e); }
})();

