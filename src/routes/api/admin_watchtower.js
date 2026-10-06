/**
 * Tashkheesa Command — watchtower routes (6 Oct 2026).
 *
 * Mounted by routes/api/admin.js AFTER its `requireJWT + requireRole
 * ('superadmin')` gate, so everything here is superadmin-only by inheritance —
 * this file adds no auth of its own and must never be mounted anywhere else.
 *
 *   GET  /attention                      open items, oldest first, with state
 *   POST /attention/:kind/:ref/ack       "I have seen this"
 *   POST /attention/:kind/:ref/snooze    { hours } 1..72
 *   POST /attention/:kind/:ref/resolve   { note }
 *   GET  /system                         every check, grouped by area, + briefs
 *   GET  /expiries                       the expiry register
 *   PUT  /expiries/:key                  { expires_on, notes }
 *   POST /expiries                       { key, label, expires_on?, owner?, notes? }
 *
 * Responses use the standard envelope (middleware/apiResponse.js) and
 * snake_case field names. The full contract is in
 * docs/audits/WATCHTOWER_2026-10-06.md — the Command app is written from it.
 */

'use strict';

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function shapeState(row) {
  return {
    acked_at: iso(row.acked_at),
    acked_by: row.acked_by || null,
    snoozed_until: iso(row.snoozed_until),
    resolved_at: iso(row.resolved_at),
    resolved_by: row.resolved_by || null,
    note: row.note || null,
    last_pushed_at: iso(row.last_pushed_at),
    push_count: Number(row.push_count) || 0,
  };
}

const STATE_ERRORS = {
  UNKNOWN_KIND: [400, 'Unknown attention kind'],
  BAD_REF: [400, 'Bad item reference'],
  BAD_HOURS: [400, 'hours must be a whole number from 1 to 72'],
  NOT_FOUND: [404, 'This item is not waiting any more'],
};

const EXPIRY_ERRORS = {
  BAD_KEY: [400, 'key must match ^[a-z0-9_]{3,60}$'],
  BAD_LABEL: [400, 'label is required, at most 120 characters'],
  BAD_DATE: [400, 'expires_on must be a real date as YYYY-MM-DD, or null'],
  BAD_NOTES: [400, 'notes must be a string of at most 1000 characters, or null'],
  BAD_OWNER: [400, 'owner must be a string of at most 120 characters, or null'],
  NOTHING_TO_UPDATE: [400, 'Send expires_on and/or notes'],
  NOT_FOUND: [404, 'No such expiry'],
  KEY_EXISTS: [409, 'An expiry with this key already exists'],
};

function failWith(res, table, code, fallback) {
  const e = table[code] || [400, fallback || 'Bad request'];
  return res.fail(e[1], e[0], code);
}

module.exports = function mountWatchtower(router, deps) {
  const d = deps || {};
  const attention = () => d.attention || require('../../services/needs_attention');
  const system = () => d.system || require('../../services/system_checks');
  const expiries = () => d.expiries || require('../../services/ops_expiries');

  // ─── GET /attention ────────────────────────────────────────────────────────
  // Open items, oldest first. Snoozed and resolved items are left out unless
  // ?all=1, in which case each carries `hidden`: 'snoozed' | 'resolved'.
  router.get('/attention', async (req, res) => {
    try {
      const na = attention();
      const includeHidden = String((req.query && req.query.all) || '') === '1';
      const now = Date.now();
      const rows = (await na.listAttention({ includeHidden })) || [];
      const prefs = require('../../services/ops_push_prefs');
      const labels = {};
      prefs.KIND_CATALOGUE.forEach((k) => { labels[k.kind] = { en: k.en, ar: k.ar }; });

      const items = rows.map((r) => {
        const minutes = Math.max(0, Math.floor(Number(r.waiting_minutes) || 0));
        const lab = labels[r.kind] || null;
        return {
          kind: r.kind,
          ref: r.ref,
          label_en: lab ? lab.en : String(r.kind).replace(/_/g, ' '),
          label_ar: lab ? lab.ar : null,
          who: r.who || null,
          email: r.email || null,
          phone: r.phone || null,
          summary: r.summary || null,
          waiting_since: iso(r.waiting_since),
          waiting_minutes: minutes,
          waiting_label: na.ageLabel(minutes),
          severity: Number(r.severity) || 3,
          level: na.levelFor(r.kind),
          escalates: na.isEscalating(r.kind),
          hidden: na.hiddenReason(r, now),
          state: shapeState(r),
        };
      });

      const open = items.filter((i) => !i.hidden);
      const by_kind = {};
      open.forEach((i) => { by_kind[i.kind] = (by_kind[i.kind] || 0) + 1; });
      return res.ok({
        generated_at: new Date(now).toISOString(),
        counts: {
          open: open.length,
          loud: open.filter((i) => i.level === 'loud').length,
          unacked: open.filter((i) => !i.state.acked_at).length,
          by_kind,
        },
        items,
      });
    } catch (err) {
      console.error('[admin/attention] list failed:', err && err.message);
      return res.fail('Failed to load attention list', 500, 'ATTENTION_ERROR');
    }
  });

  function stateRoute(action, run) {
    router.post('/attention/:kind/:ref/' + action, async (req, res) => {
      const kind = String(req.params.kind || '');
      const ref = String(req.params.ref || '');
      try {
        const r = await run(attention(), kind, ref, req.body || {}, String((req.user && req.user.id) || ''));
        if (!r.ok) return failWith(res, STATE_ERRORS, r.code);
        return res.ok({ kind, ref, action, state: shapeState(r.state || {}) });
      } catch (err) {
        console.error('[admin/attention] ' + action + ' failed:', err && err.message);
        return res.fail('Could not update this item', 500, 'ATTENTION_WRITE_FAILED');
      }
    });
  }
  stateRoute('ack', (na, kind, ref, body, uid) => na.ackItem(kind, ref, uid));
  stateRoute('snooze', (na, kind, ref, body, uid) => na.snoozeItem(kind, ref, body.hours, uid));
  stateRoute('resolve', (na, kind, ref, body, uid) => na.resolveItem(kind, ref, body.note, uid));

  // ─── GET /system ───────────────────────────────────────────────────────────
  router.get('/system', async (req, res) => {
    try {
      return res.ok(await system().readSystem(Date.now()));
    } catch (err) {
      console.error('[admin/system] failed:', err && err.message);
      return res.fail('Failed to load system checks', 500, 'SYSTEM_ERROR');
    }
  });

  // ─── Expiry register ───────────────────────────────────────────────────────
  router.get('/expiries', async (req, res) => {
    try {
      const ex = expiries();
      const list = await ex.listExpiries(new Date());
      const count = (st) => list.filter((e) => e.status === st).length;
      return res.ok({
        warn_days: ex.WARN_DAYS,
        fail_days: ex.FAIL_DAYS,
        counts: { total: list.length, ok: count('ok'), warn: count('warn'), fail: count('fail'), unset: count('unset') },
        expiries: list,
      });
    } catch (err) {
      console.error('[admin/expiries] list failed:', err && err.message);
      return res.fail('Failed to load expiries', 500, 'EXPIRIES_ERROR');
    }
  });

  router.put('/expiries/:key', async (req, res) => {
    try {
      const b = req.body || {};
      const patch = {};
      // `date` is accepted as an alias of `expires_on`.
      if (Object.prototype.hasOwnProperty.call(b, 'expires_on')) patch.expires_on = b.expires_on;
      else if (Object.prototype.hasOwnProperty.call(b, 'date')) patch.expires_on = b.date;
      if (patch.expires_on === '') patch.expires_on = null;
      if (Object.prototype.hasOwnProperty.call(b, 'notes')) patch.notes = b.notes;
      if (Object.prototype.hasOwnProperty.call(b, 'owner')) patch.owner = b.owner;
      const r = await expiries().updateExpiry(String(req.params.key || ''), patch, new Date());
      if (!r.ok) return failWith(res, EXPIRY_ERRORS, r.code);
      return res.ok({ expiry: r.expiry });
    } catch (err) {
      console.error('[admin/expiries] update failed:', err && err.message);
      return res.fail('Could not save this expiry', 500, 'EXPIRIES_WRITE_FAILED');
    }
  });

  router.post('/expiries', async (req, res) => {
    try {
      const b = req.body || {};
      const input = {
        key: b.key, label: b.label, owner: b.owner, notes: b.notes,
        expires_on: Object.prototype.hasOwnProperty.call(b, 'expires_on') ? b.expires_on : b.date,
      };
      const r = await expiries().addExpiry(input, new Date());
      if (!r.ok) return failWith(res, EXPIRY_ERRORS, r.code);
      return res.status(201).json({ success: true, data: { expiry: r.expiry } });
    } catch (err) {
      console.error('[admin/expiries] add failed:', err && err.message);
      return res.fail('Could not add this expiry', 500, 'EXPIRIES_WRITE_FAILED');
    }
  });
};
