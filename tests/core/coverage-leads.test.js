// tests/core/coverage-leads.test.js
//
// Part C (patient recovery, 2 Nov 2026) — "we don't open this specialty yet",
// without a database (tests/core/coverage-leads-db.test.js runs the SQL):
//   A. the triggers — the classifier unsure / naming a hidden specialty; the
//      "not listed" pick
//   B. createLead — own draft only, still a draft, a hidden specialty or
//      "other", ONE lead per draft, queued draft nudges cancelled
//   C. the offers — the open list, general reads priced by case_intake_pricing
//      and nothing else
//   D. "Notify waiting leads" — dry run, refused while hidden, type-to-confirm,
//      one claim per lead (a second run tells nobody)
//   E. the web panel — the brief's copy EN + AR, the three actions, no offer at
//      the locked tier, the confirmation once a lead exists
//   F. wiring

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'coverage-leads-test-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
};
async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const cl = require('../../src/services/coverage_leads');

const NEURO = { id: 'spec-neurology', name: 'Neurology', name_ar: 'المخ والأعصاب' };

// A tiny in-memory store standing in for orders / specialties / users /
// coverage_leads, answering only the statements coverage_leads.js issues.
function store(seed) {
  const s = Object.assign({ orders: [], specialties: [], users: [], leads: [], executes: [] }, seed || {});
  return {
    s,
    queryOne: async (sql, p) => {
      if (/FROM orders WHERE id = \$1 AND deleted_at IS NULL/.test(sql) && /UPPER/.test(sql)) return s.orders.find((o) => o.id === p[0] && String(o.status).toUpperCase() === 'DRAFT') || null;
      if (/FROM orders WHERE id = \$1/.test(sql)) return s.orders.find((o) => o.id === p[0]) || null;
      if (/FROM coverage_leads WHERE order_id = \$1/.test(sql)) return s.leads.find((l) => l.order_id === p[0]) || null;
      if (/FROM specialties WHERE id = \$1/.test(sql)) return s.specialties.find((x) => x.id === p[0]) || null;
      if (/SELECT phone FROM users/.test(sql)) return s.users.find((u) => u.id === p[0]) || null;
      if (/INSERT INTO coverage_leads/.test(sql)) {
        if (p[2] && s.leads.some((l) => l.order_id === p[2])) return null;
        const row = { id: p[0], patient_id: p[1], order_id: p[2], phone: p[3], wanted_specialty_id: p[4], wanted_text: p[5], lang: p[6], source: p[7], notified_at: null };
        s.leads.push(row); return row;
      }
      if (/UPDATE coverage_leads SET notified_at = NOW\(\) WHERE id = \$1 AND notified_at IS NULL/.test(sql)) {
        const l = s.leads.find((x) => x.id === p[0] && !x.notified_at); if (!l) return null; l.notified_at = new Date(); return { id: l.id };
      }
      throw new Error('unexpected queryOne: ' + sql.slice(0, 90));
    },
    queryAll: async (sql, p) => {
      if (/FROM coverage_leads cl LEFT JOIN users u/.test(sql)) {
        return s.leads.filter((l) => l.wanted_specialty_id === p[0] && !l.notified_at && !l.converted_order_id)
          .map((l) => { const u = s.users.find((x) => x.id === l.patient_id) || {}; return Object.assign({}, l, { email: u.email || null, user_phone: u.phone || null, user_lang: u.lang || null, role: 'patient' }); });
      }
      throw new Error('unexpected queryAll: ' + sql.slice(0, 90));
    },
    execute: async (sql, p) => { s.executes.push({ sql, p }); return { rowCount: 1 }; },
  };
}

console.log('\n🧭  coverage leads (Part C)\n');

(async () => {
  // ════ A ════
  await check('A1: the classifier unsure (under the floor, or no specialty) opens the panel by itself', () => {
    const vis = ['spec-cardiology', 'spec-internal-medicine'];
    assert.deepStrictEqual(cl.coverageTrigger({ classification: { specialty_id: 'spec-cardiology', confidence: 0.4 }, thresholds: { min: 0.55 }, visibleSpecialtyIds: vis }), { reason: 'low_confidence' });
    assert.deepStrictEqual(cl.coverageTrigger({ classification: { specialty_id: null, confidence: 0 }, visibleSpecialtyIds: vis }), { reason: 'no_prediction' });
  });

  await check('A2: a classification naming a hidden specialty (neurology) opens the panel on it', () => {
    assert.deepStrictEqual(cl.coverageTrigger({ classification: { specialty_id: 'spec-neurology', confidence: 0.97 }, visibleSpecialtyIds: ['spec-cardiology'] }),
      { reason: 'hidden_specialty', specialtyId: 'spec-neurology' });
  });

  await check('A3: a confident pick of an open specialty, or no classification yet → no trigger (the "not listed" link stays)', () => {
    assert.strictEqual(cl.coverageTrigger({ classification: { specialty_id: 'spec-cardiology', confidence: 0.9 }, visibleSpecialtyIds: ['spec-cardiology'] }), null);
    assert.strictEqual(cl.coverageTrigger({ classification: null, visibleSpecialtyIds: [] }), null);
  });

  // ════ B ════
  const seed = () => store({
    orders: [{ id: 'd-1', patient_id: 'p-1', status: 'draft' }, { id: 'd-2', patient_id: 'p-1', status: 'submitted' }],
    specialties: [Object.assign({ is_visible: false }, NEURO), { id: 'spec-cardiology', name: 'Cardiology', is_visible: true }],
    users: [{ id: 'p-1', phone: '+201012345678', email: null, lang: 'ar' }],
  });

  await check('B1: a lead on the patient\'s own draft is written once — the second call returns the first', async () => {
    const st = seed();
    const a = await cl.createLead({ patientId: 'p-1', orderId: 'd-1', wantedSpecialtyId: 'spec-neurology', source: 'web', lang: 'ar' }, { pg: st });
    const b = await cl.createLead({ patientId: 'p-1', orderId: 'd-1', wantedSpecialtyId: 'spec-neurology', source: 'web', lang: 'ar' }, { pg: st });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false);
    assert.strictEqual(b.lead.id, a.lead.id);
    assert.strictEqual(st.s.leads.length, 1);
    assert.strictEqual(a.lead.phone, '+201012345678', 'the number on the account, nothing typed');
  });

  await check('B2: leaving a lead cancels any draft-resume nudge still queued for that draft', async () => {
    const st = seed();
    await cl.createLead({ patientId: 'p-1', orderId: 'd-1', wantedSpecialtyId: 'other', wantedText: 'Neuro-ophthalmology', source: 'web', lang: 'en' }, { pg: st });
    const cancel = st.s.executes.find((e) => /UPDATE notifications SET status = 'skipped'/.test(e.sql));
    assert.ok(cancel && cancel.p[0] === 'draft_resume:d-1:%');
    assert.strictEqual(st.s.leads[0].wanted_specialty_id, null, '"other" stores no specialty id');
    assert.strictEqual(st.s.leads[0].wanted_text, 'Neuro-ophthalmology');
  });

  await check('B3: someone else\'s draft, a sent case, an OPEN specialty, an unknown one → refused', async () => {
    const st = seed();
    await assert.rejects(() => cl.createLead({ patientId: 'p-2', orderId: 'd-1', source: 'web' }, { pg: st }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(() => cl.createLead({ patientId: 'p-1', orderId: 'd-2', source: 'web' }, { pg: st }), (e) => e.code === 'NOT_DRAFT');
    await assert.rejects(() => cl.createLead({ patientId: 'p-1', orderId: 'd-1', wantedSpecialtyId: 'spec-cardiology', source: 'api' }, { pg: st }), (e) => e.code === 'SPECIALTY_OPEN');
    await assert.rejects(() => cl.createLead({ patientId: 'p-1', orderId: 'd-1', wantedSpecialtyId: 'spec-nope', source: 'api' }, { pg: st }), (e) => e.code === 'UNKNOWN_SPECIALTY');
    await assert.rejects(() => cl.createLead({ patientId: 'p-1', orderId: 'd-1', source: 'sms' }, { pg: st }), (e) => e.code === 'BAD_SOURCE');
    assert.strictEqual(st.s.leads.length, 0);
  });

  // ════ C ════
  await check('C1: general reads are priced by case_intake_pricing; one that is not bookable is left out', async () => {
    const calls = [];
    const pricing = {
      resolveAndPriceIntake: async (o) => {
        calls.push(o);
        if (o.serviceId === 'entry_read_pediatrics') throw new Error('SERVICE_NOT_BOOKABLE');
        return { service: { id: o.serviceId, name: 'Report read — one question', name_ar: 'قراءة تقرير — سؤال واحد', specialty_id: 'spec-internal-medicine' },
          resolvedSpecialtyId: 'spec-internal-medicine', charge: { egpBase: 750, isIntl: false } };
      },
    };
    const offers = await cl.reportReadOffers({ userId: 'p-1' }, { pricing });
    assert.deepStrictEqual(offers, [{ serviceId: 'entry_read_internal-medicine', specialtyId: 'spec-internal-medicine', name: 'Report read — one question', nameAr: 'قراءة تقرير — سؤال واحد', price: 750, currency: 'EGP' }]);
    assert.ok(calls.every((c) => c.urgencyTier === 'standard' && c.userId === 'p-1'), 'priced for this patient, standard tier');
  });

  await check('C2: an international patient sees the local price the submit would charge', async () => {
    const pricing = { resolveAndPriceIntake: async (o) => ({ service: { id: o.serviceId, name: 'X', specialty_id: 's' }, resolvedSpecialtyId: 's', charge: { egpBase: 4800, isIntl: true, displayPrice: 95, displayCurrency: 'GBP' } }) };
    const offers = await cl.reportReadOffers({ userId: 'p-uk' }, { pricing });
    assert.strictEqual(offers[0].price, 95); assert.strictEqual(offers[0].currency, 'GBP');
  });

  // ════ D ════
  function notifySeed(visible) {
    const st = store({
      specialties: [Object.assign({ is_visible: visible }, NEURO)],
      users: [{ id: 'p-1', phone: '+201012345678', email: null, lang: 'ar' }, { id: 'p-2', phone: '+201112345678', email: 'real.person@gmail.com', lang: 'en' }],
      orders: [{ id: 'd-1', patient_id: 'p-1', status: 'draft' }],
      leads: [
        { id: 'cl_1', patient_id: 'p-1', order_id: 'd-1', wanted_specialty_id: 'spec-neurology', lang: 'ar', notified_at: null },
        { id: 'cl_2', patient_id: 'p-2', order_id: null, wanted_specialty_id: 'spec-neurology', lang: 'en', notified_at: null },
      ],
    });
    // the specialty lookup with COALESCE(is_visible) AS is_visible
    const orig = st.queryOne;
    st.queryOne = async (sql, p) => (/COALESCE\(is_visible, true\) AS is_visible FROM specialties/.test(sql)
      ? (st.s.specialties.find((x) => x.id === p[0]) || null) : orig(sql, p));
    return st;
  }
  const deps = (st, queued) => ({
    pg: st,
    notify: { queueNotification: async (o) => { queued.push(o); return { ok: true }; } },
    draftResume: { mintToken: async () => ({ id: 'tokid12345', token: 'x' }) },
    recipientGuard: require('../../src/services/recipientGuard'),
  });

  await check('D1: the dry run counts and sends nothing', async () => {
    const st = notifySeed(true); const queued = [];
    const r = await cl.notifyWaitingLeads({ specialtyId: 'spec-neurology', dryRun: true }, deps(st, queued));
    assert.deepStrictEqual([r.ok, r.dryRun, r.count], [true, true, 2]);
    assert.strictEqual(queued.length, 0);
    assert.ok(st.s.leads.every((l) => !l.notified_at));
  });

  await check('D2: refused while the specialty is still hidden, and without the typed name', async () => {
    const queued = [];
    assert.strictEqual((await cl.notifyWaitingLeads({ specialtyId: 'spec-neurology', confirm: 'Neurology' }, deps(notifySeed(false), queued))).code, 'NOT_OPEN');
    assert.strictEqual((await cl.notifyWaitingLeads({ specialtyId: 'spec-neurology', confirm: 'neuro' }, deps(notifySeed(true), queued))).code, 'CONFIRM_MISMATCH');
    assert.strictEqual(queued.length, 0);
  });

  await check('D3: sends once per lead on the Part A ladder; a second run tells nobody', async () => {
    const st = notifySeed(true); const queued = [];
    const r = await cl.notifyWaitingLeads({ specialtyId: 'spec-neurology', confirm: 'neurology' }, deps(st, queued));
    assert.deepStrictEqual([r.ok, r.notified], [true, 2]);
    const byLead = {};
    queued.forEach((q) => { (byLead[q.dedupeKey] = byLead[q.dedupeKey] || []).push(q.channel); });
    assert.deepStrictEqual(byLead, { 'coverage_lead:cl_1': ['internal', 'whatsapp'], 'coverage_lead:cl_2': ['internal', 'whatsapp', 'email'] });
    const first = queued.find((q) => q.dedupeKey === 'coverage_lead:cl_1');
    assert.strictEqual(first.response.resume_token_id, 'tokid12345', 'the kept draft reopens');
    assert.strictEqual(first.response.specialtyName, 'المخ والأعصاب', 'named in the patient\'s language');
    assert.ok(queued.every((q) => q.template === 'coverage_lead_open'));
    const again = await cl.notifyWaitingLeads({ specialtyId: 'spec-neurology', confirm: 'Neurology' }, deps(st, queued));
    assert.deepStrictEqual([again.count, again.notified], [0, 0]);
    assert.strictEqual(queued.length, 5);
  });

  // ════ E ════
  const PANEL = path.join(ROOT, 'src/views/partials/patient/coverage_lead_panel.ejs');
  const render = (coverage, extra) => ejs.render(fs.readFileSync(PANEL, 'utf8'),
    Object.assign({ coverage, draftId: 'd-1', isAr: false, tier: 'manual', csrfField: () => '<input type="hidden" name="_csrf" value="tok">' }, extra || {}), { filename: PANEL }).replace(/\s+/g, ' ');
  const OFFER = { serviceId: 'entry_read_internal-medicine', specialtyId: 'spec-internal-medicine', name: 'Report read — one question', nameAr: 'قراءة تقرير — سؤال واحد', price: 750, currency: 'EGP' };
  const chosen = { lead: null, hidden: [NEURO], trigger: null, chosen: NEURO, wantedText: null, offers: [OFFER] };

  await check('E1: the brief\'s copy, EN and AR, with the three actions and the real price', () => {
    const en = render(chosen);
    assert.ok(en.indexOf('We don’t open Neurology yet. Leave your number and we’ll tell you first — or choose a related specialty that is open.') !== -1, en);
    assert.ok(/action="\/patient\/new-case\/coverage-lead"/.test(en) && /Tell me when it opens/.test(en));
    assert.ok(/Choose a related specialty/.test(en));
    assert.ok(/name="service_id" value="entry_read_internal-medicine"/.test(en) && /EGP 750/.test(en));
    assert.ok(/name="_csrf"/.test(en));
    const ar = render(chosen, { isAr: true });
    assert.ok(ar.indexOf('لسه ما فتحناش تخصص المخ والأعصاب. سيب رقمك وهنبلغك أول ما يفتح — أو اختار تخصص قريب متاح.') !== -1, ar);
  });

  await check('E1b: a panel the classifier opened records the lead as source "classifier"; a patient\'s own pick does not', async () => {
    assert.ok(/name="via" value="classifier"/.test(render(Object.assign({}, chosen, { viaClassifier: true }))));
    assert.ok(!/name="via"/.test(render(chosen)));
    const st = seed();
    const pg = Object.assign({}, st, { queryAll: async () => [Object.assign({ is_visible: false }, NEURO)] });
    const ctx = await cl.wizardContext({ draftId: 'd-1', userId: 'p-1', classification: { specialty_id: 'spec-neurology', confidence: 0.97 }, visibleSpecialtyIds: ['spec-cardiology'] }, { pg, pricing: { resolveAndPriceIntake: async () => { throw new Error('x'); } } });
    assert.strictEqual(ctx.viaClassifier, true);
    assert.strictEqual(ctx.chosen.id, 'spec-neurology', 'the hidden specialty the classification named');
    const own = await cl.wizardContext({ draftId: 'd-1', userId: 'p-1', classification: null, visibleSpecialtyIds: [], notListed: 'spec-neurology' }, { pg, pricing: { resolveAndPriceIntake: async () => { throw new Error('x'); } } });
    assert.strictEqual(own.viaClassifier, false);
    assert.ok(/source: b\.via === 'classifier' \? 'classifier' : 'web'/.test(read('src/routes/coverage_leads_web.js')));
  });

  await check('E2: at the locked tier the general read is not offered (step 3 would refuse it)', () => {
    assert.ok(!/entry_read_internal-medicine/.test(render(chosen, { tier: 'locked' })));
    assert.ok(/Tell me when it opens/.test(render(chosen, { tier: 'locked' })), 'the lead is still offered');
  });

  await check('E3: once a lead exists, a calm confirmation and no forms', () => {
    const html = render({ lead: { id: 'cl_1', wanted_specialty_id: 'spec-neurology' }, leadSpecialty: NEURO, hidden: [NEURO], trigger: null, chosen: null, offers: [] });
    assert.ok(/we will tell you first when Neurology opens/.test(html));
    assert.ok(!/<form/.test(html));
  });

  await check('E4: the "not listed" picker lists the hidden specialties and "Another specialty"; a trigger opens it', () => {
    const closed = render({ lead: null, hidden: [NEURO], trigger: null, chosen: null, offers: [] });
    assert.ok(/My specialty is not listed/.test(closed) && /<details style/.test(closed), 'closed by default');
    assert.ok(/value="spec-neurology"/.test(closed) && /value="other"/.test(closed));
    const open = render({ lead: null, hidden: [NEURO], trigger: { reason: 'low_confidence' }, chosen: null, offers: [] });
    assert.ok(/<details open/.test(open));
  });

  await check('E5: the whole wizard renders at step 3 with the panel, after the step-3 form, in both languages', async () => {
    const VIEW = path.join(ROOT, 'src', 'views', 'patient_new_case.ejs');
    const locals = (lang, coverage) => ({
      step: 3, lang, isAr: lang === 'ar', draftId: 'd-1',
      draft: { id: 'd-1', status: 'DRAFT', draft_step: 2 },
      user: { id: 'p-1', role: 'patient', name: 'P' }, files: [],
      specialties: [{ id: 'spec-cardiology', name: 'Cardiology', name_ar: 'أمراض القلب' }], services: [], pricing: null,
      specialtyRecommendation: null, classifierPending: false, coverage,
      tt: function (k, en, ar) { return lang === 'ar' ? ar : en; },
      csrfField: function () { return '<input type="hidden" name="_csrf" value="x">'; },
      cspNonce: 'n', thresholds: {}, step3Defaults: function () { return {}; },
    });
    const renderPage = (l) => new Promise((resolve, reject) => ejs.renderFile(VIEW, l, {}, (e, h) => e ? reject(e) : resolve(h)));
    for (const lang of ['en', 'ar']) {
      const html = await renderPage(locals(lang, chosen));
      const formEnd = html.indexOf('</form>', html.indexOf('id="step3-form"'));
      const panel = html.indexOf('id="coverage-panel"');
      assert.ok(panel > formEnd, lang + ': panel after the step-3 form');
      assert.ok(/action="\/patient\/new-case\/coverage-lead"/.test(html), lang + ': lead form');
    }
    const plain = await renderPage(locals('en', null));
    assert.ok(!/id="coverage-panel"/.test(plain), 'no context, no panel — the step renders as before');
  });

  // ════ F ════
  await check('F1: wiring — the panel outside the step-3 form; the routes mounted; the API ahead of the draft router', () => {
    const view = read('src/views/patient_new_case.ejs');
    const formEnd = view.indexOf('</form>', view.indexOf('id="step3-form"'));
    const inc = view.indexOf("include('partials/patient/coverage_lead_panel'");
    assert.ok(inc > formEnd, 'after the step-3 form closes');
    const server = read('src/server.js');
    assert.ok(/require\('\.\/routes\/coverage_leads_web'\)/.test(server) && /require\('\.\/routes\/superadmin_coverage'\)/.test(server));
    const api = read('src/routes/api_v1.js');
    assert.ok(api.indexOf("require('./api/coverage_leads')") < api.indexOf("require('./api/cases_draft')"));
  });

  await check('F2: the superadmin page renders the dry run and a type-to-confirm form, and refuses a hidden specialty', () => {
    const PAGE = path.join(ROOT, 'src/views/superadmin_coverage_leads.ejs');
    const html = ejs.render(fs.readFileSync(PAGE, 'utf8'), {
      user: { id: 'sa', role: 'superadmin', name: 'SA' }, lang: 'en',
      rows: [{ id: 'spec-neurology', name: 'Neurology', name_ar: 'المخ والأعصاب', is_visible: true, waiting: 3 }],
      preview: { ok: true, dryRun: true, count: 3, specialty: { id: 'spec-neurology', name: 'Neurology', is_visible: true } },
      result: null, error: null, csrfField: () => '', tt: (k, en) => en, sidebarBadges: {},
    }, { filename: PAGE }).replace(/\s+/g, ' ');
    assert.ok(/Dry run:<\/strong> 3 patient\(s\) would be told once/.test(html));
    assert.ok(/name="confirm"/.test(html) && /Type <strong>Neurology<\/strong> to send/.test(html));
  });

  await check('F2b: the WhatsApp notice names the specialty (the composer is handed specialtyName)', () => {
    const { getOpenClawBody } = require('../../src/notify/openclawTemplates');
    const en = getOpenClawBody('coverage_lead_open', 'en', { specialtyName: 'Neurology', link: 'https://tashkheesa.com/portal/patient/resume/x' });
    const ar = getOpenClawBody('coverage_lead_open', 'ar', { specialtyName: 'المخ والأعصاب', specialtyNameAr: 'المخ والأعصاب', link: 'https://tashkheesa.com/r/x' });
    assert.ok(/^Tashkheesa: Neurology is now open\./.test(en), en);
    assert.ok(/تخصص المخ والأعصاب فتح/.test(ar), ar);
  });

  await check('F3: the attention kind and the ops catalogue carry coverage_lead (quiet, Arabic label)', () => {
    const na = require('../../src/services/needs_attention');
    assert.ok(na.ESCALATING_KINDS.indexOf('coverage_lead') !== -1);
    const prefs = require('../../src/services/ops_push_prefs');
    const k = prefs.KIND_CATALOGUE.find((x) => x.kind === 'coverage_lead');
    assert.ok(k && k.def === 'quiet' && /[؀-ۿ]/.test(k.ar));
  });
})();
