'use strict';

// services/ops_expiries.js
//
// 6 Oct 2026 (watchtower) — the expiry register (migration 128).
//
// Domains, developer memberships, API tokens, plans: each fails silently on a
// date somebody once knew. This module reads and writes the register and owns
// the one rule about it, which the credentials.expiring check and the API
// both use so they cannot disagree:
//
//   no date entered     unset  (counts as a warning — "not entered" is not
//                              "does not expire")
//   more than 30 days   ok
//   30 days or fewer    warn
//   7 days or fewer     fail   (including already expired)

const { queryAll, queryOne } = require('../pg');

const WARN_DAYS = 30;
const FAIL_DAYS = 7;
const KEY_RE = /^[a-z0-9_]{3,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cairoToday(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now instanceof Date ? now : new Date(now || Date.now()));
}

/** 'YYYY-MM-DD' from a pg date (string or Date), or null. */
function dateOnly(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    // node-postgres parses a `date` at LOCAL midnight; read it back the same way.
    const p = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

/** Whole days from the Cairo calendar day of `now` to `expiresOn`; negative when past. */
function daysLeft(expiresOn, now) {
  const d = dateOnly(expiresOn);
  if (!d) return null;
  const a = Date.parse(cairoToday(now) + 'T00:00:00Z');
  const b = Date.parse(d + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/** 'unset' | 'ok' | 'warn' | 'fail' for one row. Pure. */
function expiryStatus(expiresOn, now) {
  const n = daysLeft(expiresOn, now);
  if (n === null) return 'unset';
  if (n <= FAIL_DAYS) return 'fail';
  if (n <= WARN_DAYS) return 'warn';
  return 'ok';
}

/** Is this a real calendar date in YYYY-MM-DD form? */
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function shape(row, now) {
  const expires = dateOnly(row.expires_on);
  return {
    key: row.key,
    label: row.label,
    expires_on: expires,
    days_left: daysLeft(expires, now),
    status: expiryStatus(expires, now),
    owner: row.owner || null,
    notes: row.notes || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * The credentials.expiring check, from the register's rows. Pure.
 * fail if any row is within 7 days (or past); otherwise warn if any is within
 * 30 days or has no date; otherwise ok.
 */
function summariseExpiries(rows, now) {
  const shaped = (rows || []).map((r) => shape(r, now));
  const by = (st) => shaped.filter((r) => r.status === st);
  const failing = by('fail'), warning = by('warn'), unset = by('unset');
  const status = failing.length ? 'fail' : ((warning.length || unset.length) ? 'warn' : 'ok');
  const soonest = shaped.filter((r) => r.days_left !== null).sort((a, b) => a.days_left - b.days_left)[0] || null;
  const parts = [];
  if (failing.length) parts.push(failing.length + ' within ' + FAIL_DAYS + ' days');
  if (warning.length) parts.push(warning.length + ' within ' + WARN_DAYS + ' days');
  if (unset.length) parts.push(unset.length + ' with no date');
  const summary = parts.length
    ? parts.join(', ') + (soonest ? ' — next: ' + soonest.label + ' (' + soonest.days_left + 'd)' : '')
    : 'All ' + shaped.length + ' dated and more than ' + WARN_DAYS + ' days out';
  return {
    status,
    summary: summary.slice(0, 300),
    detail: {
      total: shaped.length,
      failing: failing.map((r) => ({ key: r.key, days_left: r.days_left })),
      warning: warning.map((r) => ({ key: r.key, days_left: r.days_left })),
      unset: unset.map((r) => r.key),
    },
  };
}

async function listExpiries(now) {
  const rows = (await queryAll(
    'SELECT key, label, expires_on, owner, notes, updated_at FROM ops_expiries ' +
    ' ORDER BY (expires_on IS NULL) ASC, expires_on ASC, label ASC', []
  )) || [];
  return rows.map((r) => shape(r, now));
}

/**
 * Set the date and/or notes of one entry. Only the fields present in `patch`
 * change; an explicit null clears. Returns { ok, expiry } or { ok:false, code }.
 */
async function updateExpiry(key, patch, now) {
  const k = String(key || '');
  if (!KEY_RE.test(k)) return { ok: false, code: 'BAD_KEY' };
  const p = patch || {};
  const hasDate = Object.prototype.hasOwnProperty.call(p, 'expires_on');
  const hasNotes = Object.prototype.hasOwnProperty.call(p, 'notes');
  const hasOwner = Object.prototype.hasOwnProperty.call(p, 'owner');
  if (!hasDate && !hasNotes && !hasOwner) return { ok: false, code: 'NOTHING_TO_UPDATE' };
  if (hasDate && p.expires_on !== null && !isValidDate(p.expires_on)) return { ok: false, code: 'BAD_DATE' };
  if (hasNotes && p.notes !== null && (typeof p.notes !== 'string' || p.notes.length > 1000)) return { ok: false, code: 'BAD_NOTES' };
  if (hasOwner && p.owner !== null && (typeof p.owner !== 'string' || p.owner.length > 120)) return { ok: false, code: 'BAD_OWNER' };
  const row = await queryOne(
    'UPDATE ops_expiries SET ' +
    '  expires_on = CASE WHEN $2 THEN $3::date ELSE expires_on END, ' +
    '  notes      = CASE WHEN $4 THEN $5 ELSE notes END, ' +
    '  owner      = CASE WHEN $6 THEN $7 ELSE owner END, ' +
    '  updated_at = NOW() ' +
    ' WHERE key = $1 RETURNING key, label, expires_on, owner, notes, updated_at',
    [k, hasDate, hasDate ? p.expires_on : null, hasNotes, hasNotes ? (p.notes || null) : null,
     hasOwner, hasOwner ? (p.owner || null) : null]
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, expiry: shape(row, now) };
}

/** Add an entry. Returns { ok, expiry } or { ok:false, code }. */
async function addExpiry(input, now) {
  const i = input || {};
  const k = String(i.key || '');
  if (!KEY_RE.test(k)) return { ok: false, code: 'BAD_KEY' };
  const label = typeof i.label === 'string' ? i.label.trim() : '';
  if (!label || label.length > 120) return { ok: false, code: 'BAD_LABEL' };
  const date = (i.expires_on === undefined || i.expires_on === null || i.expires_on === '') ? null : i.expires_on;
  if (date !== null && !isValidDate(date)) return { ok: false, code: 'BAD_DATE' };
  if (i.notes != null && (typeof i.notes !== 'string' || i.notes.length > 1000)) return { ok: false, code: 'BAD_NOTES' };
  if (i.owner != null && (typeof i.owner !== 'string' || i.owner.length > 120)) return { ok: false, code: 'BAD_OWNER' };
  const row = await queryOne(
    'INSERT INTO ops_expiries (key, label, expires_on, owner, notes, updated_at) ' +
    'VALUES ($1, $2, $3::date, $4, $5, NOW()) ON CONFLICT (key) DO NOTHING ' +
    'RETURNING key, label, expires_on, owner, notes, updated_at',
    [k, label, date, i.owner || null, i.notes || null]
  );
  if (!row) return { ok: false, code: 'KEY_EXISTS' };
  return { ok: true, expiry: shape(row, now) };
}

/** Raw rows for the check. */
async function readExpiryRows() {
  return (await queryAll('SELECT key, label, expires_on, owner, notes, updated_at FROM ops_expiries', [])) || [];
}


module.exports = {
  WARN_DAYS, FAIL_DAYS, KEY_RE,
  daysLeft, expiryStatus, isValidDate, summariseExpiries, cairoToday,
  listExpiries, updateExpiry, addExpiry, readExpiryRows,
};
