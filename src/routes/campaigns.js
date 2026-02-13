// src/routes/campaigns.js
// Email Marketing Campaigns (Phase 11)

const express = require('express');
const { randomUUID } = require('crypto');
const crypto = require('crypto');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { sanitizeHtml, sanitizeString } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');
const { safeAll, safeGet } = require('../sql-utils');

const router = express.Router();

const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'tash-unsub-2024';

// Sign a user ID for unsubscribe token
function signUnsubscribeToken(userId) {
  var hmac = crypto.createHmac('sha256', UNSUBSCRIBE_SECRET);
  hmac.update(String(userId));
  return Buffer.from(userId + ':' + hmac.digest('hex')).toString('base64url');
}

// Verify unsubscribe token
function verifyUnsubscribeToken(token) {
  try {
    var decoded = Buffer.from(token, 'base64url').toString('utf-8');
    var parts = decoded.split(':');
    if (parts.length !== 2) return null;
    var userId = parts[0];
    var sig = parts[1];
    var expected = crypto.createHmac('sha256', UNSUBSCRIBE_SECRET).update(userId).digest('hex');
    if (sig === expected) return userId;
    return null;
  } catch (_) {
    return null;
  }
}

// GET /portal/admin/campaigns — List all campaigns
router.get('/portal/admin/campaigns', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var campaigns = safeAll(
      'SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 100',
      [], []
    );

    res.render('admin_campaigns', {
      campaigns: campaigns,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'حملات البريد الإلكتروني' : 'Email Campaigns'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/admin/campaigns/new — Create campaign form
router.get('/portal/admin/campaigns/new', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    res.render('admin_campaign_new', {
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'حملة جديدة' : 'New Campaign'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /portal/admin/campaigns — Create campaign
router.post('/portal/admin/campaigns', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var name = sanitizeString(req.body.name || '', 200).trim();
    var subjectEn = sanitizeString(req.body.subject_en || '', 500).trim();
    var subjectAr = sanitizeString(req.body.subject_ar || '', 500).trim();
    var template = sanitizeHtml(sanitizeString(req.body.template || '', 50000));
    var targetAudience = sanitizeString(req.body.target_audience || 'all', 50).trim();
    var scheduledAt = sanitizeString(req.body.scheduled_at || '', 30).trim();

    if (!name || !subjectEn || !template) {
      return res.status(400).json({ ok: false, error: isAr ? 'الاسم والموضوع والقالب مطلوبة' : 'Name, subject, and template are required' });
    }

    var validAudiences = ['all', 'patients', 'doctors', 'completed_cases', 'inactive_30d'];
    if (!validAudiences.includes(targetAudience)) targetAudience = 'all';

    var id = randomUUID();
    var status = scheduledAt ? 'scheduled' : 'draft';
    var now = new Date().toISOString();

    db.prepare(
      `INSERT INTO email_campaigns (id, name, subject_en, subject_ar, template, target_audience, status, scheduled_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, subjectEn, subjectAr || null, template, targetAudience, status, scheduledAt || null, req.user.id, now);

    // Pre-populate recipients
    var recipientCount = populateRecipients(id, targetAudience);
    db.prepare('UPDATE email_campaigns SET total_recipients = ? WHERE id = ?').run(recipientCount, id);

    return res.json({ ok: true, id: id, message: isAr ? 'تم إنشاء الحملة' : 'Campaign created', recipientCount: recipientCount });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /portal/admin/campaigns/:id — Campaign detail
router.get('/portal/admin/campaigns/:id', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var campaignId = String(req.params.id).trim();
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var campaign = safeGet('SELECT * FROM email_campaigns WHERE id = ?', [campaignId], null);
    if (!campaign) return res.status(404).send('Campaign not found');

    var recipients = safeAll(
      'SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY status, created_at LIMIT 200',
      [campaignId], []
    );

    res.render('admin_campaign_detail', {
      campaign: campaign,
      recipients: recipients,
      lang: lang,
      isAr: isAr,
      pageTitle: campaign.name
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /portal/admin/campaigns/:id/send — Trigger send
router.post('/portal/admin/campaigns/:id/send', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var campaignId = String(req.params.id).trim();
    var campaign = safeGet('SELECT * FROM email_campaigns WHERE id = ?', [campaignId], null);
    if (!campaign) return res.status(404).json({ ok: false, error: 'Not found' });

    if (campaign.status === 'sent') {
      return res.status(400).json({ ok: false, error: 'Campaign already sent' });
    }

    // Mark as sending
    db.prepare("UPDATE email_campaigns SET status = 'sending' WHERE id = ?").run(campaignId);

    // Start sending in background (fire-and-forget)
    setImmediate(function() {
      try { processCampaign(campaignId); } catch (_) {}
    });

    return res.json({ ok: true, message: 'Campaign sending started' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/admin/campaigns/:id/cancel — Cancel scheduled campaign
router.post('/portal/admin/campaigns/:id/cancel', requireRole('admin', 'superadmin'), function(req, res) {
  try {
    var campaignId = String(req.params.id).trim();
    db.prepare("UPDATE email_campaigns SET status = 'cancelled' WHERE id = ? AND status IN ('draft', 'scheduled')").run(campaignId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /unsubscribe/:token — One-click unsubscribe
router.get('/unsubscribe/:token', function(req, res) {
  try {
    var token = String(req.params.token).trim();
    var userId = verifyUnsubscribeToken(token);

    if (!userId) {
      return res.status(400).send('<h1>Invalid unsubscribe link</h1><p>This link may have expired or is invalid.</p>');
    }

    db.prepare('UPDATE users SET email_marketing_opt_out = 1 WHERE id = ?').run(userId);

    return res.send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:3rem;">' +
      '<h1 style="color:#1a365d;">Unsubscribed</h1>' +
      '<p style="color:#64748b;">You have been successfully unsubscribed from marketing emails.</p>' +
      '<p style="color:#94a3b8;font-size:0.85rem;">You will still receive important account notifications.</p>' +
      '</body></html>'
    );
  } catch (err) {
    return res.status(500).send('Error processing unsubscribe request');
  }
});

// Helper: populate recipients based on audience
function populateRecipients(campaignId, audience) {
  var query;
  switch (audience) {
    case 'patients':
      query = "SELECT id, email FROM users WHERE role = 'patient' AND is_active = 1 AND email_marketing_opt_out = 0 AND email IS NOT NULL";
      break;
    case 'doctors':
      query = "SELECT id, email FROM users WHERE role = 'doctor' AND is_active = 1 AND email_marketing_opt_out = 0 AND email IS NOT NULL";
      break;
    case 'completed_cases':
      query = "SELECT DISTINCT u.id, u.email FROM users u JOIN orders o ON o.patient_id = u.id WHERE o.status = 'completed' AND u.is_active = 1 AND u.email_marketing_opt_out = 0 AND u.email IS NOT NULL";
      break;
    case 'inactive_30d':
      query = "SELECT u.id, u.email FROM users u WHERE u.role = 'patient' AND u.is_active = 1 AND u.email_marketing_opt_out = 0 AND u.email IS NOT NULL AND u.id NOT IN (SELECT DISTINCT patient_id FROM orders WHERE created_at > datetime('now', '-30 days'))";
      break;
    default: // all
      query = "SELECT id, email FROM users WHERE is_active = 1 AND email_marketing_opt_out = 0 AND email IS NOT NULL";
  }

  var users = safeAll(query, [], []);
  var now = new Date().toISOString();

  var insert = db.prepare('INSERT INTO campaign_recipients (id, campaign_id, user_id, email, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  var insertMany = db.transaction(function(rows) {
    rows.forEach(function(u) {
      insert.run(randomUUID(), campaignId, u.id, u.email, 'pending', now);
    });
  });

  insertMany(users);
  return users.length;
}

// Helper: process campaign sending
function processCampaign(campaignId) {
  var sendEmailFn;
  try { sendEmailFn = require('../services/emailService').sendEmail; } catch (_) { return; }

  var campaign = safeGet('SELECT * FROM email_campaigns WHERE id = ?', [campaignId], null);
  if (!campaign) return;

  var recipients = safeAll(
    "SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' LIMIT 1000",
    [campaignId], []
  );

  var sentCount = 0;
  var failedCount = 0;
  var APP_URL = process.env.APP_URL || 'https://tashkheesa.com';

  // Process sequentially with rate limiting (max ~5/sec via setTimeout)
  var idx = 0;
  function sendNext() {
    if (idx >= recipients.length) {
      // Done - update campaign
      db.prepare("UPDATE email_campaigns SET status = 'sent', sent_at = ?, total_sent = ?, total_failed = ? WHERE id = ?")
        .run(new Date().toISOString(), sentCount, failedCount, campaignId);
      return;
    }

    var r = recipients[idx];
    idx++;

    var unsubToken = signUnsubscribeToken(r.user_id);
    var unsubUrl = APP_URL + '/unsubscribe/' + unsubToken;

    // Determine user lang
    var userRow = safeGet('SELECT lang FROM users WHERE id = ?', [r.user_id], { lang: 'en' });
    var userLang = (userRow && userRow.lang === 'ar') ? 'ar' : 'en';
    var subject = userLang === 'ar' && campaign.subject_ar ? campaign.subject_ar : campaign.subject_en;

    sendEmailFn({
      to: r.email,
      subject: subject,
      template: 'campaign',
      lang: userLang,
      data: {
        content: campaign.template,
        campaignName: campaign.name,
        unsubscribeUrl: unsubUrl
      }
    }).then(function(result) {
      if (result && result.ok) {
        db.prepare("UPDATE campaign_recipients SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
        sentCount++;
      } else {
        db.prepare("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?").run((result && result.error) || 'Send failed', r.id);
        failedCount++;
      }
      // Rate limit: ~5/sec
      setTimeout(sendNext, 200);
    }).catch(function(err) {
      db.prepare("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?").run(err.message || 'Error', r.id);
      failedCount++;
      setTimeout(sendNext, 200);
    });
  }

  sendNext();
}

module.exports = router;
module.exports.signUnsubscribeToken = signUnsubscribeToken;
module.exports.processCampaign = processCampaign;
