// src/routes/app_landing.js
// Device-aware app landing page + waitlist endpoint for /app campaign

var express = require('express');
var { execute } = require('../pg');
var { major: logMajor } = require('../logger');

var router = express.Router();

// ── Device detection ────────────────────────────────────

function detectVariant(ua) {
  if (!ua) return 'desktop';
  // iPad can report as Macintosh in newer Safari, but with touch — server-side
  // we only catch the classic iPad UA. Fine for campaign purposes.
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

// ── Analytics helper (fire-and-forget) ──────────────────

function logAppEvent(event, variant, req, meta) {
  var ua = req.get('user-agent') || '';
  var referrer = req.get('referer') || '';
  var utm_source = req.query.utm_source || null;
  var utm_campaign = req.query.utm_campaign || null;
  var ip = req.ip || '';

  execute(
    `INSERT INTO app_analytics_events (event, variant, ip, user_agent, referrer, utm_source, utm_campaign, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [event, variant, ip, ua, referrer, utm_source, utm_campaign, meta ? JSON.stringify(meta) : null]
  ).catch(function (err) {
    // Non-fatal — don't crash if analytics table doesn't exist yet
    logMajor('[app-landing] analytics insert failed: ' + err.message);
  });
}

// ── GET /app — render device-appropriate variant ────────

var TESTFLIGHT_URL = process.env.TESTFLIGHT_URL || 'https://tashkheesa.com/app';

router.get('/app', function (req, res) {
  var ua = req.get('user-agent') || '';
  var variant = detectVariant(ua);

  // Log page view
  logAppEvent('page_view', variant, req);

  res.render('app_landing', {
    layout: 'public',
    title: 'Tashkheesa App',
    description: 'Upload your scans, chat with your specialist, get your report — all from your phone.',
    showNav: true,
    showFooter: true,
    robots: 'noindex, nofollow',
    variant: variant,
    testflightUrl: TESTFLIGHT_URL,
    utm_source: req.query.utm_source || '',
    utm_campaign: req.query.utm_campaign || ''
  });
});

// ── POST /app/waitlist — email capture ──────────────────

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.post('/app/waitlist', async function (req, res) {
  var body = req.body || {};
  var email = String(body.email || '').trim().toLowerCase();
  var platform = String(body.platform || '').trim().toLowerCase();

  // Validate email
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  }

  // Validate platform
  var validPlatforms = ['android', 'ios_other', 'other'];
  if (!validPlatforms.includes(platform)) {
    platform = 'other';
  }

  var ua = req.get('user-agent') || '';
  var referrer = req.get('referer') || '';
  var utm_source = body.utm_source || req.query.utm_source || null;
  var utm_campaign = body.utm_campaign || req.query.utm_campaign || null;

  try {
    await execute(
      `INSERT INTO app_waitlist (email, platform, user_agent, referrer, utm_source, utm_campaign)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email, platform) DO NOTHING`,
      [email, platform, ua, referrer, utm_source, utm_campaign]
    );

    // Log to ops
    logMajor('[app-waitlist] New signup: ' + email + ' (' + platform + ')');
    logAppEvent('waitlist_signup', platform, req, { email: email });

    return res.json({ ok: true });
  } catch (err) {
    logMajor('[app-waitlist] Error: ' + err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// ── POST /app/analytics — CTA click tracking ───────────

router.post('/app/analytics', function (req, res) {
  var body = req.body || {};
  var event = String(body.event || '').trim();
  var variant = String(body.variant || '').trim();

  if (!event || !variant) {
    return res.status(400).json({ ok: false });
  }

  logAppEvent(event, variant, req, body.meta || null);
  return res.json({ ok: true });
});

module.exports = router;
