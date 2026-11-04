// tests/notifications/sms-fallback.test.js
//
// Patient recovery, Parts E and B (2 Nov 2026). No database: every function
// under test takes its queries, its queue and its provider as injected deps.
//
//   A. which failed WhatsApp sends may be tried again (lib/openclaw_client
//      `outcome`, notify/sms_fallback.whatsappFailureIsFinal)
//   B. the fallback decision, case by case — never when WhatsApp was sent
//   C. maybeQueueSmsFallback: one sms row, the right key, only for patients
//   D. processSms: unconfigured, allowlist, opt-out, per-patient cap, global
//      cap (one quiet ops push a day), provider SID/price recorded, failure final
//   E. the provider adapter: off unless configured, the non-production fence,
//      a Twilio refusal vs a lost connection

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
};
async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

const fb = require('../../src/notify/sms_fallback');
const { outcomeForStatus } = require('../../src/lib/openclaw_client');
const provider = require('../../src/notify/sms_provider');

// A Cairo daytime clock for every send below (SMS waits out 21:00–09:00, Egypt's operator curfew).
const DAY = new Date('2026-11-02T10:00:00Z'); // 12:00 Cairo
const PATIENT = { id: 'u-1', role: 'patient', phone: '+201012345678', email: null, lang: 'ar', notify_whatsapp: true };
const ORDER = 'fb92814a-d2b3-426d-b259-e6456df1e1a8';
const KEY30 = 'payment_reminder:30m:whatsapp:' + ORDER + ':u-1';

console.log('\n📲  WhatsApp single attempt + SMS fallback (Parts E, B)\n');

(async () => {
  // ════ A ════
  await check('A1: the gateway\'s 5xx and a timeout are "unknown" — the send may be in OpenClaw\'s queue', () => {
    assert.strictEqual(outcomeForStatus(502), 'unknown');
    assert.strictEqual(outcomeForStatus(500), 'unknown');
    assert.strictEqual(fb.whatsappOutcome({ ok: false, error: 'oc_timeout', outcome: 'unknown' }), 'unknown');
    assert.strictEqual(fb.whatsappOutcome({ ok: false, error: 'http_502' }), 'unknown', 'no outcome field → unknown');
  });

  await check('A2: refusals, Cloudflare 530, no connection and missing config are "not_sent"', () => {
    for (const s of [400, 401, 403, 413, 429, 530]) assert.strictEqual(outcomeForStatus(s), 'not_sent', String(s));
    assert.strictEqual(fb.whatsappOutcome({ ok: false, error: 'no_openclaw_template', permanent: true }), 'not_sent');
    assert.strictEqual(fb.whatsappOutcome({ ok: false, error: 'oc_env_misconfigured', outcome: 'not_sent' }), 'not_sent');
  });

  await check('A3: only an allowlisted template to a PATIENT is single-attempt', () => {
    const r502 = { ok: false, error: 'http_502', status: 502, outcome: 'unknown' };
    assert.strictEqual(fb.whatsappFailureIsFinal('payment_reminder_30m', PATIENT, r502), true);
    assert.strictEqual(fb.whatsappFailureIsFinal('draft_resume_1h', PATIENT, r502), true);
    assert.strictEqual(fb.whatsappFailureIsFinal('payment_reminder_30m', PATIENT, { ok: false, outcome: 'not_sent' }), false, 'not_sent keeps the retry ladder');
    assert.strictEqual(fb.whatsappFailureIsFinal('order_assigned_doctor', PATIENT, r502), false, 'not allowlisted');
    assert.strictEqual(fb.whatsappFailureIsFinal('payment_reminder_30m', { role: 'doctor' }, r502), false, 'doctors out of scope');
    assert.strictEqual(fb.isSingleShot('whatsapp', 'payment_reminder_6h'), true);
    assert.strictEqual(fb.isSingleShot('sms', 'report_ready_patient'), true);
    assert.strictEqual(fb.isSingleShot('email', 'payment_reminder_6h'), false);
    assert.strictEqual(fb.isSingleShot('whatsapp', 'sla_reminder_1h'), false);
  });

  // ════ B ════
  await check('B1: WhatsApp sent → never an SMS, whatever the email did', () => {
    for (const e of [{}, { emailExists: true, emailStatus: 'failed' }, { emailExists: true, emailStatus: 'skipped' }]) {
      assert.strictEqual(fb.fallbackDecision(Object.assign({ waExists: true, waStatus: 'sent', hasEmail: true, emailExists: false }, e)), 'none');
    }
  });

  await check('B2: WhatsApp failed → SMS for a phone-only patient, or when the email was skipped/failed/never queued', () => {
    const base = { waExists: true, waStatus: 'failed' };
    assert.strictEqual(fb.fallbackDecision(Object.assign({ hasEmail: false, emailExists: true, emailStatus: 'skipped' }, base)), 'send');
    assert.strictEqual(fb.fallbackDecision(Object.assign({ hasEmail: true, emailExists: true, emailStatus: 'failed' }, base)), 'send');
    assert.strictEqual(fb.fallbackDecision(Object.assign({ hasEmail: true, emailExists: false }, base)), 'send');
  });

  await check('B3: WhatsApp failed but the email went → no SMS; email still pending → wait', () => {
    assert.strictEqual(fb.fallbackDecision({ waExists: true, waStatus: 'failed', hasEmail: true, emailExists: true, emailStatus: 'sent' }), 'none');
    assert.strictEqual(fb.fallbackDecision({ waExists: true, waStatus: 'failed', hasEmail: true, emailExists: true, emailStatus: 'retry' }), 'wait');
  });

  await check('B4: WhatsApp not final yet → wait; no WhatsApp row → none', () => {
    for (const s of ['queued', 'sending', 'retry']) {
      assert.strictEqual(fb.fallbackDecision({ waExists: true, waStatus: s, hasEmail: false }), 'wait', s);
    }
    assert.strictEqual(fb.fallbackDecision({ waExists: false, hasEmail: false }), 'none');
  });

  await check('B5: a WhatsApp skip because the patient opted out or has no phone → no SMS; any other skip → SMS', () => {
    assert.strictEqual(fb.fallbackDecision({ waExists: true, waStatus: 'skipped', waSkip: 'whatsapp_opted_out', hasEmail: false }), 'none');
    assert.strictEqual(fb.fallbackDecision({ waExists: true, waStatus: 'skipped', waSkip: 'no_phone_for_user', hasEmail: false }), 'none');
    assert.strictEqual(fb.fallbackDecision({ waExists: true, waStatus: 'skipped', waSkip: 'flag_off', hasEmail: false }), 'send');
  });

  await check('B6: the SMS key is the WhatsApp key with the channel swapped; a channel-free key is kept', () => {
    assert.strictEqual(fb.channelKey(KEY30, 'whatsapp', 'sms'), 'payment_reminder:30m:sms:' + ORDER + ':u-1');
    assert.strictEqual(fb.channelKey('payment_reminder:6h:r1760000000:whatsapp:c:u', 'whatsapp', 'sms'), 'payment_reminder:6h:r1760000000:sms:c:u');
    assert.strictEqual(fb.channelKey('draft_resume:' + ORDER + ':1h', 'whatsapp', 'sms'), 'draft_resume:' + ORDER + ':1h');
    assert.strictEqual(fb.channelKey(null, 'whatsapp', 'sms'), null);
  });

  // ════ C ════
  function fakeQueryOne(rows) {
    const calls = [];
    const fn = async (sql, params) => { calls.push({ sql, params }); return rows.shift() || null; };
    fn.calls = calls;
    return fn;
  }

  await check('C1: a phone-only patient\'s failed payment reminder → ONE sms row on the swapped key', async () => {
    const queued = [];
    const row = { id: 'wa-1', channel: 'whatsapp', template: 'payment_reminder_30m', to_user_id: 'u-1', order_id: ORDER,
      dedupe_key: KEY30, at: new Date(), response: JSON.stringify({ case_id: ORDER, caseReference: 'TSH-2026-000020' }) };
    const emailRow = { id: 'em-1', status: 'skipped', response: '{"skipped":"no_email_for_user"}', dedupe_key: KEY30.replace(':whatsapp:', ':email:') };
    const r = await fb.maybeQueueSmsFallback(row, PATIENT, 'failed', { ok: false, error: 'http_502', outcome: 'unknown' },
      { queryOne: fakeQueryOne([emailRow]), queueNotification: async (o) => { queued.push(o); return { ok: true }; } });
    assert.strictEqual(r.queued, true);
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0].channel, 'sms');
    assert.strictEqual(queued[0].dedupeKey, 'payment_reminder:30m:sms:' + ORDER + ':u-1');
    assert.strictEqual(queued[0].response.fallback_of, 'wa-1');
    assert.strictEqual(queued[0].template, 'payment_reminder_30m');
  });

  await check('C2: WhatsApp sent → nothing queued; a doctor or a non-allowlisted template → nothing queued', async () => {
    const queued = [];
    const q = async (o) => { queued.push(o); return { ok: true }; };
    const row = { id: 'wa-2', channel: 'whatsapp', template: 'payment_reminder_6h', to_user_id: 'u-1', order_id: ORDER, dedupe_key: KEY30, at: new Date(), response: '{}' };
    await fb.maybeQueueSmsFallback(row, PATIENT, 'sent', { ok: true }, { queryOne: fakeQueryOne([null]), queueNotification: q });
    await fb.maybeQueueSmsFallback(row, Object.assign({}, PATIENT, { role: 'doctor' }), 'failed', {}, { queryOne: fakeQueryOne([null]), queueNotification: q });
    await fb.maybeQueueSmsFallback(Object.assign({}, row, { template: 'order_assigned_doctor' }), PATIENT, 'failed', {}, { queryOne: fakeQueryOne([null]), queueNotification: q });
    assert.strictEqual(queued.length, 0);
  });

  await check('C3: the email row finishing LAST after a failed WhatsApp is what queues the SMS', async () => {
    const queued = [];
    const emailRow = { id: 'em-3', channel: 'email', template: 'payment_reminder_30m', to_user_id: 'u-1', order_id: ORDER,
      dedupe_key: KEY30.replace(':whatsapp:', ':email:'), at: new Date(), response: '{}' };
    const waRow = { id: 'wa-3', status: 'failed', dedupe_key: KEY30, response: JSON.stringify({ error: 'http_502' }) };
    const withEmail = Object.assign({}, PATIENT, { email: 'p@gmail.com' });
    const r = await fb.maybeQueueSmsFallback(emailRow, withEmail, 'failed', { ok: false }, { queryOne: fakeQueryOne([waRow]), queueNotification: async (o) => { queued.push(o); return { ok: true }; } });
    assert.strictEqual(r.queued, true);
    assert.strictEqual(queued[0].dedupeKey, 'payment_reminder:30m:sms:' + ORDER + ':u-1');
    assert.strictEqual(queued[0].response.fallback_of, 'wa-3');
  });

  await check('C4: a WhatsApp row with no key gets sms_fallback:<its id> — one SMS per failed WhatsApp row', async () => {
    const queued = [];
    const row = { id: 'wa-4', channel: 'whatsapp', template: 'report_ready_patient', to_user_id: 'u-1', order_id: ORDER, dedupe_key: null, at: new Date(), response: '{}' };
    await fb.maybeQueueSmsFallback(row, PATIENT, 'failed', { outcome: 'unknown' }, { queryOne: fakeQueryOne([null]), queueNotification: async (o) => { queued.push(o); return { ok: true }; } });
    assert.strictEqual(queued[0].dedupeKey, 'sms_fallback:wa-4');
  });

  // ════ D ════
  const SMS_ROW = { id: 'sms-1', channel: 'sms', template: 'payment_reminder_30m', to_user_id: 'u-1', order_id: ORDER,
    response: JSON.stringify({ caseReference: 'TSH-2026-000020' }) };
  function smsProvider(over) {
    const sent = [];
    return Object.assign({
      sent,
      isSmsConfigured: () => true,
      sendSms: async (m) => { sent.push(m); return { ok: true, provider: 'twilio', sid: 'SM123', status: 'queued', price: null, segments: 2 }; },
    }, over || {});
  }

  await check('D1: SMS not configured → skipped sms_unconfigured, nothing queried, nothing thrown', async () => {
    const q = fakeQueryOne([]);
    const r = await fb.processSms(SMS_ROW, PATIENT, null, { provider: smsProvider({ isSmsConfigured: () => false }), queryOne: q, env: {} });
    assert.deepStrictEqual(r, { skipped: 'sms_unconfigured' });
    assert.strictEqual(q.calls.length, 0);
  });

  await check('D2: the allowlist is enforced at send time, and SMS honours the WhatsApp opt-out', async () => {
    const p = smsProvider();
    assert.deepStrictEqual(await fb.processSms(Object.assign({}, SMS_ROW, { template: 'order_assigned_doctor' }), PATIENT, null, { provider: p, queryOne: fakeQueryOne([]), env: {} }), { skipped: 'sms_not_allowlisted' });
    assert.deepStrictEqual(await fb.processSms(SMS_ROW, Object.assign({}, PATIENT, { notify_whatsapp: false }), null, { provider: p, queryOne: fakeQueryOne([]), env: {} }), { skipped: 'sms_opted_out' });
    assert.deepStrictEqual(await fb.processSms(SMS_ROW, Object.assign({}, PATIENT, { role: 'doctor' }), null, { provider: p, queryOne: fakeQueryOne([]), env: {} }), { skipped: 'sms_not_patient' });
    assert.strictEqual(p.sent.length, 0);
  });

  await check('D3: per-patient cap — the 4th SMS in 24 hours is skipped sms_patient_cap', async () => {
    const p = smsProvider();
    const r = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([{ n: 3 }]), env: {}, now: DAY });
    assert.deepStrictEqual(r, { skipped: 'sms_patient_cap' });
    assert.strictEqual(p.sent.length, 0);
  });

  await check('D4: global cap (SMS_DAILY_CAP) → skipped sms_cap and one quiet ops push keyed on the Cairo day', async () => {
    const pushes = [];
    const deps = (n) => ({ provider: smsProvider(), queryOne: fakeQueryOne([{ n: 0 }, { n }]), env: { SMS_DAILY_CAP: '5' },
      pushOpsEvent: async (o) => { pushes.push(o); return { sent: true }; }, now: new Date('2026-11-02T10:00:00Z') });
    assert.deepStrictEqual(await fb.processSms(SMS_ROW, PATIENT, null, deps(5)), { skipped: 'sms_cap' });
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].kind, 'sms_cap');
    assert.strictEqual(pushes[0].dedupeKey, '2026-11-02');
    assert.strictEqual(pushes[0].defaultMode, 'quiet');
    assert.strictEqual(fb.dailyCap({}), 100, 'default 100');
  });

  await check('D5: a send records the provider SID, price and segments; the Arabic body is reference + link only', async () => {
    const p = smsProvider();
    const r = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([{ n: 0 }, { n: 0 }]), env: {}, now: DAY });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sid, 'SM123');
    assert.strictEqual(r.segments, 2);
    assert.ok('price' in r);
    assert.strictEqual(p.sent.length, 1);
    assert.strictEqual(p.sent[0].to, '+201012345678');
    assert.strictEqual(p.sent[0].body, 'تشخيصة: حالتك TSH-2026-000020 مستنية الدفع: https://tashkheesa.com/portal/patient/pay/' + ORDER);
  });

  await check('D6: a provider failure is final (permanent) — an SMS is never retried', async () => {
    const p = smsProvider({ sendSms: async () => ({ ok: false, error: 'timeout', outcome: 'unknown' }) });
    const r = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([{ n: 0 }, { n: 0 }]), env: {}, now: DAY });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.permanent, true);
    assert.strictEqual(r.outcome, 'unknown');
  });

  await check('D7: quiet hours — at 03:00 Cairo the SMS waits for 09:00 (no send, no cap queries); at 09:05 it goes', async () => {
    const p = smsProvider(); const q = fakeQueryOne([{ n: 0 }, { n: 0 }]);
    const night = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: q, env: {}, now: new Date('2026-11-03T01:00:00Z') }); // 03:00 Cairo
    assert.deepStrictEqual(night, { deferUntil: '2026-11-03T07:00:00.000Z', reason: 'sms_quiet_hours' }, '09:00 Cairo the same morning');
    assert.strictEqual(p.sent.length, 0);
    assert.strictEqual(q.calls.length, 0, 'caps are counted when it is sent, not now');
    const morning = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([{ n: 0 }, { n: 0 }]), env: {}, now: new Date('2026-11-03T07:05:00Z') }); // 09:05
    assert.strictEqual(morning.ok, true);
    assert.strictEqual(p.sent.length, 1);
  });

  await check('D8: 21:30 and 22:30 Cairo wait for tomorrow 09:00; 20:30 still sends; summer time (UTC+3) is honoured', async () => {
    const p = smsProvider();
    const late = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([]), env: {}, now: new Date('2026-11-02T20:30:00Z') }); // 22:30 Cairo
    assert.strictEqual(late.deferUntil, '2026-11-03T07:00:00.000Z');
    const curfew = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([]), env: {}, now: new Date('2026-11-02T19:30:00Z') }); // 21:30 Cairo
    assert.strictEqual(curfew.deferUntil, '2026-11-03T07:00:00.000Z');
    const evening = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([{ n: 0 }, { n: 0 }]), env: {}, now: new Date('2026-11-02T18:30:00Z') }); // 20:30 Cairo
    assert.strictEqual(evening.ok, true, '20:30 is before the curfew');
    const july = await fb.processSms(SMS_ROW, PATIENT, null, { provider: p, queryOne: fakeQueryOne([]), env: {}, now: new Date('2026-07-10T00:30:00Z') }); // 03:30 Cairo (UTC+3)
    assert.strictEqual(july.deferUntil, '2026-07-10T06:00:00.000Z');
    assert.strictEqual(p.sent.length, 1, 'only the 20:30 send went out');
  });

  await check('D9: the worker re-queues a deferred SMS for 09:00 and leaves its payload and attempts alone', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'notification_worker.js'), 'utf8');
    assert.ok(/\} else if \(result\.deferUntil\) \{[\s\S]{0,600}UPDATE notifications SET status = \$1, retry_after = \$2 WHERE id = \$3', \[\s*'queued',\s*result\.deferUntil,/.test(src));
    const branch = src.slice(src.indexOf('} else if (result.deferUntil) {'), src.indexOf('} else if (result.skipped) {'));
    assert.ok(!/response|attempts/.test(branch.replace(/\/\/.*$/gm, '')), 'deferral touches neither response nor attempts');
  });

  // ════ E ════
  await check('E1: the adapter is off unless an account AND a sender are configured', async () => {
    assert.strictEqual(provider.isSmsConfigured({}), false);
    assert.strictEqual(provider.isSmsConfigured({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }), false, 'Verify creds alone do not turn SMS on');
    assert.strictEqual(provider.isSmsConfigured({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1' }), true);
    assert.strictEqual(provider.isSmsConfigured({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: 'Tashkheesa' }), true);
    assert.deepStrictEqual(await provider.sendSms({ to: '+201012345678', body: 'x' }, { env: {} }), { skipped: true, reason: 'sms_unconfigured' });
  });

  const CONF = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1' };
  function fakeTwilio(behaviour) {
    const calls = [];
    const factory = () => ({ messages: { create: async (p) => { calls.push(p); return behaviour(p); } } });
    factory.calls = calls;
    return factory;
  }

  await check('E2: outside production only SMS_TEST_RECIPIENTS can be texted (fail closed)', async () => {
    const tw = fakeTwilio(() => ({ sid: 'SM1' }));
    const blocked = await provider.sendSms({ to: '+201012345678', body: 'x' }, { env: Object.assign({ NODE_ENV: 'test' }, CONF), deps: { twilio: tw } });
    assert.deepStrictEqual(blocked, { skipped: true, reason: 'non_production_recipient_blocked' });
    const allowed = await provider.sendSms({ to: '+201012345678', body: 'x' }, { env: Object.assign({ NODE_ENV: 'test', SMS_TEST_RECIPIENTS: '201012345678' }, CONF), deps: { twilio: tw } });
    assert.strictEqual(allowed.ok, true);
    assert.strictEqual(tw.calls.length, 1);
    assert.strictEqual(tw.calls[0].messagingServiceSid, 'MG1');
  });

  await check('E3: a Twilio refusal is not_sent; a lost connection is unknown; a pre-connect error is not_sent', async () => {
    const env = Object.assign({ MODE: 'production' }, CONF);
    const refused = await provider.sendSms({ to: '+201012345678', body: 'x' }, { env, deps: { twilio: fakeTwilio(() => { const e = new Error('Invalid To'); e.status = 400; e.code = 21211; throw e; }) } });
    assert.strictEqual(refused.outcome, 'not_sent');
    const lost = await provider.sendSms({ to: '+201012345678', body: 'x' }, { env, deps: { twilio: fakeTwilio(() => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }) } });
    assert.strictEqual(lost.outcome, 'unknown');
    const never = await provider.sendSms({ to: '+201012345678', body: 'x' }, { env, deps: { twilio: fakeTwilio(() => { const e = new Error('connect'); e.code = 'ECONNREFUSED'; throw e; }) } });
    assert.strictEqual(never.outcome, 'not_sent');
  });

  await check('E4: the price and SID Twilio returns are carried back', async () => {
    const env = Object.assign({ MODE: 'production' }, CONF);
    const r = await provider.sendSms({ to: '+201012345678', body: 'x' }, { env, deps: { twilio: fakeTwilio(() => ({ sid: 'SM9', status: 'accepted', price: '-0.25', priceUnit: 'USD', numSegments: '2' })) } });
    assert.deepStrictEqual([r.ok, r.sid, r.price, r.priceUnit, r.segments, r.provider], [true, 'SM9', '-0.25', 'USD', 2, 'twilio']);
  });
})();
