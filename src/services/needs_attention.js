'use strict';

// src/services/needs_attention.js
//
// The sweep that makes silence loud.
//
// THE FAILURE THIS ANSWERS (22 September 2026)
// --------------------------------------------
// Three intake doors, three people who reached out and were never answered:
// Karol through /coming-soon (eight weeks), 66 contact-form submissions into
// an error log nobody reads, and hend — who started a case about her mother's
// breast cancer, got to step 2 of 4, and stopped. Nothing was broken in any of
// them. Every door notifies on SUCCESS; not one watched for SILENCE.
//
// So this does not add a fourth notification. It reads v_needs_attention
// (migration 114) — the single definition of "someone is waiting" — and says
// so, on a clock, whether or not anything happened.
//
// WHY IT RUNS ON RENDER AND NOT ON THE MAC MINI
// ---------------------------------------------
// Tash runs on the mini, and when the mini is offline Tash is down AND its own
// watchdog is down with it. A watchdog that dies alongside the thing it
// watches is not a watchdog. This runs next to the database, on the instance
// that is already externally monitored, and Tash reads the same view for its
// brief rather than owning the alerting.
//
// THE DEAD-MAN'S SWITCH
// ---------------------
// The sweep heartbeats to agent_heartbeats as 'attention_sweep', and that name
// is registered in admin_health.WORKER_SPECS. /healthz already reports every
// spec's freshness and the external uptime monitor already watches /healthz —
// so if this sweep stops running, the existing alarm notices. The alerting
// does not depend on itself being alive to report that it is dead, which is
// the single property all three original doors lacked.

const { queryAll, execute } = require('../db');
const { major: logMajor } = require('../logger');

// A thing must be waiting this long before it is worth waking anyone for.
// Below this, a patient mid-wizard would page you for being mid-wizard.
const ALERT_AFTER_MINUTES = 60;

// One alert per item per this window. Without it, a sweep every 15 minutes
// sends the same person the same message 96 times a day and they stop reading
// any of it — which is the failure mode of every alerting system that ever
// got muted.
const REALERT_AFTER_HOURS = 24;

const AGENT_NAME = 'attention_sweep';

// ─── 6 Oct 2026 (watchtower) — state and escalation ─────────────────────────
//
// The view still has no state. What a human has DONE about a row — seen it,
// snoozed it, resolved it — lives in attention_state (migration 125), keyed on
// the view's (kind, ref), and so does the escalation clock below.
//
// Two populations, deliberately:
//
//   ESCALATING kinds (migration 126's paid_unassigned, refund_stale,
//   specialty_uncovered and send_failed, plus payment_claim) are pushed one
//   item at a time through ops push, as their own catalogue kind, on this clock:
//     loud   pushed when first seen; if neither acked nor snoozed, again
//            after 2 hours, then every 6.
//     quiet  pushed once. After that it only appears in the daily digest.
//   Loud or quiet is the kind's catalogue default (services/ops_push_prefs.js)
//   so there is one place that says which is which.
//
//   Every OTHER kind (the four intake doors) keeps the sweep's original rule
//   unchanged: alert once it has waited an hour, re-alert after
//   24 hours, as one digest through sendCriticalAlert.
//
// Snoozed and resolved items are off the list for both populations.
const ESCALATING_KINDS = Object.freeze(['payment_claim', 'paid_unassigned', 'refund_stale', 'specialty_uncovered', 'send_failed']);

// How long an escalating item must have waited before its FIRST push. The
// view already applies each new kind's own threshold (15 minutes, 48 hours…),
// so those push as soon as they appear. A transfer claim is in the view from
// the moment the patient submits it — and that moment already pushes
// (`payment_claim`, from the claim route) — so the sweep's first alert waits
// the same hour it always has: 60 minutes, again 2 hours later, then every 6,
// until someone acks it.
const FIRST_PUSH_AFTER_MINUTES = Object.freeze({ payment_claim: 60 });
const FIRST_REPUSH_HOURS = 2;
const REPUSH_EVERY_HOURS = 6;
// A resolve is a claim, not a fact: if the underlying condition is still true
// this long after someone resolved it, the item comes back.
const RESOLVED_REAPPEARS_AFTER_HOURS = 24;
const SNOOZE_MIN_HOURS = 1;
const SNOOZE_MAX_HOURS = 72;
// The sweep stamps last_seen_at every 15 minutes while an item is in the view.
// A gap this long means the condition cleared and came back: a new episode,
// which must not inherit the old one's ack or push count.
const EPISODE_GAP_HOURS = 2;

const KNOWN_KINDS = Object.freeze([
  'contact_submission', 'pre_launch_lead', 'abandoned_case', 'doctor_application', 'payment_claim',
].concat(ESCALATING_KINDS));

function isEscalating(kind) { return ESCALATING_KINDS.indexOf(kind) !== -1; }

/** 'loud' | 'quiet' — the kind's catalogue default; uncatalogued kinds are quiet. */
function levelFor(kind) {
  try {
    const cat = require('./ops_push_prefs').KIND_CATALOGUE.find((k) => k.kind === kind);
    return cat && cat.def === 'loud' ? 'loud' : 'quiet';
  } catch (_) { return 'quiet'; }
}

function _ms(v) { if (!v) return null; const d = v instanceof Date ? v : new Date(v); const n = d.getTime(); return Number.isFinite(n) ? n : null; }

/**
 * Is this item on the open list? Pure.
 * @returns {null|'snoozed'|'resolved'} null when open, otherwise why it is hidden
 */
function hiddenReason(state, now) {
  const t = _ms(now) || Date.now();
  const st = state || {};
  const snoozed = _ms(st.snoozed_until);
  if (snoozed !== null && snoozed > t) return 'snoozed';
  const resolved = _ms(st.resolved_at);
  if (resolved !== null && resolved > t - RESOLVED_REAPPEARS_AFTER_HOURS * 3600e3) return 'resolved';
  return null;
}

/**
 * Should the sweep push this escalating item now? Pure — the escalation clock.
 * @param {'loud'|'quiet'} level
 * @param {object} state attention_state row (or null)
 * @param {Date|number} now
 * @param {number} [minWaitMinutes] the first push waits until state.waiting_minutes reaches this
 * @returns {boolean}
 */
function pushDue(level, state, now, minWaitMinutes) {
  const t = _ms(now) || Date.now();
  const st = state || {};
  if (hiddenReason(st, t)) return false;
  const count = Number(st.push_count) || 0;
  if (count === 0) {                            // never pushed: loud or quiet, once
    const wait = Number(minWaitMinutes) || 0;
    return wait <= 0 || (Number(st.waiting_minutes) || 0) >= wait;
  }
  if (level !== 'loud') return false;           // quiet: once, then the digest only
  if (_ms(st.acked_at) !== null) return false;  // someone has seen it
  const last = _ms(st.last_pushed_at);
  if (last === null) return true;
  const gapHours = count === 1 ? FIRST_REPUSH_HOURS : REPUSH_EVERY_HOURS;
  return t - last >= gapHours * 3600e3;
}

/**
 * Everyone currently waiting on a human, oldest first.
 * @param {object} [opts]
 * @param {number} [opts.minMinutes] only items waiting at least this long
 * @returns {Promise<Array>}
 */
async function listWaiting(opts) {
  const minMinutes = (opts && typeof opts.minMinutes === 'number') ? opts.minMinutes : 0;
  return queryAll(
    'SELECT kind, ref, who, email, phone, summary, waiting_since, severity, ' +
    '       EXTRACT(EPOCH FROM (NOW() - waiting_since)) / 60 AS waiting_minutes ' +
    '  FROM v_needs_attention ' +
    ' WHERE waiting_since < NOW() - ($1 || \' minutes\')::interval ' +
    ' ORDER BY severity ASC, waiting_since ASC',
    [String(minMinutes)]
  );
}

const STATE_COLS =
  's.acked_at, s.acked_by, s.snoozed_until, s.resolved_at, s.resolved_by, s.note, ' +
  's.first_seen_at, s.last_pushed_at, COALESCE(s.push_count, 0) AS push_count';
const OPEN_SQL =
  "(s.snoozed_until IS NULL OR s.snoozed_until <= NOW()) " +
  "AND (s.resolved_at IS NULL OR s.resolved_at <= NOW() - INTERVAL '" + RESOLVED_REAPPEARS_AFTER_HOURS + " hours')";

/**
 * The attention list with each item's state, oldest first.
 * @param {object} [opts]
 * @param {boolean} [opts.includeHidden] also return snoozed and resolved items
 * @returns {Promise<Array>} view columns + waiting_minutes + attention_state columns
 */
async function listAttention(opts) {
  const includeHidden = !!(opts && opts.includeHidden);
  return queryAll(
    'SELECT v.kind, v.ref, v.who, v.email, v.phone, v.summary, v.waiting_since, v.severity, ' +
    '       EXTRACT(EPOCH FROM (NOW() - v.waiting_since)) / 60 AS waiting_minutes, ' + STATE_COLS +
    '  FROM v_needs_attention v ' +
    '  LEFT JOIN attention_state s ON s.kind = v.kind AND s.ref = v.ref ' +
    (includeHidden ? '' : ' WHERE ' + OPEN_SQL) +
    ' ORDER BY v.waiting_since ASC, v.kind ASC, v.ref ASC',
    []
  );
}

/**
 * Stamp every item currently in the view, and start a clean episode where one
 * is due. One statement, run at the top of each sweep.
 *
 *   - first sighting: a row is created with first_seen_at = NOW()
 *   - seen again:     last_seen_at moves forward
 *   - new episode (not seen for EPISODE_GAP_HOURS — the condition cleared and
 *     came back), or a resolve that has outlived its 24 hours while the
 *     condition is still true: the ack and the push count are cleared, so the
 *     item is treated as new. An unexpired snooze or resolve is never cleared.
 */
async function syncState() {
  const gap = "s.last_seen_at IS NULL OR s.last_seen_at < NOW() - INTERVAL '" + EPISODE_GAP_HOURS + " hours'";
  const reopened = "s.resolved_at IS NOT NULL AND s.resolved_at <= NOW() - INTERVAL '" + RESOLVED_REAPPEARS_AFTER_HOURS + " hours'";
  const fresh = '((' + gap + ') OR (' + reopened + '))';
  await execute(
    'INSERT INTO attention_state AS s (kind, ref, first_seen_at, last_seen_at, updated_at) ' +
    'SELECT DISTINCT v.kind, v.ref, NOW(), NOW(), NOW() FROM v_needs_attention v ' +
    'ON CONFLICT (kind, ref) DO UPDATE SET ' +
    '  last_seen_at   = NOW(), ' +
    '  first_seen_at  = CASE WHEN (' + gap + ') OR s.first_seen_at IS NULL THEN NOW() ELSE s.first_seen_at END, ' +
    '  acked_at       = CASE WHEN ' + fresh + ' THEN NULL ELSE s.acked_at END, ' +
    '  acked_by       = CASE WHEN ' + fresh + ' THEN NULL ELSE s.acked_by END, ' +
    '  push_count     = CASE WHEN ' + fresh + ' THEN 0 ELSE s.push_count END, ' +
    '  last_pushed_at = CASE WHEN ' + fresh + ' THEN NULL ELSE s.last_pushed_at END, ' +
    '  resolved_at    = CASE WHEN ' + reopened + ' THEN NULL ELSE s.resolved_at END, ' +
    '  resolved_by    = CASE WHEN ' + reopened + ' THEN NULL ELSE s.resolved_by END, ' +
    '  snoozed_until  = CASE WHEN s.snoozed_until <= NOW() THEN NULL ELSE s.snoozed_until END',
    []
  );
}

/** Is (kind, ref) in the view right now? State can only be set on a real item. */
async function _exists(kind, ref) {
  const rows = await queryAll('SELECT 1 FROM v_needs_attention WHERE kind = $1 AND ref = $2 LIMIT 1', [kind, ref]);
  return rows.length > 0;
}

function _validKey(kind, ref) {
  if (KNOWN_KINDS.indexOf(String(kind)) === -1) return 'UNKNOWN_KIND';
  const r = String(ref == null ? '' : ref);
  if (!r || r.length > 200) return 'BAD_REF';
  return null;
}

async function _stateRow(kind, ref) {
  const rows = await queryAll(
    'SELECT kind, ref, acked_at, acked_by, snoozed_until, resolved_at, resolved_by, note, ' +
    '       first_seen_at, last_pushed_at, push_count FROM attention_state WHERE kind = $1 AND ref = $2',
    [kind, ref]
  );
  return rows[0] || null;
}

/**
 * The three state transitions. Each returns { ok:true, state } or
 * { ok:false, code } with code UNKNOWN_KIND | BAD_REF | NOT_FOUND | BAD_HOURS.
 * NOT_FOUND means the item is not in v_needs_attention — state is never
 * created for something that is not waiting.
 */
async function ackItem(kind, ref, userId) {
  const bad = _validKey(kind, ref); if (bad) return { ok: false, code: bad };
  if (!(await _exists(kind, ref))) return { ok: false, code: 'NOT_FOUND' };
  await execute(
    'INSERT INTO attention_state (kind, ref, acked_at, acked_by, first_seen_at, last_seen_at, updated_at) ' +
    'VALUES ($1, $2, NOW(), $3, NOW(), NOW(), NOW()) ' +
    'ON CONFLICT (kind, ref) DO UPDATE SET acked_at = NOW(), acked_by = EXCLUDED.acked_by, updated_at = NOW()',
    [kind, ref, userId || null]
  );
  return { ok: true, state: await _stateRow(kind, ref) };
}

async function snoozeItem(kind, ref, hours, userId) {
  const bad = _validKey(kind, ref); if (bad) return { ok: false, code: bad };
  const h = Number(hours);
  if (!Number.isInteger(h) || h < SNOOZE_MIN_HOURS || h > SNOOZE_MAX_HOURS) return { ok: false, code: 'BAD_HOURS' };
  if (!(await _exists(kind, ref))) return { ok: false, code: 'NOT_FOUND' };
  // A snooze is also an acknowledgement — nobody snoozes what they have not seen.
  await execute(
    'INSERT INTO attention_state (kind, ref, snoozed_until, acked_at, acked_by, first_seen_at, last_seen_at, updated_at) ' +
    "VALUES ($1, $2, NOW() + ($3 || ' hours')::interval, NOW(), $4, NOW(), NOW(), NOW()) " +
    'ON CONFLICT (kind, ref) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until, ' +
    '  acked_at = COALESCE(attention_state.acked_at, NOW()), ' +
    '  acked_by = COALESCE(attention_state.acked_by, EXCLUDED.acked_by), updated_at = NOW()',
    [kind, ref, String(h), userId || null]
  );
  return { ok: true, state: await _stateRow(kind, ref) };
}

async function resolveItem(kind, ref, note, userId) {
  const bad = _validKey(kind, ref); if (bad) return { ok: false, code: bad };
  if (!(await _exists(kind, ref))) return { ok: false, code: 'NOT_FOUND' };
  const n = note == null ? null : String(note).trim().slice(0, 1000) || null;
  await execute(
    'INSERT INTO attention_state (kind, ref, resolved_at, resolved_by, note, first_seen_at, last_seen_at, updated_at) ' +
    'VALUES ($1, $2, NOW(), $3, $4, NOW(), NOW(), NOW()) ' +
    'ON CONFLICT (kind, ref) DO UPDATE SET resolved_at = NOW(), resolved_by = EXCLUDED.resolved_by, ' +
    '  note = EXCLUDED.note, updated_at = NOW()',
    [kind, ref, userId || null, n]
  );
  return { ok: true, state: await _stateRow(kind, ref) };
}

/**
 * Claim one escalation push, atomically: the count only moves if it is still
 * the value this pass read, so two instances cannot both push the same step.
 * @returns {Promise<boolean>} true if this caller owns the push
 */
async function claimPush(kind, ref, expectedCount) {
  const rows = await queryAll(
    'UPDATE attention_state SET push_count = push_count + 1, last_pushed_at = NOW(), updated_at = NOW() ' +
    ' WHERE kind = $1 AND ref = $2 AND push_count = $3 RETURNING push_count',
    [kind, ref, Number(expectedCount) || 0]
  );
  return rows.length > 0;
}

/** Give a claimed push back when the send did not go out, so the next pass retries. */
async function revertPush(kind, ref, previous) {
  await execute(
    'UPDATE attention_state SET push_count = GREATEST(push_count - 1, 0), last_pushed_at = $3, updated_at = NOW() ' +
    ' WHERE kind = $1 AND ref = $2',
    [kind, ref, (previous && previous.last_pushed_at) || null]
  );
}

const PUSH_TITLES = Object.freeze({
  payment_claim: 'Transfer still waiting to be verified',
  paid_unassigned: 'Paid case with no doctor',
  refund_stale: 'Refund open over 48 hours',
  specialty_uncovered: 'Specialty not covered',
  send_failed: 'Message not delivered',
});

function ageLabel(minutes) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h >= 48 ? Math.floor(h / 24) + 'd' : h + 'h';
}

async function defaultPushEvent(item, step) {
  const { pushOpsEvent } = require('./ops_push');
  return pushOpsEvent({
    kind: item.kind,
    // The step is part of the key: each escalation is its own event, so the
    // ops-push cooldown dedupes a retry of one step without swallowing the next.
    dedupeKey: item.ref + ':' + step,
    title: (PUSH_TITLES[item.kind] || item.kind.replace(/_/g, ' ')) + (step > 0 ? ' — still open' : ''),
    body: (item.who && item.kind !== 'specialty_uncovered' ? item.who + ': ' : '') +
          String(item.summary || '').slice(0, 160) + ' · waiting ' + ageLabel(item.waiting_minutes),
    // `screen` is the route for a Command build that has the Attention screen.
    // A paid case with no doctor also carries caseId, which every existing
    // build already routes to the case — where the assign button is.
    data: Object.assign({ screen: 'attention', attentionKind: item.kind, ref: item.ref, step: step },
      item.kind === 'paid_unassigned' ? { caseId: item.ref } : {}),
    // (payment_claim needs no hint: every Command build routes that kind to
    // the Transfers screen, where the Verify / Reject buttons are.)
    orderId: (item.kind === 'paid_unassigned' || item.kind === 'payment_claim') ? item.ref : null,
  });
}

/**
 * A one-line-per-item digest, newest concern first. Plain text on purpose:
 * it has to survive WhatsApp, an SMS, an email body and a terminal.
 */
function formatDigest(items) {
  if (!items.length) return 'Nobody is waiting. All intake doors are clear.';
  const lines = items.slice(0, 20).map((i) => {
    const hrs = Math.floor(Number(i.waiting_minutes) / 60);
    const age = hrs >= 48 ? Math.floor(hrs / 24) + 'd' : (hrs >= 1 ? hrs + 'h' : '<1h');
    return '• [' + age + '] ' + i.kind.replace(/_/g, ' ') + ' — ' + i.who +
           (i.email ? ' (' + i.email + ')' : '') + ': ' + (i.summary || '').slice(0, 90);
  });
  if (items.length > 20) lines.push('• …and ' + (items.length - 20) + ' more');
  return lines.join('\n');
}

/**
 * Has this exact item already been alerted on inside the re-alert window?
 * Uses error_logs as the ledger — it is already the durable append-only record
 * this service keeps, and a dedicated table for "did I mention this" would be
 * one more thing to migrate and back up for no gain.
 */
async function alreadyAlerted(kind, ref) {
  const rows = await queryAll(
    "SELECT 1 FROM error_logs " +
    " WHERE category = 'attention_alert' AND context LIKE $1 " +
    "   AND created_at > NOW() - ($2 || ' hours')::interval LIMIT 1",
    ['%"' + kind + ':' + ref + '"%', String(REALERT_AFTER_HOURS)]
  );
  return rows.length > 0;
}

async function recordAlerted(items) {
  if (!items.length) return;
  const keys = items.map((i) => i.kind + ':' + i.ref);
  try {
    await execute(
      "INSERT INTO error_logs (id, error_id, level, message, category, context, created_at) " +
      "VALUES (gen_random_uuid()::text, gen_random_uuid()::text, 'info', $1, 'attention_alert', $2, NOW())",
      ['attention sweep alerted on ' + items.length + ' item(s)', JSON.stringify({ alerted: keys })]
    );
  } catch (e) {
    // Never let the ledger write sink the alert that already went out.
    console.error('[attention-sweep] could not record alert ledger:', e && e.message);
  }
}

/**
 * One pass. Returns a summary rather than throwing, because a sweep that
 * crashes is a sweep that stops running, and this one exists precisely to
 * survive being ignored.
 *
 * @param {object} [deps] injectable for tests
 * @returns {Promise<{total:number, alertable:number, alerted:number, digest:string}>}
 */
async function runAttentionSweep(deps) {
  const d = deps || {};
  // Injected deps (tests) replace the database entirely. The state-and-push
  // deps added on 6 Oct default to inert when ANY deps object is passed, so a
  // test that fakes only the original four never reaches a real connection.
  const live = !deps;
  const _list = d.listWaiting || listAttention;
  const _already = d.alreadyAlerted || alreadyAlerted;
  const _record = d.recordAlerted || recordAlerted;
  const _send = d.sendAlert || defaultSendAlert;
  const _sync = d.syncState || (live ? syncState : async () => {});
  const _claim = d.claimPush || (live ? claimPush : async () => false);
  const _revert = d.revertPush || (live ? revertPush : async () => {});
  const _push = d.pushEvent || (live ? defaultPushEvent : async () => ({ sent: false }));
  const now = d.now || Date.now();

  // Stamp what is in the view and open new episodes BEFORE reading the list,
  // so first_seen_at exists for kinds that age from it. A failure here costs
  // one pass of escalation bookkeeping, never the alerts themselves.
  try { await _sync(); } catch (err) {
    logMajor('[attention-sweep] could not sync attention_state — escalation clock not advanced this pass', {
      error: err && err.message
    });
  }

  let waiting = [];
  try {
    waiting = await _list({ minMinutes: 0 });
  } catch (err) {
    logMajor('[attention-sweep] could not read v_needs_attention — nobody is being watched right now', {
      error: err && err.message
    });
    return { total: 0, alertable: 0, alerted: 0, pushed: 0, digest: '', failed: true };
  }
  // Snoozed and resolved items are off the list for every kind.
  waiting = waiting.filter((i) => !hiddenReason(i, now));

  // The digest reads worst first (severity, then age), as listWaiting always
  // ordered it; the list itself now arrives oldest first for the API.
  waiting = waiting.slice().sort((a, b) =>
    (Number(a.severity) - Number(b.severity)) || ((_ms(a.waiting_since) || 0) - (_ms(b.waiting_since) || 0)));

  // ── The original rule, for every kind that is not on the escalation clock ──
  const legacy = waiting.filter((i) => !isEscalating(i.kind));
  const alertable = legacy.filter((i) => Number(i.waiting_minutes) >= ALERT_AFTER_MINUTES);

  const fresh = [];
  for (const item of alertable) {
    let seen = false;
    try { seen = await _already(item.kind, item.ref); } catch (_) { seen = false; }
    if (!seen) fresh.push(item);
  }

  if (fresh.length) {
    const body =
      'Tashkheesa — ' + fresh.length + ' new ' +
      (fresh.length === 1 ? 'person is' : 'people are') + ' waiting on a reply:\n\n' +
      formatDigest(fresh);
    try {
      await _send(body, fresh);
      await _record(fresh);
    } catch (err) {
      // Do NOT record: an alert that failed to send must be retried next pass,
      // not marked as delivered. This is the difference between a queue and a
      // shrug.
      logMajor('[attention-sweep] alert send FAILED — will retry next pass', {
        error: err && err.message, items: fresh.length
      });
    }
  }

  // ── The escalation clock, one push per item ───────────────────────────────
  let pushed = 0;
  for (const item of waiting.filter((i) => isEscalating(i.kind))) {
    try {
      if (!pushDue(levelFor(item.kind), item, now, FIRST_PUSH_AFTER_MINUTES[item.kind])) continue;
      const step = Number(item.push_count) || 0;
      // Claim first: the count moves before the send, so a second instance or
      // an overlapping pass cannot push the same step.
      if (!(await _claim(item.kind, item.ref, step))) continue;
      const r = await _push(item, step);
      // 'kind_budget' means ops push logged it and sent a burst summary
      // instead — that counts as told. Anything else did not go out: give the
      // claim back so the next pass retries rather than a quiet item being
      // marked "pushed once" when it never was.
      if (r && (r.sent || r.skipped === 'kind_budget')) pushed++;
      else await _revert(item.kind, item.ref, item);
    } catch (err) {
      logMajor('[attention-sweep] escalation push failed for ' + item.kind + ':' + item.ref, {
        error: err && err.message
      });
    }
  }

  return {
    total: waiting.length,
    alertable: alertable.length,
    alerted: fresh.length,
    pushed: pushed,
    digest: formatDigest(waiting)
  };
}

async function defaultSendAlert(body) {
  const { sendCriticalAlert } = require('../critical-alert');
  await sendCriticalAlert(body, 'attention-sweep');
}

module.exports = {
  runAttentionSweep,
  listWaiting,
  listAttention,
  syncState,
  ackItem,
  snoozeItem,
  resolveItem,
  claimPush,
  revertPush,
  hiddenReason,
  pushDue,
  levelFor,
  isEscalating,
  ageLabel,
  ESCALATING_KINDS,
  KNOWN_KINDS,
  FIRST_REPUSH_HOURS,
  FIRST_PUSH_AFTER_MINUTES,
  REPUSH_EVERY_HOURS,
  RESOLVED_REAPPEARS_AFTER_HOURS,
  SNOOZE_MIN_HOURS,
  SNOOZE_MAX_HOURS,
  formatDigest,
  ALERT_AFTER_MINUTES,
  REALERT_AFTER_HOURS,
  AGENT_NAME
};
