// tests/core/draft-nudges.test.js
//
// Part A (patient recovery, 2 Nov 2026) — the draft-resume nudge, without a
// database (the eligibility SQL itself is exercised against a real database in
// tests/core/draft-nudges-db.test.js):
//   A. the ladder — 1h at 60 minutes idle, 24h at 24 hours, never a third
//   B. quiet hours — 22:30 Cairo waits, 08:05 sends
//   C. the sweep with injected deps — channels, keys, payload (the token id,
//      never the token), the recipientGuard on email, funnel step
//   D. the token — signed, scoped to one draft, 72 hours, stored hashed
//   E. the resume route — owner, no session, another patient, expired
//   F. copy and wiring — the brief's copy word for word, the registries, the
//      pg-boss queue, the worker spec, the funnel digest line

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'draft-nudges-test-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
};
async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const nudges = require('../../src/services/draft_nudges');
const resume = require('../../src/services/draft_resume');
const { isCairoQuietHours } = require('../../src/utils/cairo_quiet_hours');

// Cairo is UTC+2 in November 2026 (Egypt's summer time ends late October).
const CAIRO_2230 = new Date('2026-11-02T20:30:00Z');
const CAIRO_0805 = new Date('2026-11-03T06:05:00Z');

function fakePg(candidates) {
  const log = { executes: [], queries: [] };
  return {
    log,
    queryAll: async (sql, params) => {
      log.queries.push(sql);
      if (/UPDATE draft_resume_tokens t/.test(sql)) return [];
      if (/FROM orders o/.test(sql)) return candidates;
      return [];
    },
    queryOne: async () => null,
    execute: async (sql, params) => { log.executes.push({ sql, params }); return { rowCount: 1 }; },
  };
}
function fakeNotify() {
  const queued = [];
  return { queued, queueNotification: async (o) => { queued.push(o); return { ok: true, id: 'n' + queued.length }; } };
}
const IDLE_2H = (now) => new Date(now.getTime() - 2 * 3600e3);
function draft(over) {
  return Object.assign({
    id: 'd-1', patient_id: 'p-1', reference_id: 'TSH-2026-000027', created_at: new Date('2026-11-02T10:00:00Z'),
    activity_at: IDLE_2H(CAIRO_0805), email: null, phone: '+201012345678', lang: 'ar', country_code: 'EG', levels_sent: [],
  }, over || {});
}

console.log('\n📝  draft-resume nudges (Part A)\n');

(async () => {
  // ════ A ════
  await check('A1: nothing before 60 minutes idle; 1h from 60 minutes; 24h from 24 hours', () => {
    assert.strictEqual(nudges.dueLevel(59, []), null);
    assert.strictEqual(nudges.dueLevel(60, []), '1h');
    assert.strictEqual(nudges.dueLevel(23 * 60, ['1h']), null, '1h already sent, not yet 24h');
    assert.strictEqual(nudges.dueLevel(24 * 60, ['1h']), '24h');
  });

  await check('A2: never a third — once the 24h has gone, nothing; a draft first seen at 24h gets only the 24h', () => {
    assert.strictEqual(nudges.dueLevel(30 * 24 * 60, ['1h', '24h']), null);
    assert.strictEqual(nudges.dueLevel(26 * 60, []), '24h');
    assert.strictEqual(nudges.dueLevel(90, ['24h']), null, 'the 1h can never follow the 24h');
  });

  // ════ B ════
  await check('B1: quiet hours are 22:00–08:00 Cairo for the nudges', () => {
    assert.strictEqual(isCairoQuietHours(CAIRO_2230, nudges.QUIET), true, '22:30');
    assert.strictEqual(isCairoQuietHours(new Date('2026-11-03T05:55:00Z'), nudges.QUIET), true, '07:55');
    assert.strictEqual(isCairoQuietHours(CAIRO_0805, nudges.QUIET), false, '08:05');
    assert.strictEqual(isCairoQuietHours(new Date('2026-11-02T19:59:00Z'), nudges.QUIET), false, '21:59');
  });

  await check('B2: at 22:30 Cairo the sweep sends nothing; at 08:05 the due nudge goes', async () => {
    const pg = fakePg([draft()]); const n = fakeNotify();
    const night = await nudges.runDraftNudgeSweep({ now: CAIRO_2230, pg, notify: n });
    assert.strictEqual(night.skipped, 'quiet_hours');
    assert.strictEqual(n.queued.length, 0);
    const morning = await nudges.runDraftNudgeSweep({ now: CAIRO_0805, pg: fakePg([draft()]), notify: n });
    assert.strictEqual(morning.nudged, 1);
    assert.ok(n.queued.length > 0);
  });

  // ════ C ════
  await check('C1: a phone-only patient → internal + whatsapp, key draft_resume:<order>:1h, the token id (never the token) in the payload', async () => {
    const pg = fakePg([draft()]); const n = fakeNotify();
    await nudges.runDraftNudgeSweep({ now: CAIRO_0805, pg, notify: n });
    assert.deepStrictEqual(n.queued.map((q) => q.channel), ['internal', 'whatsapp']);
    for (const q of n.queued) {
      assert.strictEqual(q.dedupeKey, 'draft_resume:d-1:1h');
      assert.strictEqual(q.template, 'draft_resume_1h');
      assert.strictEqual(q.orderId, 'd-1');
      assert.ok(/^[A-Za-z0-9_-]{10}$/.test(q.response.resume_token_id), 'token id');
      assert.ok(!('resume_token' in q.response) && !('link' in q.response), 'no working link stored');
      assert.strictEqual(q.recipientLang, 'ar');
    }
    const insert = pg.log.executes.find((e) => /INSERT INTO draft_resume_tokens/.test(e.sql));
    assert.ok(insert, 'token row written');
    assert.ok(/^[0-9a-f]{64}$/.test(insert.params[1]), 'only the SHA-256 is stored');
    const bump = pg.log.executes.find((e) => /funnel_daily_counts/.test(e.sql) && e.params[1] === 'draft_resume_sent');
    assert.ok(bump, 'draft_resume_sent counted');
  });

  await check('C2: a good email adds the email channel; SMS is never queued by the sweep (the worker adds it)', async () => {
    const n = fakeNotify();
    await nudges.runDraftNudgeSweep({ now: CAIRO_0805, pg: fakePg([draft({ email: 'mona.real@gmail.com' })]), notify: n });
    assert.deepStrictEqual(n.queued.map((q) => q.channel), ['internal', 'whatsapp', 'email']);
  });

  await check('C3: recipientGuard — a test/demo address or a staff domain excludes the patient from every channel', async () => {
    for (const email of ['test@gmail.com', 'p.demo-7@tashkheesa-mail.com', 'someone@example.com', 'ops@tashkheesa.com']) {
      const n = fakeNotify();
      await nudges.runDraftNudgeSweep({ now: CAIRO_0805, pg: fakePg([draft({ email })]), notify: n });
      assert.strictEqual(n.queued.length, 0, email);
    }
  });

  await check('C4: recipientGuard on a phone-only patient — the guard is email-only, so no email passes (report: F9)', async () => {
    const v = await nudges.emailVerdict(null);
    assert.deepStrictEqual(v, { nudge: true, email: null });
    const guard = require('../../src/services/recipientGuard');
    await assert.rejects(() => guard.validateRecipient(null), /missing_or_empty/, 'applied literally it would block them');
  });

  await check('C5: a draft already nudged at both levels gets nothing', async () => {
    const n = fakeNotify();
    await nudges.runDraftNudgeSweep({ now: CAIRO_0805, pg: fakePg([draft({ levels_sent: ['1h', '24h'], activity_at: new Date(CAIRO_0805.getTime() - 3 * 86400e3) })]), notify: n });
    assert.strictEqual(n.queued.length, 0);
  });

  // ════ D ════
  await check('D1: a token is 22 characters, signed; a tampered or truncated one is refused before any lookup', () => {
    const tok = resume.tokenForId('abcdefghij');
    assert.strictEqual(tok.length, 22);
    assert.strictEqual(resume.idFromToken(tok), 'abcdefghij');
    const flipped = tok.slice(0, 21) + (tok[21] === 'A' ? 'B' : 'A');
    assert.strictEqual(resume.idFromToken(flipped), null);
    assert.strictEqual(resume.idFromToken('zzzzzzzzzz' + tok.slice(10)), null, 'another id with this signature');
    assert.strictEqual(resume.idFromToken(tok.slice(0, 20)), null);
  });

  function tokenPg(rows) {
    return { queryOne: async (sql, params) => rows.find((r) => r.id === params[0] && r.token_hash === params[1]) || null };
  }
  const tokX = resume.tokenForId('xxxxxxxxxx');
  const tokY = resume.tokenForId('yyyyyyyyyy');
  const rowX = { id: 'xxxxxxxxxx', token_hash: resume.hashToken(tokX), order_id: 'draft-X', patient_id: 'p-1', expires_at: '2026-11-05T10:00:00Z' };

  await check('D2: a token for draft X resolves to draft X only — there is no way to name draft Y', async () => {
    const r = await resume.resolveToken(tokX, { pg: tokenPg([rowX]), now: new Date('2026-11-03T10:00:00Z') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.row.order_id, 'draft-X');
    assert.strictEqual(resume.wizardPathFor(r.row.order_id), '/patient/new-case?resume=draft-X');
    const other = await resume.resolveToken(tokY, { pg: tokenPg([rowX]), now: new Date('2026-11-03T10:00:00Z') });
    assert.deepStrictEqual(other, { ok: false, reason: 'invalid' }, 'a valid-looking token for no row');
  });

  await check('D3: after 72 hours the same token is refused', async () => {
    const r = await resume.resolveToken(tokX, { pg: tokenPg([rowX]), now: new Date('2026-11-05T10:00:01Z') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'expired');
    assert.strictEqual(resume.TOKEN_TTL_HOURS, 72);
  });

  await check('D4: the worker rebuilds the link from the id; the stored row is not changed', () => {
    const n = { id: 'n1', response: JSON.stringify({ resume_token_id: 'xxxxxxxxxx', caseReference: 'TSH-1' }) };
    const out = resume.withResumeLink(n);
    const p = JSON.parse(out.response);
    assert.strictEqual(p.link, 'https://tashkheesa.com/portal/patient/resume/' + tokX);
    assert.strictEqual(p.resume_token, tokX);
    assert.ok(!/resume_token"/.test(n.response), 'original untouched');
    assert.strictEqual(resume.withResumeLink({ response: '{"a":1}' }).response, '{"a":1}');
  });

  // ════ E ════
  const route = require('../../src/routes/draft_resume');
  function fakeRes() { const r = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, redirect(u) { this.location = u; return this; } }; return r; }
  async function open(user, outcome) {
    const origResolve = resume.resolveToken; const origOpen = resume.recordOpen;
    const opened = [];
    resume.resolveToken = async () => outcome;
    resume.recordOpen = async (row) => { opened.push(row.id); };
    try {
      const res = fakeRes();
      await route.handleResume({ params: { token: tokX }, user }, res);
      return { location: res.location, opened, headers: res.headers };
    } finally { resume.resolveToken = origResolve; resume.recordOpen = origOpen; }
  }

  await check('E1: the owner, signed in → the draft at its saved step; the open is recorded', async () => {
    const r = await open({ id: 'p-1', role: 'patient' }, { ok: true, row: rowX });
    assert.strictEqual(r.location, '/patient/new-case?resume=draft-X');
    assert.deepStrictEqual(r.opened, ['xxxxxxxxxx']);
    assert.strictEqual(r.headers['Cache-Control'], 'no-store');
  });

  await check('E2: no session → login with next set to the draft; nobody is signed in by the link', async () => {
    const r = await open(null, { ok: true, row: rowX });
    assert.strictEqual(r.location, '/login?next=' + encodeURIComponent('/patient/new-case?resume=draft-X'));
    assert.deepStrictEqual(r.opened, []);
  });

  await check('E3: another patient\'s session → their own dashboard, nothing recorded', async () => {
    const r = await open({ id: 'p-2', role: 'patient' }, { ok: true, row: rowX });
    assert.strictEqual(r.location, '/dashboard');
    assert.deepStrictEqual(r.opened, []);
  });

  await check('E4: expired or invalid → home / login, never the draft', async () => {
    assert.strictEqual((await open({ id: 'p-1', role: 'patient' }, { ok: false, reason: 'expired', row: rowX })).location, '/dashboard');
    assert.strictEqual((await open(null, { ok: false, reason: 'invalid' })).location, '/login');
  });

  // ════ F ════
  await check('F1: the WhatsApp copy is the brief\'s, word for word, EN and AR', () => {
    const { getOpenClawBody } = require('../../src/notify/openclawTemplates');
    const v = { caseReference: 'TSH-2026-000027', link: 'https://x/y' };
    assert.strictEqual(getOpenClawBody('draft_resume_1h', 'en', v), 'Tashkheesa: your case TSH-2026-000027 is saved. Finish it in 2 minutes: https://x/y');
    assert.strictEqual(getOpenClawBody('draft_resume_1h', 'ar', v), 'تشخيصة: حالتك TSH-2026-000027 محفوظة. أكملها في دقيقتين: https://x/y');
    assert.strictEqual(getOpenClawBody('draft_resume_24h', 'en', v), 'Tashkheesa: your case TSH-2026-000027 is still waiting. A named consultant from Shifa Hospital Group can review it within 48 hours: https://x/y');
    assert.strictEqual(getOpenClawBody('draft_resume_24h', 'ar', v), 'تشخيصة: حالتك TSH-2026-000027 لسه مستنية. استشاري من مجموعة مستشفيات شفاء يراجعها خلال 48 ساعة: https://x/y');
    const noRef = getOpenClawBody('draft_resume_1h', 'en', { link: 'https://x/y' });
    assert.strictEqual(noRef, 'Tashkheesa: your case is saved. Finish it in 2 minutes: https://x/y', 'an app draft has no reference yet');
  });

  await check('F2: «شفاء» without the article, and no person named, in every new patient copy', () => {
    const files = ['src/notify/openclawTemplates.js', 'src/notify/sms_templates.js', 'src/templates/email/ar/draft-resume-24h.hbs', 'src/notify.js'];
    for (const f of files) assert.ok(!/الشفاء/.test(read(f)), f + ' says الشفاء');
  });

  await check('F3: registered everywhere a template must be: titles, email map, bell category, email files', () => {
    const { getNotificationTitles } = require('../../src/notify/notification_titles');
    const { TEMPLATE_TO_EMAIL } = require('../../src/notification_worker');
    const { categoryFor } = require('../../src/services/notification_groups');
    for (const tpl of ['draft_resume_1h', 'draft_resume_24h', 'coverage_lead_open']) {
      const ti = getNotificationTitles(tpl, {});
      assert.ok(ti && ti.title_en && /[؀-ۿ]/.test(ti.title_ar), tpl + ' titles');
      assert.ok(TEMPLATE_TO_EMAIL[tpl], tpl + ' email mapping');
      for (const l of ['en', 'ar']) assert.ok(fs.existsSync(path.join(ROOT, 'src/templates/email', l, TEMPLATE_TO_EMAIL[tpl] + '.hbs')), tpl + ' ' + l);
      assert.strictEqual(categoryFor(tpl), 'cases');
    }
  });

  await check('F4: a pg-boss queue created before work/schedule, a heartbeat, a worker spec, boot wiring', () => {
    const jq = read('src/job_queue.js');
    const i = jq.indexOf("createQueue('draft-nudges')");
    assert.ok(i > 0 && i < jq.indexOf("boss.work('draft-nudges'") && i < jq.indexOf("boss.schedule('draft-nudges', '*/15 * * * *'"));
    assert.ok(/pingOps\('draft_nudges'/.test(jq));
    const { WORKER_SPECS } = require('../../src/services/admin_health');
    assert.ok(WORKER_SPECS.some((s) => s.key === 'draft_nudges'));
    const server = read('src/server.js');
    assert.ok(/await scheduleDraftNudges\(\)/.test(server));
    assert.ok(/app\.use\('\/', require\('\.\/routes\/draft_resume'\)\)/.test(server));
  });

  await check('F5: the funnel digest carries the three steps on a day that has any', () => {
    const fd = require('../../src/services/funnel_digest');
    const text = fd.formatDigest({ day: '2026-11-02', draft_resume_sent: 4, draft_resumed: 2, draft_resume_converted: 1 }, {});
    assert.ok(/Draft nudges: sent 4 · resumed 2 · submitted within 72h 1/.test(text), text);
    assert.ok(!/Draft nudges/.test(fd.formatDigest({ day: '2026-11-02' }, {})), 'quiet on a day without');
  });
})();
