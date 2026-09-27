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
// Staff/test accounts (@tashkheesa.com, @shifaegypt.com) are excluded.
//
// Page views are de-duplicated per visitor per day in memory (a hash of IP +
// user agent — never stored) and bots/link-preview crawlers are skipped, so a
// refresh or Meta's preview fetch does not inflate the top of the funnel.

const crypto = require('crypto');
const { queryAll, queryOne, execute } = require('../pg');

const STEPS = new Set(['start_view', 'start_view_meta', 'register_view']);
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
    if (!STEPS.has(step)) return;
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

/** Bump the /start view (+ the Meta sub-count when utm_source=meta). */
function bumpStartView(req) {
  bumpFunnelCount('start_view', req);
  const src = String((req && req.query && req.query.utm_source) || '').toLowerCase();
  if (src === 'meta' || src === 'facebook' || src === 'instagram' || src === 'fb' || src === 'ig') {
    bumpFunnelCount('start_view_meta', req);
  }
}

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
    'Register page views: ' + fmt(f.register_view || 0),
    'Signups: ' + fmt(f.signups) + pct(f.signups, f.register_view),
    'Cases started: ' + fmt(f.drafts) + pct(f.drafts, f.signups),
    'Files uploaded: ' + fmt(f.uploaded) + pct(f.uploaded, f.drafts),
    'Submitted: ' + fmt(f.submitted) + pct(f.submitted, f.uploaded),
    'Paid: ' + fmt(f.paid) + (f.paid_amount ? ' · EGP ' + Number(f.paid_amount).toLocaleString('en-US') : ''),
  ];
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
 * Runs every 15 min; sends once per Cairo day at/after 09:00. The claim row
 * makes it once-only across restarts and instances.
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
  const send = o.sendFounder || require('./founder_whatsapp').sendFounderWhatsApp;
  const r = await send(text, { template: 'founder_funnel_digest', ref: 'funnel:' + day });
  return { ok: true, day, sent: r && r.sent, failed: r && r.failed, text };
}

module.exports = {
  bumpFunnelCount, bumpStartView, computeFunnel, formatDigest, runFunnelDigest,
  previousCairoDay, cairoDay, isBot,
};
