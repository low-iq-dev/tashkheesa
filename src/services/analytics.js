'use strict';

// src/services/analytics.js — the one PostHog client.
//
// Scope is deliberately narrow: `user_signed_up` (once per account that actually
// reaches the database), the case funnel `case_draft_started` → `case_submitted`
// → `case_paid` split by platform (web | app), and `app_attributed` (the app's
// Play install referrer). Everything here is built around three rules that
// matter more than the feature itself.
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
  // ── Case funnel (app funnel 2026-09-23) ──
  'platform',        // 'web' | 'app' | 'unknown'
  'tier',            // 'standard' | 'vip' | 'urgent'
  'country',         // ISO-3166 alpha-2, e.g. 'EG'
  'amount_egp',      // case_paid only: rounded integer EGP charged
  // ── App install attribution (app_attributed) ──
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
]);

// Default string cap, and the wider one for campaign strings (ad platforms
// routinely produce utm_campaign values past 64 characters).
const DEFAULT_MAX_LEN = 64;
const MAX_LEN = { utm_source: 100, utm_medium: 100, utm_campaign: 100, utm_content: 100, utm_term: 100 };

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
    out[key] = typeof v === 'string' ? v.slice(0, MAX_LEN[key] || DEFAULT_MAX_LEN) : v;
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

// ── Case funnel: case_draft_started → case_submitted → case_paid ───────────
//
// Same three rules as captureSignup: synchronous, returns nothing, throws
// nothing, never awaited. Props are the allow-listed funnel dimensions only —
// NOT the specialty (a specialty tied to a person is health data: "this user
// is an oncology patient"), no clinical text, no names/contacts.

const FUNNEL_EVENTS = new Set(['case_draft_started', 'case_submitted', 'case_paid']);
const PLATFORMS = new Set(['web', 'app', 'unknown']);
const TIERS = new Set(['standard', 'vip', 'urgent']);

function normPlatform(p) {
  const v = String(p || '').trim().toLowerCase();
  return PLATFORMS.has(v) ? v : 'unknown';
}

function normTier(tier) {
  let v = String(tier || '').trim().toLowerCase();
  if (v === 'fast_track' || v === 'fast') v = 'vip';
  return TIERS.has(v) ? v : undefined;
}

function normCountry(c) {
  const v = String(c || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : undefined;
}

/**
 * Which surface created an order, from orders.source.
 *   patient_app_v1    → 'app'  (api/cases_draft.js)
 *   patient_wizard_v2 → 'web'  (routes/patient.js wizard)
 *   anything else     → 'unknown' — 'website_portal' is BOTH the column
 *     default (so POST /api/v1/cases rows carry it) and what the public
 *     website intake writes, so it cannot be attributed honestly.
 * @param {string} source
 * @returns {'web'|'app'|'unknown'}
 */
function platformFromOrderSource(source) {
  const v = String(source || '').trim().toLowerCase();
  if (v === 'patient_app_v1') return 'app';
  if (v === 'patient_wizard_v2') return 'web';
  return 'unknown';
}

/**
 * Record one step of the case funnel. Fire-and-forget; never await it.
 *
 * @param {string} event  'case_draft_started' | 'case_submitted' | 'case_paid'
 * @param {object} args
 * @param {string} args.userId     patient user id — distinctId
 * @param {string} args.platform   'web' | 'app' (else 'unknown')
 * @param {string} [args.tier]     urgency tier
 * @param {string} [args.country]  ISO2
 * @param {number} [args.amountEgp] case_paid only
 */
function captureFunnel(event, args) {
  try {
    if (!FUNNEL_EVENTS.has(event)) return;
    const { userId, platform, tier, country, amountEgp } = args || {};

    const ph = getClient();
    if (!ph) return;

    const distinctId = String(userId || '').trim();
    if (!distinctId) return;

    let amount;
    if (event === 'case_paid') {
      const n = Math.round(Number(amountEgp));
      if (Number.isFinite(n) && n >= 0) amount = n;
    }

    ph.capture({
      distinctId: distinctId,
      event: event,
      properties: sanitizeProps({
        // platform is never absent — a funnel split on it must not silently
        // lose rows. 'unknown' is meant to be noticed.
        platform: normPlatform(platform),
        tier: normTier(tier),
        country: normCountry(country),
        amount_egp: amount,
      }),
    });
  } catch (err) {
    try { logFatal('[analytics] captureFunnel failed', err); } catch (_) {}
  }
}

// ── App install attribution ─────────────────────────────────────────────────
//
// The app reads Play's install referrer once and POSTs it to
// /api/v1/profile/attribution. We store nothing; we capture `app_attributed`
// and set first-touch person properties with $set_once (so a repeat can never
// overwrite the first source). Repeats from the same user in this process are
// ignored outright — idempotent, and it caps what a looping client can cost.

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const attributedUsers = new Set();
const ATTRIBUTED_CAP = 10000;

/**
 * Keep only the five utm_* keys as short printable strings.
 * @param {object} input
 * @returns {object}
 */
function sanitizeUtm(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of UTM_KEYS) {
    const v = input[k];
    if (typeof v !== 'string') continue;
    // Printable only; control characters are nobody's campaign name.
    const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
    if (s) out[k] = s;
  }
  return out;
}

/**
 * Record where an app install came from. Fire-and-forget; never await it.
 * @param {object} args
 * @param {string} args.userId
 * @param {object} args.utm   {utm_source, utm_medium, utm_campaign, utm_content, utm_term}
 * @returns {boolean} true if an event was queued (for the route's response)
 */
function captureAppAttribution(args) {
  try {
    const { userId, utm } = args || {};
    const distinctId = String(userId || '').trim();
    if (!distinctId) return false;
    const clean = sanitizeUtm(utm);
    if (!Object.keys(clean).length) return false;
    if (attributedUsers.has(distinctId)) return false;

    const ph = getClient();
    if (!ph) return false;

    if (attributedUsers.size >= ATTRIBUTED_CAP) attributedUsers.clear();
    attributedUsers.add(distinctId);

    const firstTouch = {};
    for (const k of Object.keys(clean)) firstTouch['first_' + k] = clean[k];

    ph.capture({
      distinctId: distinctId,
      event: 'app_attributed',
      properties: Object.assign(sanitizeProps(Object.assign({ platform: 'app' }, clean)), {
        $set_once: firstTouch,
      }),
    });
    return true;
  } catch (err) {
    try { logFatal('[analytics] captureAppAttribution failed', err); } catch (_) {}
    return false;
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
  captureFunnel,
  captureAppAttribution,
  platformFromOrderSource,
  shutdownAnalytics,
  analyticsStatus,
  // Exported for the unit test only.
  _sanitizeProps: sanitizeProps,
  _ALLOWED_PROPS: ALLOWED_PROPS,
  _sanitizeUtm: sanitizeUtm,
  _FUNNEL_EVENTS: FUNNEL_EVENTS,
  _resetAttributionMemo: function () { attributedUsers.clear(); },
};
