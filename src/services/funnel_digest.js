'use strict';

// services/funnel_digest.js — funnel step counts + a 09:00 Cairo WhatsApp
// digest to the founder (27 Sep 2026).
//
// Steps and where each number comes from:
//   start_view     /start + /ar/start page views      funnel_daily_counts (bumped here)
//   start_view_meta  … of which utm_source=meta       funnel_daily_counts
//   register_view  GET /register                      funnel_daily_counts
//   signups        users (role patient) created       users
//   drafts         wizard/app cases started           orders_active
//   uploaded       … of those, got past Documents     orders_active.draft_step >= 2
//   submitted      … of those, submitted              status <> DRAFT
//   paid           payments recorded that day         paid_at
//   delivered      reports delivered that day         completed_at  (6 Oct: Command digest)
// Staff/test accounts (@tashkheesa.com, @shifaegypt.com) are excluded.
//
// Page views are de-duplicated per visitor per day in memory (a hash of IP +
// user agent — never stored) and bots/link-preview crawlers are skipped, so a
// refresh or Meta's preview fetch does not inflate the top of the funnel.

const crypto = require('crypto');
const { queryAll, queryOne, execute } = require('../pg');

const STEPS = new Set(['start_view', 'start_view_meta', 'services_view', 'services_view_meta', 'register_view', 'start_cta', 'start_wa', 'wa_redirect']);
// Per-campaign split (2 Oct 2026): '<page>_view@<utm_campaign>' so each ad's landing
// views can be told apart. Slug is sanitised and capped; anything else is rejected.
const CAMPAIGN_STEP = /^(start|services)_view@[a-z0-9][a-z0-9_-]{0,39}$/;
const META_SRC = new Set(['meta', 'facebook', 'instagram', 'fb', 'ig']);
function campaignSlug(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|preview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|node-fetch|axios/i;
const SKIP_EMAIL_SQL = "COALESCE(u.email,'') !~* '@(tashkheesa\\.com|shifaegypt\\.com)$'";
const LAUNCH_DAY = '2026-09-25';

let seenDay = '';
let seen = new Set();
const SEEN_CAP = 50000;

function cairoDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
}
function cairoHour(now) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).format(now || new Date());
  return Number(h) % 24;
}

function isBot(ua) {
  const s = String(ua || '');
  return !s || BOT_UA.test(s);
}

/**
 * Count one page view for `step`. Fire-and-forget: synchronous, never throws,
 * never awaited by the request.
 */
function bumpFunnelCount(step, req) {
  try {
    if (!STEPS.has(step) && !CAMPAIGN_STEP.test(step)) return;
    const ua = req && req.get ? req.get('user-agent') : '';
    if (req && isBot(ua)) return;
    const day = cairoDay();
    if (day !== seenDay) { seenDay = day; seen = new Set(); }
    if (req) {
      const ip = String((req.ip || (req.headers && req.headers['x-forwarded-for']) || '')).split(',')[0].trim();
      const key = crypto.createHash('sha1').update(step + '|' + ip + '|' + ua).digest('hex');
      if (seen.has(key)) return;
      if (seen.size < SEEN_CAP) seen.add(key);
    }
    execute(
      `INSERT INTO funnel_daily_counts (day, step, n, updated_at)
       VALUES ($1::date, $2, 1, NOW())
       ON CONFLICT (day, step) DO UPDATE SET n = funnel_daily_counts.n + 1, updated_at = NOW()`,
      [day, step]
    ).catch(function () { /* analytics never blocks a page */ });
  } catch (_) { /* never throw into a request */ }
}

/**
 * Bump a landing-page view for `page` ('start' | 'services'): the total, the
 * Meta sub-count when utm_source is a Meta source, and the per-campaign count
 * when utm_campaign is present.
 */
function bumpLandingView(page, req) {
  if (page !== 'start' && page !== 'services') return;
  bumpFunnelCount(page + '_view', req);
  const q = (req && req.query) || {};
  if (META_SRC.has(String(q.utm_source || '').toLowerCase())) bumpFunnelCount(page + '_view_meta', req);
  const c = campaignSlug(q.utm_campaign);
  if (c) bumpFunnelCount(page + '_view@' + c, req);
}

/** Kept for callers that predate bumpLandingView. */
function bumpStartView(req) { bumpLandingView('start', req); }

/**
 * Counts for one Cairo day (YYYY-MM-DD). Each query is independent so one
 * failure yields a '?' rather than no digest at all.
 */
async function computeFunnel(day) {
  const out = { day };
  const bounds = `($1::date)::timestamp AT TIME ZONE 'Africa/Cairo'`;
  const boundsEnd = `($1::date + 1)::timestamp AT TIME ZONE 'Africa/Cairo'`;
  async function one(key, sql, params) {
    try {
      const r = await queryOne(sql, params || [day]);
      out[key] = r ? Number(r.n || 0) : 0;
      if (r && r.amount !== undefined) out[key + '_amount'] = Number(r.amount || 0);
    } catch (e) {
      out[key] = null;
      console.error('[funnel-digest] ' + key + ' failed', e && e.message);
    }
  }
  try {
    const rows = await queryAll('SELECT step, n FROM funnel_daily_counts WHERE day = $1::date', [day]);
    for (const r of rows) out[r.step] = Number(r.n || 0);
  } catch (e) { console.error('[funnel-digest] counts failed', e && e.message); }

  // users.created_at is timestamp WITHOUT time zone, stored UTC.
  await one('signups',
    `SELECT COUNT(*)::int AS n FROM users u
      WHERE u.role = 'patient' AND ${SKIP_EMAIL_SQL}
        AND u.created_at >= ((${bounds}) AT TIME ZONE 'UTC')
        AND u.created_at <  ((${boundsEnd}) AT TIME ZONE 'UTC')`);
  const cohort = `FROM orders_active o JOIN users u ON u.id = o.patient_id
      WHERE ${SKIP_EMAIL_SQL}
        AND COALESCE(o.source,'') IN ('patient_wizard_v2','patient_app_v1')
        AND o.created_at >= ${bounds} AND o.created_at < ${boundsEnd}`;
  await one('drafts', `SELECT COUNT(*)::int AS n ${cohort}`);
  await one('uploaded', `SELECT COUNT(*)::int AS n ${cohort}
        AND (COALESCE(o.draft_step,0) >= 2 OR UPPER(COALESCE(o.status,'')) <> 'DRAFT')`);
  await one('submitted', `SELECT COUNT(*)::int AS n ${cohort}
        AND UPPER(COALESCE(o.status,'')) <> 'DRAFT'`);
  await one('paid',
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(o.price),0)::int AS amount
       FROM orders_active o JOIN users u ON u.id = o.patient_id
      WHERE ${SKIP_EMAIL_SQL} AND o.payment_status = 'paid'
        AND o.paid_at >= ${bounds} AND o.paid_at < ${boundsEnd}`);
  // 6 Oct 2026 — reports delivered that day, for the Command digest push.
  // completed_at is what every delivery path stamps (services/business_pulse.js
  // reads the same column); practice and demo cases are not deliveries.
  await one('delivered',
    `SELECT COUNT(*)::int AS n
       FROM orders_active o JOIN users u ON u.id = o.patient_id
      WHERE ${SKIP_EMAIL_SQL}
        AND COALESCE(o.is_practice,false) = false
        AND COALESCE(o.source,'') NOT IN ('practice_seed','demo_appreview')
        AND o.completed_at >= ${bounds} AND o.completed_at < ${boundsEnd}`);
  return out;
}

async function computeSinceLaunch() {
  const out = {};
  try {
    const r = await queryOne(
      `SELECT
         (SELECT COUNT(*)::int FROM users u WHERE u.role='patient' AND ${SKIP_EMAIL_SQL}
            AND u.created_at >= (($1::date)::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC') AS signups,
         (SELECT COUNT(*)::int FROM orders_active o JOIN users u ON u.id=o.patient_id
           WHERE ${SKIP_EMAIL_SQL} AND UPPER(COALESCE(o.status,'')) <> 'DRAFT'
             AND o.created_at >= ($1::date)::timestamp AT TIME ZONE 'Africa/Cairo') AS submitted,
         (SELECT COUNT(*)::int FROM orders_active o JOIN users u ON u.id=o.patient_id
           WHERE ${SKIP_EMAIL_SQL} AND o.payment_status='paid'
             AND o.paid_at >= ($1::date)::timestamp AT TIME ZONE 'Africa/Cairo') AS paid`,
      [LAUNCH_DAY]
    );
    Object.assign(out, r || {});
  } catch (e) { console.error('[funnel-digest] since-launch failed', e && e.message); }
  return out;
}

function fmt(n) { return (n === null || n === undefined) ? '?' : String(n); }
function pct(a, b) {
  if (!b || a === null || a === undefined) return '';
  return ' (' + Math.round((a / b) * 100) + '%)';
}

function formatDigest(f, since) {
  const d = new Date(f.day + 'T12:00:00Z');
  const label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const views = f.start_view || 0;
  const lines = [
    'Tashkheesa funnel · ' + label + ' (Cairo)',
    '',
    'Landing /start views: ' + fmt(views) + (f.start_view_meta ? ' (Meta ' + f.start_view_meta + ')' : ''),
    'Services page views: ' + fmt(f.services_view || 0) + (f.services_view_meta ? ' (Meta ' + f.services_view_meta + ')' : ''),
    'Taps on Start: ' + fmt(f.start_cta || 0) + pct(f.start_cta || 0, views) + ' · WhatsApp taps: ' + fmt(f.start_wa || 0),
    'WhatsApp ad clicks: ' + fmt(f.wa_redirect || 0),
    'Register page views: ' + fmt(f.register_view || 0),
    'Signups: ' + fmt(f.signups) + pct(f.signups, f.register_view),
    'Cases started: ' + fmt(f.drafts) + pct(f.drafts, f.signups),
    'Files uploaded: ' + fmt(f.uploaded) + pct(f.uploaded, f.drafts),
    'Submitted: ' + fmt(f.submitted) + pct(f.submitted, f.uploaded),
    'Paid: ' + fmt(f.paid) + (f.paid_amount ? ' · EGP ' + Number(f.paid_amount).toLocaleString('en-US') : ''),
  ];
  if (f.delivered !== undefined) lines.push('Reports delivered: ' + fmt(f.delivered));
  const camps = Object.keys(f).filter(function (k) { return k.indexOf('_view@') !== -1; }).sort();
  if (camps.length) {
    lines.push('', 'By ad campaign (landing views):');
    camps.forEach(function (k) { lines.push('  ' + k.replace('_view@', ' · ') + ': ' + fmt(f[k])); });
  }
  if (since && (since.signups !== undefined)) {
    lines.push('', 'Since launch: ' + fmt(since.signups) + ' signups · ' + fmt(since.submitted) + ' submitted · ' + fmt(since.paid) + ' paid');
  }
  lines.push('', 'Views are unique visitors per day, bots excluded. Staff/test accounts excluded.');
  return lines.join('\n');
}

function previousCairoDay(now) {
  const today = cairoDay(now);
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The body of the daily Command push. Pure: one line a founder can read on a
 * lock screen — what is waiting, what is broken, what happened yesterday.
 * A count that could not be read is shown as '?', never as 0.
 */
function formatOpsDigest(o) {
  const n = (v) => (v === null || v === undefined) ? '?' : String(v);
  const parts = [];
  parts.push(n(o.attentionOpen) + ' waiting' + (o.attentionLoud ? ' (' + o.attentionLoud + ' urgent)' : ''));
  const checks = [];
  if (o.checksFailing === null || o.checksFailing === undefined) checks.push('checks ?');
  else {
    if (o.checksFailing) checks.push(o.checksFailing + ' failing');
    if (o.checksStale) checks.push(o.checksStale + ' stale');
    if (!checks.length) checks.push('all checks ok');
  }
  parts.push(checks.join(', '));
  parts.push('yesterday ' + n(o.paid) + ' paid, ' + n(o.delivered) + ' delivered');
  return parts.join(' · ');
}

/**
 * 6 Oct 2026 (watchtower) — the one quiet push a day.
 *
 * Open attention items, failing and stale checks, yesterday's paid and
 * delivered counts. Sent from the same once-a-day claim as the WhatsApp funnel
 * digest rather than a second scheduler, as kind `daily_digest` (quiet), and
 * it opens the System screen (data.screen = 'system').
 *
 * Each number is read on its own, so one failing source shows a '?' instead
 * of costing the whole digest. Never throws.
 */
async function pushOpsDigest(day, f, deps) {
  const d = deps || {};
  const o = { paid: f ? f.paid : null, delivered: f ? f.delivered : null,
              attentionOpen: null, attentionLoud: 0, checksFailing: null, checksStale: 0 };
  try {
    const na = d.attention || require('./needs_attention');
    const items = (await na.listAttention({ includeHidden: false })) || [];
    o.attentionOpen = items.length;
    o.attentionLoud = items.filter((i) => na.levelFor(i.kind) === 'loud').length;
  } catch (e) { console.error('[funnel-digest] attention count failed', e && e.message); }
  try {
    const c = await (d.digestCounts || require('./system_checks').digestCounts)();
    o.checksFailing = c.failing; o.checksStale = c.stale;
  } catch (e) { console.error('[funnel-digest] check counts failed', e && e.message); }
  try {
    const push = d.pushOpsEvent || require('./ops_push').pushOpsEvent;
    const r = await push({
      kind: 'daily_digest',
      dedupeKey: day,
      title: 'Daily digest',
      body: formatOpsDigest(o),
      data: { screen: 'system', day: day },
      defaultMode: 'quiet',
    });
    return { pushed: !!(r && r.sent), counts: o };
  } catch (e) {
    console.error('[funnel-digest] digest push failed', e && e.message);
    return { pushed: false, counts: o };
  }
}

/**
 * Runs every 15 min; sends once per Cairo day at/after 09:00. The claim row
 * makes it once-only across restarts and instances.
 *
 * Two deliveries share that one claim: the WhatsApp funnel digest to the
 * founder (as before) and the quiet Command push above. They are independent
 * — a WhatsApp failure does not stop the push, and the reverse.
 */
async function runFunnelDigest(opts) {
  const o = opts || {};
  const now = o.now || new Date();
  if (!o.force && cairoHour(now) < 9) return { ok: true, skipped: 'before_9' };
  const today = cairoDay(now);
  if (!o.force) {
    const claim = await queryOne(
      `INSERT INTO funnel_daily_counts (day, step, n, updated_at)
       VALUES ($1::date, '__digest_sent', 1, NOW())
       ON CONFLICT (day, step) DO NOTHING
       RETURNING day`,
      [today]
    );
    if (!claim) return { ok: true, skipped: 'already_sent' };
  }
  const day = o.day || previousCairoDay(now);
  const f = await computeFunnel(day);
  const since = await computeSinceLaunch();
  const text = formatDigest(f, since);
  let r = null;
  try {
    const send = o.sendFounder || require('./founder_whatsapp').sendFounderWhatsApp;
    r = await send(text, { template: 'founder_funnel_digest', ref: 'funnel:' + day });
  } catch (e) {
    console.error('[funnel-digest] WhatsApp send failed', e && e.message);
    r = { sent: 0, failed: 1 };
  }
  const ops = await pushOpsDigest(day, f, o.opsDigestDeps);
  return { ok: true, day, sent: r && r.sent, failed: r && r.failed, text, opsPush: ops };
}

module.exports = {
  bumpFunnelCount, bumpStartView, bumpLandingView, computeFunnel, formatDigest, runFunnelDigest,
  formatOpsDigest, pushOpsDigest,
  previousCairoDay, cairoDay, isBot,
};
