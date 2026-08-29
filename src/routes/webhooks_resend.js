// src/routes/webhooks_resend.js
//
// Ingests Resend delivery events so this platform can tell a delivered email
// from a dead one.
//
// Before this existed, notifications.response recorded {"ok":true,"messageId"}
// — that Resend ACCEPTED the message — and nothing ever updated it. Four
// doctors sat on Resend's suppression list for eighteen days while twelve
// invites to them were logged as delivered. They read as unresponsive; they
// had never been contacted.
//
// SECURITY. Every request is verified against the Svix signature over the RAW
// body before anything is read from it. An unverified request writes nothing
// and returns 401. The route is CSRF-exempt (it is a server-to-server POST
// with no cookie) and that exemption is safe precisely because the signature
// is the authentication.
//
// IDEMPOTENCE. Svix retries on any non-2xx. The Svix message id is the primary
// key of email_delivery_events, so a retry is a no-op rather than a duplicate.
// For the same reason this returns 200 for anything it has decided not to act
// on — an event type we do not model is not an error, and answering non-2xx
// would have Svix redeliver it for days.

const express = require('express');
const router = express.Router();
const { execute, queryOne } = require('../pg');
const { logErrorToDb } = require('../logger');
const { verifySvixSignature } = require('../lib/svix_verify');

// Events that mean "do not send to this address again until a human says so".
//
// email.bounced is a HARD bounce in Resend's model; soft bounces surface as
// email.delivery_delayed, which is deliberately absent here — a full mailbox
// on Tuesday should not silently exclude a doctor forever.
const SUPPRESSING_EVENTS = Object.freeze({
  'email.bounced': 'bounced',
  'email.complained': 'complained',
});

// Everything else worth keeping for the audit trail.
const LOGGED_EVENTS = Object.freeze([
  'email.sent', 'email.delivered', 'email.delivery_delayed',
  'email.opened', 'email.clicked', 'email.failed',
]);

function firstRecipient(data) {
  const to = data && data.to;
  if (Array.isArray(to)) return String(to[0] || '').trim().toLowerCase();
  if (typeof to === 'string') return to.trim().toLowerCase();
  return '';
}

router.post('/webhooks/resend', async (req, res) => {
  const secret = String(process.env.RESEND_WEBHOOK_SECRET || '').trim();

  // Fail closed. An unconfigured secret must not become "accept everything" —
  // this endpoint writes to a table that decides who we are allowed to email.
  const verdict = verifySvixSignature({
    secret,
    rawBody: req.rawBody,
    headers: req.headers,
  });
  if (!verdict.ok) {
    // Deliberately not logged to error_logs at full volume: an unconfigured
    // secret would otherwise write a row per delivery event and drown the
    // error rate detector. Console only, and the reason is enough to debug.
    console.warn('[resend-webhook] rejected:', verdict.reason);
    return res.status(401).json({ ok: false, error: verdict.reason });
  }

  try {
    const body = req.body || {};
    const type = String(body.type || '').trim();
    const data = body.data || {};
    const email = firstRecipient(data);
    const messageId = String(data.email_id || data.id || '') || null;
    const svixId = String(req.get('svix-id') || req.get('webhook-id') || '').trim();
    const occurredAt = body.created_at || data.created_at || null;

    if (!email) {
      // Nothing actionable, but a 200 so Svix stops retrying.
      return res.json({ ok: true, ignored: 'no_recipient' });
    }

    if (LOGGED_EVENTS.includes(type) || SUPPRESSING_EVENTS[type]) {
      await execute(
        `INSERT INTO email_delivery_events (id, message_id, email, event_type, occurred_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [svixId || (messageId + ':' + type + ':' + Date.now()), messageId, email, type, occurredAt, JSON.stringify(body)]
      );
    }

    const reason = SUPPRESSING_EVENTS[type];
    if (reason) {
      // A repeat bounce on an address an operator already cleared re-opens the
      // suppression: clearing it was a bet that the address was fixed, and
      // this is the evidence it was not.
      await execute(
        `INSERT INTO email_suppressions (email, reason, first_seen_at, last_event_at, event_count)
         VALUES ($1, $2, NOW(), NOW(), 1)
         ON CONFLICT (email) DO UPDATE
            SET reason        = EXCLUDED.reason,
                last_event_at = NOW(),
                event_count   = email_suppressions.event_count + 1,
                cleared_at    = NULL,
                cleared_by    = NULL`,
        [email, reason]
      );
      console.warn('[resend-webhook] suppressing', email, '(' + reason + ')');
    }

    return res.json({ ok: true, type: type, email: email });
  } catch (err) {
    logErrorToDb(err, {
      context: 'webhooks.resend',
      requestId: req.requestId,
      url: req.originalUrl,
      method: req.method,
      category: 'notifications',
    });
    // 500 so Svix retries — the signature was valid, so this is our fault and
    // the event is worth having.
    return res.status(500).json({ ok: false });
  }
});

/** Is this address safe to email? Used by the outreach console. */
async function isSuppressed(email) {
  if (!email) return false;
  try {
    const row = await queryOne(
      'SELECT reason FROM email_suppressions WHERE lower(email) = lower($1) AND cleared_at IS NULL',
      [String(email).trim()]
    );
    return row ? (row.reason || 'suppressed') : false;
  } catch (_) {
    // Table missing (pre-098 environment) or DB blip. Fail OPEN: a lookup
    // failure must not silently stop every doctor email on the platform.
    return false;
  }
}

module.exports = router;
module.exports.isSuppressed = isSuppressed;
module.exports.SUPPRESSING_EVENTS = SUPPRESSING_EVENTS;
