'use strict';

// src/middleware/api_rate_tally.js
//
// 2026-10-26 — which requests is a signed-in user's device actually sending?
// The owner's phone (patient app, build 15) exhausted its own per-user bucket
// (600 / 15 min) and showed "We're busy" on Messages, and nothing on the
// server said what it had been asking for. This counts, per verified user,
// requests per method + route pattern per calendar minute, in memory. When a
// user passes 60 requests in one minute — or is first refused with a 429,
// since a steady 41-60 a minute exhausts 600 / 15 min without ever passing 60
// — ONE row goes to error_logs (level 'info', category 'api_rate_tally'), at
// most one per user per five minutes, with the top ten paths and their counts
// for that minute and for the last fifteen, the user-agent and the
// X-App-Version header if the app sends one.
//
// Never recorded: request bodies, query strings, tokens, ids in paths (every
// id-like segment becomes ":id"). Mounted ahead of the limiters in
// routes/api_v1.js, so refused (429) requests are counted too; paths the
// limiter exempts are counted and marked "exempt".

const crypto = require('crypto');

const MINUTE_MS = 60 * 1000;
const THRESHOLD_PER_MINUTE = 60;
const LOG_EVERY_MS = 5 * 60 * 1000;
const TOP_N = 10;
const MAX_USERS = 5000;
const HISTORY_MINUTES = 15;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One path segment → itself, or ":id" when it looks like an identifier. */
function normaliseSegment(seg) {
  if (!seg) return seg;
  if (UUID_RE.test(seg)) return ':id';
  if (/^\d+$/.test(seg)) return ':id';
  if (/^[0-9a-f]{12,}$/i.test(seg)) return ':id';
  // Case references, tokens, e-mail-ish or otherwise long mixed segments.
  if (/\d/.test(seg) && seg.length >= 6) return ':id';
  if (seg.length >= 24) return ':id';
  if (seg.indexOf('@') >= 0) return ':id';
  return seg;
}

/** "/conversations/3f2…/messages?after=…" → "/conversations/:id/messages". */
function routePattern(p) {
  const pathOnly = String(p || '').split('?')[0];
  return pathOnly.split('/').map(normaliseSegment).join('/') || '/';
}

function headerValue(req, name, max) {
  const v = req && req.headers && req.headers[name];
  if (!v || Array.isArray(v)) return null;
  return String(v).slice(0, max);
}

let defaultWriterPg = null;
async function defaultWriter(row) {
  if (!defaultWriterPg) defaultWriterPg = require('../pg');
  await defaultWriterPg.execute(
    `INSERT INTO error_logs (id, category, level, message, context, user_id, created_at)
     VALUES ($1, 'api_rate_tally', 'info', $2, $3, $4, NOW())`,
    [crypto.randomUUID(), row.message, JSON.stringify(row.context), row.userId]
  );
}

/**
 * @param {object} opts
 * @param {(req) => string} opts.userIdOf  verified user id, or '' (not counted)
 * @param {(req) => boolean} [opts.isExempt]  limiter-exempt path (marked, still counted)
 * @param {(row) => Promise<void>} [opts.writer]  test seam; default writes error_logs
 * @param {() => number} [opts.now]
 */
function buildRateTally({ userIdOf, isExempt = () => false, writer = defaultWriter, now = () => Date.now() } = {}) {
  // userId → { minute, total, counts: Map, history: [{ minute, counts }], ua, appVersion }
  const users = new Map();
  const lastLoggedAt = new Map(); // userId → ms

  function prune(minute) {
    for (const [id, u] of users) if (u.minute < minute - 1) users.delete(id);
    for (const [id, at] of lastLoggedAt) if (now() - at > LOG_EVERY_MS) lastLoggedAt.delete(id);
  }

  const topOf = (counts) => Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([path, count]) => ({ path, count }));

  function maybeLog(uid, u, t, trigger) {
    const last = lastLoggedAt.get(uid);
    if (last !== undefined && t - last < LOG_EVERY_MS) return;
    lastLoggedAt.set(uid, t);
    const window = new Map();
    let windowTotal = 0;
    for (const h of u.history.concat([{ minute: u.minute, counts: u.counts }])) {
      if (h.minute <= u.minute - HISTORY_MINUTES) continue;
      for (const [k, n] of h.counts) { window.set(k, (window.get(k) || 0) + n); windowTotal += n; }
    }
    const row = {
      userId: uid,
      message: trigger === 'refused'
        ? `user refused by the API rate limit (${u.total} requests this minute, ${windowTotal} in ${HISTORY_MINUTES})`
        : `user sent ${u.total} API requests in one minute (over ${THRESHOLD_PER_MINUTE})`,
      context: {
        source: 'api_rate_tally',
        trigger,
        minuteStartUtc: new Date(u.minute * MINUTE_MS).toISOString(),
        requestsThisMinute: u.total,
        distinctPaths: u.counts.size,
        top: topOf(u.counts),
        requestsLast15Min: windowTotal,
        top15Min: topOf(window),
        userAgent: u.ua || null,
        appVersion: u.appVersion || null,
      },
    };
    Promise.resolve()
      .then(() => writer(row))
      .catch(() => { /* a tally must never affect the request */ });
  }

  function tally(req, res, next) {
    try {
      const uid = userIdOf(req);
      if (uid) {
        const t = now();
        const minute = Math.floor(t / MINUTE_MS);
        let u = users.get(uid);
        if (!u) {
          if (users.size >= MAX_USERS) prune(minute);
          u = { minute, total: 0, counts: new Map(), history: [] };
          users.set(uid, u);
        } else if (u.minute !== minute) {
          u.history.push({ minute: u.minute, counts: u.counts });
          u.history = u.history.filter((h) => h.minute > minute - HISTORY_MINUTES);
          u.minute = minute;
          u.total = 0;
          u.counts = new Map();
        }
        const key = String(req.method || 'GET').toUpperCase() + ' ' + routePattern(req.path) + (isExempt(req) ? ' (exempt)' : '');
        u.counts.set(key, (u.counts.get(key) || 0) + 1);
        u.total += 1;
        u.ua = headerValue(req, 'user-agent', 200);
        u.appVersion = headerValue(req, 'x-app-version', 40);

        if (u.total > THRESHOLD_PER_MINUTE) maybeLog(uid, u, t, 'over_60_per_minute');
        if (res && typeof res.on === 'function') {
          res.on('finish', () => {
            try { if (res.statusCode === 429) maybeLog(uid, u, now(), 'refused'); } catch (_) { /* never */ }
          });
        }
      }
    } catch (_) { /* never let counting break a request */ }
    return next();
  }

  tally._state = { users, lastLoggedAt };
  return tally;
}

module.exports = { buildRateTally, routePattern, THRESHOLD_PER_MINUTE, LOG_EVERY_MS };
