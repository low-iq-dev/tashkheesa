// tests/core/cases-intake-oncology-vip.test.js
//
// A7/S1 follow-up, decided by Ziad 2026-09-21: there is no 24-hour tier and
// never was. slaConfigForTestType gave every oncology intake a live
// sla_type 'priority_24h' / sla_hours 24 — a fourth tier outside
// Standard 48h / VIP 18h / Urgent 4h. The comment's intent was "tighter than
// standard", and the real tier that means that is VIP: 18 hours, written with
// the canonical tier value the rest of the codebase uses ('vip'), not a new
// string. The non-oncology branch keeps the stored-enum name 'standard_72h'
// (which really returns 48h) — renaming stored enum values touches historical
// rows, needs a migration, and is Batch B ledger work.
//
// What this file pins, driving the REAL POST /intake handler (plucked off
// router.stack, fake pg client, hermetic — no DATABASE_URL):
//   (1) an oncology intake writes orders.sla_hours = 18 and
//       cases.sla_type = 'vip', the cases.sla_deadline it derives is 18 hours
//       out, and 'priority_24h' appears nowhere in what is written;
//   (2) a non-oncology intake (ct_mri) still writes 48 / 'standard_72h' —
//       the retained legacy enum value, unchanged until the Batch B rename.
//
// Connected copy fixes (Ziad, 2026-09-21, same ruling family):
//   (3) the intake response promises no committed hour — a lead form carries
//       no figure at all (it used to say "within 24 hours");
//   (4) notifyCaseReceived is passed the case's REAL window (slaCfg.sla_hours)
//       — without the third argument the email hardcodes "within 48 hours",
//       wrong for an oncology lead on an 18h SLA and inconsistent with the
//       on-screen message;
//   (5) the real emailService.notifyCaseReceived, rendered through the
//       injected test transporter: 18h states "within 18 hours" + the VIP
//       band, 48h states its window with no priority band, and the no-arg
//       fallback is pinned at "within 48 hours" — the hazard (4) exists to
//       avoid. This email is EN-only by design (intake writes language 'en');
//       there is no Arabic variant of it, and the bilingual case-submitted
//       .hbs templates print a dynamic {{slaHours}}, no hardcoded figure.

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🧪 cases_intake — oncology is the real VIP tier (18h), not a 24h fourth tier\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const R = (p) => require.resolve(path.join(SRC, p));
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Exported promise: the runner awaits it (2026-08-16 serialisation), so the
// require.cache fakes below are restored before the next test file loads.
module.exports = (async function run() {
  const DB = R('db.js');
  const LOGGER = R('logger.js');
  const EMAIL = R('services/emailService.js');
  const ANALYTICS = R('services/analytics.js');
  const INTAKE = R('routes/api/cases_intake.js');
  const swapped = [DB, LOGGER, EMAIL, ANALYTICS, INTAKE];
  const saved = {};
  for (const p of swapped) saved[p] = require.cache[p];
  const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };
  const fakeModule = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

  // Recording fake pg client — answers exactly the existing-patient path:
  // BEGIN → SELECT user → enrichment UPDATE → orders INSERT → CREATE SEQUENCE
  // → nextval → cases INSERT → COMMIT.
  const rec = { queries: [], emails: [] };
  const client = {
    query: async (sql, params) => {
      const s = norm(sql);
      rec.queries.push({ sql: s, params: params || [] });
      // (launch eve 2026-09-24: the lookup also reads users.lang for T2.)
      if (/^SELECT id(, lang(, lang_chosen_at)?)? FROM users WHERE LOWER\(email\)/.test(s)) return { rows: [{ id: 'user-1' }] };
      if (/^SELECT nextval/.test(s)) return { rows: [{ n: 7 }] };
      return { rows: [], rowCount: 1 };
    },
    release: function () {},
  };
  fakeModule(DB, { pool: { connect: async () => client } });
  fakeModule(LOGGER, { logErrorToDb: function () {} });
  fakeModule(EMAIL, {
    notifyCaseReceived: async function (patient, referenceId, slaHours) {
      rec.emails.push({ patient: patient, referenceId: referenceId, slaHours: slaHours });
    },
  });
  fakeModule(ANALYTICS, { captureSignup: function () {} });

  let handler = null;
  try {
    delete require.cache[INTAKE];
    const router = require(INTAKE);
    const layer = router.stack.find((l) => l.route && l.route.path === '/intake' && l.route.methods.post);
    handler = layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
    if (!handler) throw new Error('POST /intake not on router.stack');
    t.pass('(0) POST /intake handler plucked off router.stack');
  } catch (e) {
    t.fail('(0) POST /intake handler plucked off router.stack', e);
    restore();
    return;
  }

  async function intake(test_type) {
    rec.queries = [];
    rec.emails = [];
    let status = 200, body = null;
    const req = {
      body: { full_name: 'Test Lead', email: 'lead@example.com', test_type: test_type },
      originalUrl: '/api/cases/intake',
      method: 'POST',
    };
    const res = {
      status: function (c) { status = c; return this; },
      json: function (b) { body = b; return this; },
    };
    await handler(req, res);
    return {
      status: status,
      body: body,
      orders: rec.queries.find((q) => /^INSERT INTO orders/.test(q.sql)),
      cases: rec.queries.find((q) => /^INSERT INTO cases/.test(q.sql)),
      queries: rec.queries.slice(),
      email: rec.emails[0] || null,
    };
  }

  try {
    // ═══ (1) oncology → the real VIP tier ════════════════════════════════
    await (async function oncology() {
      const r = await intake('oncology');
      const why = (function () {
        if (r.status !== 200 || !r.body || r.body.success !== true) {
          return 'intake did not succeed: status ' + r.status + ' body ' + JSON.stringify(r.body);
        }
        if (!r.orders) return 'no orders INSERT captured';
        if (!r.cases) return 'no cases INSERT captured';
        const hours = r.orders.params[6];
        if (hours !== 18) return 'orders.sla_hours is ' + hours + ', wanted 18 (VIP) — 24 is not a tier';
        const slaType = r.cases.params[2];
        if (slaType !== 'vip') return "cases.sla_type is '" + slaType + "', wanted the canonical 'vip', not a new enum string";
        const deadline = new Date(r.cases.params[3]).getTime();
        const wanted = Date.now() + 18 * 3600 * 1000;
        if (!(Math.abs(deadline - wanted) < 5 * 60 * 1000)) {
          return 'cases.sla_deadline is not 18 hours out: ' + r.cases.params[3];
        }
        const leaked = r.queries.some((q) =>
          /priority_24h/.test(q.sql) || q.params.some((p) => String(p).indexOf('priority_24h') !== -1));
        if (leaked) return "'priority_24h' is still written somewhere on the oncology path";
        return null;
      })();
      if (why) t.fail('(1) oncology intake writes VIP 18h with the canonical tier value', new Error(why));
      else t.pass('(1) oncology intake writes VIP 18h with the canonical tier value');
    })();

    // ═══ (2) non-oncology untouched (the Batch B boundary) ═══════════════
    await (async function ctMri() {
      const r = await intake('ct_mri');
      const why = (function () {
        if (r.status !== 200) return 'intake did not succeed: status ' + r.status;
        if (!r.orders || !r.cases) return 'INSERTs not captured';
        if (r.orders.params[6] !== 48) return 'orders.sla_hours is ' + r.orders.params[6] + ', wanted 48';
        if (r.cases.params[2] !== 'standard_72h') {
          return "cases.sla_type is '" + r.cases.params[2] + "' — the stored-enum rename is Batch B; keep 'standard_72h' until the migration";
        }
        return null;
      })();
      if (why) t.fail('(2) ct_mri intake still writes 48h / the retained standard_72h enum value', new Error(why));
      else t.pass('(2) ct_mri intake still writes 48h / the retained standard_72h enum value');
    })();

    // ═══ (3) the lead-form response commits to no hour ═══════════════════
    await (async function noFigure() {
      const r = await intake('oncology');
      const msg = (r.body && r.body.message) || '';
      const why = (function () {
        if (r.status !== 200 || !msg) return 'intake did not succeed: status ' + r.status;
        if (/[0-9٠-٩]/.test(msg)) {
          return 'the response message carries a figure: "' + msg + '" — no committed hour on a lead form (Ziad 2026-09-21)';
        }
        return null;
      })();
      if (why) t.fail('(3) the intake response promises no committed hour', new Error(why));
      else t.pass('(3) the intake response promises no committed hour');
    })();

    // ═══ (4) the email is told the case's real window ════════════════════
    await (async function emailWindow() {
      const onc = await intake('oncology');
      const std = await intake('ct_mri');
      const why = (function () {
        if (!onc.email) return 'notifyCaseReceived was not called on the oncology path';
        if (onc.email.slaHours !== 18) {
          return 'oncology email got slaHours=' + onc.email.slaHours +
            ', wanted 18 — without it the email hardcodes "within 48 hours"';
        }
        if (onc.email.referenceId !== (onc.body && onc.body.reference_id)) {
          return 'the email reference does not match the response reference';
        }
        if (!std.email) return 'notifyCaseReceived was not called on the ct_mri path';
        if (std.email.slaHours !== 48) return 'ct_mri email got slaHours=' + std.email.slaHours + ', wanted 48';
        return null;
      })();
      if (why) t.fail('(4) notifyCaseReceived is passed the case\'s real window', new Error(why));
      else t.pass('(4) notifyCaseReceived is passed the case\'s real window');
    })();
  } finally {
    restore();
  }

  // ═══ (5) the real email states the real window, and the band names the
  // tier. Pins emailService.notifyCaseReceived's EXISTING contract — the
  // function is unchanged; the production fix is the caller passing slaHours
  // in (4). Uses the guard test's injection pattern: fresh require, mocked MX
  // (only tashkheesa.com resolves), recorded transporter, fake pool. ═══════
  await (async function renderedEmail() {
    const GUARD = R('services/recipientGuard.js');
    const ENV_KEYS = ['EMAIL_ENABLED', 'RESEND_API_KEY', 'EMAIL_GUARD_STRICT'];
    const envSaved = {};
    for (const k of ENV_KEYS) envSaved[k] = process.env[k];
    process.env.EMAIL_ENABLED = 'true';
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_GUARD_STRICT = 'true';
    delete require.cache[GUARD];
    delete require.cache[EMAIL];
    let guard = null, emailService = null;
    try {
      guard = require(GUARD);
      emailService = require(EMAIL);
      guard._setMxResolver(async function (domain) {
        if (domain === 'tashkheesa.com') return [{ exchange: 'mx.tashkheesa.com', priority: 10 }];
        const err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
      });
      guard._clearMxCache();
      const sent = [];
      emailService._setTestTransporter({
        sendMail: async function (opts) {
          sent.push(opts);
          return { messageId: 'fake-' + sent.length, accepted: [opts.to], rejected: [] };
        },
        verify: async function () { return true; },
      });
      emailService._setTestPool({ query: async function () { return { rows: [] }; } });

      const pt = { email: 'lead@tashkheesa.com', name: 'Lead' };
      await emailService.notifyCaseReceived(pt, 'TSH-2026-000001', 18);
      await emailService.notifyCaseReceived(pt, 'TSH-2026-000002', 48);
      await emailService.notifyCaseReceived(pt, 'TSH-2026-000003');
      const why = (function () {
        if (sent.length !== 3) return 'expected 3 sends through the transporter, saw ' + sent.length;
        const vip = sent[0], std = sent[1], bare = sent[2];
        if (!/within 18 hours/.test(vip.text)) return 'the 18h email does not state its real window: ' + vip.text;
        if (!/marked VIP/.test(vip.text)) return 'the 18h email band does not name VIP: ' + vip.text;
        if (/48/.test(vip.text)) return 'the 18h email still mentions 48: ' + vip.text;
        if (!/within 48 hours/.test(std.text)) return 'the 48h email does not state its window: ' + std.text;
        if (/VIP|URGENT/.test(std.text)) return 'the 48h email wrongly claims a priority band: ' + std.text;
        if (!/within 48 hours/.test(bare.text)) {
          return 'the no-arg fallback changed — pinned at "within 48 hours" as the hazard the caller must not rely on';
        }
        return null;
      })();
      if (why) t.fail('(5) the rendered email states the real window and the band names the tier', new Error(why));
      else t.pass('(5) the rendered email states the real window and the band names the tier');
    } catch (e) {
      t.fail('(5) the rendered email states the real window and the band names the tier', e);
    } finally {
      try {
        if (emailService) {
          emailService._setTestTransporter(null);
          emailService._setTestPool(null);
          emailService._resetTransporter();
        }
      } catch (_) { /* leave nothing armed */ }
      for (const k of ENV_KEYS) {
        if (envSaved[k] === undefined) delete process.env[k];
        else process.env[k] = envSaved[k];
      }
      delete require.cache[GUARD];
      delete require.cache[EMAIL];
    }
  })();
})();
