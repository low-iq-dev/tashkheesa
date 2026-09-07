'use strict';

// src/services/analytics.js — the one PostHog client.
//
// Scope today is deliberately narrow: a single `user_signed_up` event, emitted
// once per account that actually reaches the database. Everything here is built
// around three rules that matter more than the feature itself.
//
// ── 1. ANALYTICS MUST NEVER BREAK A REGISTRATION ────────────────────────────
//
// A patient creating an account is the most expensive moment on this platform —
// they have chosen us, typed their details, and are one request away from being
// a customer. No telemetry is worth risking it. So every entry point here is
// synchronous-safe, returns undefined, throws nothing, and is designed to be
// called WITHOUT `await`:
//
//   * capture() wraps its whole body in try/catch and swallows.
//   * The client is created lazily, so a malformed token cannot break boot.
//   * posthog-node buffers in memory and flushes on its own timer, so capture()
//     does no network I/O on the request path.
//   * If the client cannot be constructed at all, capture() becomes a no-op for
//     the life of the process rather than retrying (and re-throwing) per call.
//
// ── 2. NO PII, EVER ─────────────────────────────────────────────────────────
//
// This is a medical platform. Names, emails, phone numbers, national IDs,
// specialties a patient searched, case content — none of it may leave the
// database for an analytics vendor. distinctId is the internal user id (already
// an opaque UUID for every self-service signup) and the only properties sent
// are the signup method and the role. `sanitizeProps` is a hard allow-list, not
// a denylist, so a future caller cannot leak a field by forgetting to strip it.
//
// ── 3. DISABLED IS A NORMAL STATE, NOT AN ERROR ─────────────────────────────
//
// No token means no client and no logging beyond one line at startup. Local
// development, CI and the test suite all run without PostHog configured, and
// they must stay quiet — a warning per signup would train everyone to ignore
// the log.

// House import shape: services/ai_health.js, services/account_deletion.js et al.
var { fatal: logFatal, major: logMajor } = require('../logger');

const HOST = String(process.env.POSTHOG_HOST || 'https://us.i.posthog.com').trim();
const TOKEN = String(process.env.POSTHOG_PROJECT_TOKEN || '').trim();

// Every property name that may be sent with an event. An allow-list, because
// the failure being guarded is someone passing `{ ...user }` in a hurry: a
// denylist would ship whatever field was added to the users table last week.
const ALLOWED_PROPS = new Set([
  'signup_method',   // 'password_web' | 'otp_web' | 'password_mobile' | ...
  'role',            // 'patient' | 'doctor'
  'surface',         // 'web' | 'mobile' | 'api'
]);

let client = null;
let initialised = false;
let disabledReason = null;

/**
 * Lazily build the client. Never throws.
 * @returns {object|null} the PostHog client, or null when analytics is off
 */
function getClient() {
  if (initialised) return client;
  initialised = true;

  if (!TOKEN) {
    disabledReason = 'POSTHOG_PROJECT_TOKEN not set';
    logMajor('[analytics] PostHog disabled — ' + disabledReason);
    return null;
  }

  try {
    const { PostHog } = require('posthog-node');
    client = new PostHog(TOKEN, {
      host: HOST,
      // Small batches and a short timer: this process is a web server that
      // Render restarts on every deploy, so holding events for a long window
      // trades a tiny amount of network for a real chance of losing them. The
      // shutdown flush is the safety net, not the primary mechanism.
      flushAt: 20,
      flushInterval: 10000,
    });

    // posthog-node surfaces delivery failures on an error listener. Without
    // one, some versions emit an unhandled 'error' event — which on an
    // EventEmitter is a process-level throw, i.e. exactly the "analytics broke
    // the app" outcome this module exists to prevent.
    if (typeof client.on === 'function') {
      client.on('error', function (err) {
        logFatal('[analytics] PostHog delivery error', err);
      });
    }

    logMajor('[analytics] PostHog enabled (host=' + HOST + ')');
    return client;
  } catch (err) {
    client = null;
    disabledReason = (err && err.message) || 'client construction failed';
    logFatal('[analytics] PostHog disabled — ' + disabledReason, err);
    return null;
  }
}

/**
 * Keep only allow-listed, primitive, non-empty properties.
 * @param {object} props
 * @returns {object}
 */
function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  for (const key of Object.keys(props)) {
    if (!ALLOWED_PROPS.has(key)) continue;
    const v = props[key];
    if (v === null || v === undefined || v === '') continue;
    // Strings, numbers and booleans only. An object or array here would be a
    // caller handing over a row.
    if (typeof v === 'object') continue;
    out[key] = typeof v === 'string' ? v.slice(0, 64) : v;
  }
  return out;
}

/**
 * Record that a NEW account was created.
 *
 * Call this only after the insert is durable — after the transaction commits,
 * or after a single-statement insert has returned a row. Do NOT call it for an
 * existing user signing in, for a failed registration, or for an insert that
 * `ON CONFLICT DO NOTHING` skipped: the caller is responsible for proving a row
 * was actually created, because only the caller can see the RETURNING result.
 *
 * Deliberately NOT async and deliberately returns nothing, so it cannot be
 * awaited by accident and cannot put a vendor's latency in front of a signup.
 *
 * @param {object} args
 * @param {string} args.userId         internal user id — used as distinctId
 * @param {string} args.signupMethod   how the account was created
 * @param {string} args.role           'patient' | 'doctor'
 * @param {string} [args.surface]      'web' | 'mobile' | 'api'
 */
function captureSignup(args) {
  try {
    // Destructured INSIDE the try, not in the parameter list. A parameter-list
    // destructure of `undefined` throws before any try/catch in the body can
    // see it — so `captureSignup()` with no argument would have taken down the
    // very registration this module promises never to break. The unit test
    // calls it with no argument for exactly that reason.
    const { userId, signupMethod, role, surface } = args || {};

    const ph = getClient();
    if (!ph) return;

    const distinctId = String(userId || '').trim();
    // No id, no event. An anonymous signup row is worse than a missing one:
    // it inflates the count and cannot be joined to anything.
    if (!distinctId) return;

    // `role` is never allowed to be absent. The signup report filters on
    // role = 'patient', so an event with no role would silently fall out of
    // the numbers rather than showing up as something to investigate.
    // 'unknown' is deliberately ugly: it is meant to be noticed in PostHog.
    const safeRole = String(role || '').trim() || 'unknown';

    ph.capture({
      distinctId: distinctId,
      event: 'user_signed_up',
      properties: sanitizeProps({
        signup_method: signupMethod,
        role: safeRole,
        surface: surface,
      }),
    });
  } catch (err) {
    // Swallowed on purpose. A registration must not fail because an analytics
    // vendor is unreachable, rate-limiting us, or shipped a breaking change.
    try { logFatal('[analytics] captureSignup failed', err); } catch (_) {}
  }
}

/**
 * Flush queued events and stop the client. Called from gracefulShutdown.
 *
 * Never rejects: shutdown chains on this, and a hanging or throwing flush would
 * turn a clean redeploy into the 10-second force-exit path.
 *
 * @returns {Promise<void>}
 */
async function shutdownAnalytics() {
  try {
    // Not getClient(): if nothing ever captured, there is no client to flush
    // and constructing one here just to close it would open a connection
    // during shutdown.
    if (!client) return;
    if (typeof client.shutdown === 'function') {
      await client.shutdown();
    } else if (typeof client.flush === 'function') {
      await client.flush();
    }
  } catch (err) {
    try { logFatal('[analytics] flush on shutdown failed', err); } catch (_) {}
  }
}

/** Test seam — reports whether analytics is live, and why not if it isn't. */
function analyticsStatus() {
  return {
    enabled: !!getClient(),
    host: HOST,
    reason: disabledReason,
  };
}

module.exports = {
  captureSignup,
  shutdownAnalytics,
  analyticsStatus,
  // Exported for the unit test only.
  _sanitizeProps: sanitizeProps,
  _ALLOWED_PROPS: ALLOWED_PROPS,
};
