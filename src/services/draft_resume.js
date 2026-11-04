'use strict';

// src/services/draft_resume.js — the signed links in the draft-resume nudges
// (patient recovery, Part A, 2 Nov 2026). Migration 132 has the table.
//
// A token is 22 URL-safe characters: a 10-character random id and the first
// 12 characters of an HMAC of that id under a key derived from JWT_SECRET. The
// row holds the order, the patient, the expiry and the SHA-256 of the token —
// never the token. notifications rows carry the id (`resume_token_id`) and the
// worker rebuilds the link at send time (withResumeLink), so no table holds a
// working link.
//
// A token opens ONE draft, for 72 hours, and never signs anyone in:
//   * the browser holds that patient's session → the draft at its saved step
//     (/patient/new-case?resume=<id>, which re-checks ownership and DRAFT);
//   * no session → /login?next=<that same URL>;
//   * someone else's session → their dashboard; nothing about the draft shown.
// Opening it records the visit, clears any nudge for that draft still waiting
// to be sent, and counts once in the funnel (draft_resumed).

const crypto = require('crypto');

const TOKEN_TTL_HOURS = 72;
const ID_BYTES = 7;   // → 10 base64url characters
const SIG_BYTES = 9;  // → 12 base64url characters
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

function _key() {
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('draft-resume-v1').digest();
}
function _sign(id) {
  return crypto.createHmac('sha256', _key()).update(String(id)).digest().subarray(0, SIG_BYTES).toString('base64url');
}
function tokenForId(id) { return String(id) + _sign(id); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

/** The id inside a well-formed, correctly signed token; null otherwise. Pure. */
function idFromToken(token) {
  const s = String(token || '');
  if (!TOKEN_RE.test(s)) return null;
  const id = s.slice(0, 10);
  const a = Buffer.from(s.slice(10));
  const b = Buffer.from(_sign(id));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

function appUrl() { return String(process.env.APP_URL || 'https://tashkheesa.com').replace(/\/+$/, ''); }
function resumeUrl(token) { return appUrl() + '/portal/patient/resume/' + token; }
function wizardPathFor(orderId) { return '/patient/new-case?resume=' + encodeURIComponent(String(orderId)); }

function _pg(deps) { return (deps && deps.pg) || require('../pg'); }

/**
 * Mint a token for one draft. Returns { id, token, expiresAt }.
 * @param {{orderId: string, patientId: string, level: string, now?: Date}} o
 */
async function mintToken(o, deps) {
  const id = crypto.randomBytes(ID_BYTES).toString('base64url');
  const token = tokenForId(id);
  const created = o.now instanceof Date ? o.now : new Date();
  const expiresAt = new Date(created.getTime() + TOKEN_TTL_HOURS * 3600e3);
  await _pg(deps).execute(
    `INSERT INTO draft_resume_tokens (id, token_hash, order_id, patient_id, level, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, hashToken(token), String(o.orderId), String(o.patientId), String(o.level), created.toISOString(), expiresAt.toISOString()]);
  return { id, token, expiresAt };
}

/**
 * Look a token up. { ok: true, row } | { ok: false, reason: 'invalid' | 'expired' }.
 * Invalid covers a malformed token, a bad signature and an unknown one alike.
 */
async function resolveToken(token, deps) {
  const id = idFromToken(token);
  if (!id) return { ok: false, reason: 'invalid' };
  const row = await _pg(deps).queryOne(
    'SELECT * FROM draft_resume_tokens WHERE id = $1 AND token_hash = $2', [id, hashToken(token)]);
  if (!row) return { ok: false, reason: 'invalid' };
  const now = (deps && deps.now) || new Date();
  if (new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'expired', row };
  return { ok: true, row };
}

function cairoDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}

/** +1 on a funnel_daily_counts step for a Cairo day. Never throws. */
async function bumpFunnelStep(step, when, deps) {
  try {
    await _pg(deps).execute(
      `INSERT INTO funnel_daily_counts (day, step, n, updated_at) VALUES ($1::date, $2, 1, NOW())
       ON CONFLICT (day, step) DO UPDATE SET n = funnel_daily_counts.n + 1, updated_at = NOW()`,
      [cairoDay(when), step]);
  } catch (_) { /* analytics never blocks a patient */ }
}

/**
 * The owner opened the link: record it, cancel any nudge for this draft that
 * has not gone out yet, count the first open. Never throws.
 */
async function recordOpen(row, deps) {
  try {
    const pg = _pg(deps);
    const r = await pg.queryOne(
      `UPDATE draft_resume_tokens
          SET first_opened_at = COALESCE(first_opened_at, NOW()), last_opened_at = NOW(), open_count = open_count + 1
        WHERE id = $1
      RETURNING (open_count = 1) AS first`, [row.id]);
    await pg.execute(
      `UPDATE notifications SET status = 'skipped', response = $2
        WHERE dedupe_key LIKE $1 AND status IN ('queued', 'retry')`,
      ['draft_resume:' + row.order_id + ':%', JSON.stringify({ skipped: 'draft_resumed' })]);
    if (r && r.first) await bumpFunnelStep('draft_resumed', new Date(), deps);
  } catch (err) {
    console.error('[draft-resume] could not record the open', err && err.message);
  }
}

/**
 * For the notification worker: a copy of the row whose payload carries the
 * link, rebuilt from `resume_token_id`. The stored row is not changed. Rows
 * without the id are returned as they are.
 */
function withResumeLink(n) {
  if (!n || !n.response) return n;
  let p = n.response;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { return n; } }
  if (!p || typeof p !== 'object' || !p.resume_token_id) return n;
  const token = tokenForId(p.resume_token_id);
  const payload = Object.assign({}, p, { resume_token: token, link: resumeUrl(token), resumeUrl: resumeUrl(token) });
  return Object.assign({}, n, { response: JSON.stringify(payload) });
}

module.exports = {
  TOKEN_TTL_HOURS, mintToken, resolveToken, recordOpen, withResumeLink, idFromToken, tokenForId, hashToken,
  resumeUrl, wizardPathFor, bumpFunnelStep, cairoDay,
};
