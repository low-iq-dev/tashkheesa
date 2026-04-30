// scripts/notification-health.js
// Notification system health check: email transport, WhatsApp, queue depth

const path = require('path');

// Load .env if available
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
  // dotenv may not be available in all environments
}

const results = [];
let hasError = false;

function check(label, ok, detail) {
  const status = ok ? '✅' : '⚠️ ';
  results.push({ label, ok, detail });
  console.log(`${status} ${label}${detail ? ': ' + detail : ''}`);
  if (!ok) hasError = true;
}

// 1. Check email transport (Resend) configuration
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';
if (EMAIL_ENABLED) {
  const apiKey = process.env.RESEND_API_KEY || '';
  const fromEmail = process.env.SMTP_FROM_EMAIL || '';
  const fromName = process.env.SMTP_FROM_NAME || '';

  check('Email (Resend) enabled', true);
  check('RESEND_API_KEY configured', !!apiKey, apiKey ? '***' : 'not set');
  check('SMTP_FROM_EMAIL configured', !!fromEmail, fromEmail || 'not set (defaults to noreply@tashkheesa.com)');
  check('SMTP_FROM_NAME configured', !!fromName, fromName || 'not set (defaults to Tashkheesa)');

  // Resend has no SMTP-style handshake to verify; verifyConnection() resolves
  // true once the API key is present. The first real send surfaces auth
  // errors via the standard error path.
  if (apiKey) {
    try {
      const { verifyConnection } = require('../src/services/emailService');
      verifyConnection()
        .then((r) => {
          if (r.ok) {
            console.log('✅ Email transport ready (Resend)');
          } else {
            console.log('⚠️  Email transport not ready: ' + (r.error || 'unknown'));
          }
        })
        .catch((e) => {
          console.log('⚠️  Email transport check error: ' + e.message);
        });
    } catch (e) {
      check('Email transport check', false, 'emailService import failed: ' + e.message);
    }
  }
} else {
  check('Email (Resend) disabled', true, 'EMAIL_ENABLED is not true');
}

// 2. Check WhatsApp configuration
const WA_ENABLED = String(process.env.WHATSAPP_ENABLED || 'false').toLowerCase() === 'true';
if (WA_ENABLED) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';

  check('WhatsApp enabled', true);
  check('WHATSAPP_PHONE_NUMBER_ID configured', !!phoneId, phoneId ? '***' : 'not set');
  check('WHATSAPP_ACCESS_TOKEN configured', !!token, token ? '***' : 'not set');
  check('WHATSAPP_API_VERSION valid', /^v\d+\.\d+$/.test(apiVersion), apiVersion);
} else {
  check('WhatsApp disabled', true, 'WHATSAPP_ENABLED is not true');
}

// 3. Check notification queue depth
try {
  // Set DB path for health check
  if (!process.env.PORTAL_DB_PATH) {
    process.env.PORTAL_DB_PATH = path.join(__dirname, '..', 'data', 'portal.db');
  }

  const { db } = require('../src/db');

  const queued = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE status = 'queued'").get().c;
  const retry = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE status = 'retry'").get().c;
  const failed = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE status = 'failed'").get().c;
  const total = db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c;

  check('Queue depth (queued)', queued < 500, `${queued} notifications queued`);
  check('Queue depth (retry)', retry < 100, `${retry} notifications in retry`);
  check('Failed notifications', true, `${failed} failed of ${total} total`);
} catch (e) {
  check('Notification queue check', false, 'DB error: ' + e.message);
}

// 4. Check worker configuration
const workerEnabled = String(process.env.NOTIFICATION_WORKER_ENABLED || 'false').toLowerCase() === 'true';
const workerInterval = parseInt(process.env.NOTIFICATION_WORKER_INTERVAL_MS || '30000', 10);
const maxRetries = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
const dryRun = String(process.env.NOTIFICATION_DRY_RUN || 'false').toLowerCase() === 'true';

check('Worker enabled', true, workerEnabled ? 'yes' : 'no (notifications will queue but not send)');
if (workerEnabled) {
  check('Worker interval', workerInterval >= 5000, `${workerInterval}ms`);
  check('Max retries', maxRetries >= 1 && maxRetries <= 10, String(maxRetries));
  check('Dry run mode', !dryRun, dryRun ? 'DRY RUN — notifications will NOT actually send' : 'off');
}

// 5. Check template files exist
const fs = require('fs');
const templatesDir = path.join(__dirname, '..', 'src', 'templates', 'email', 'en');
const requiredTemplates = [
  '_layout.hbs',
  'case-submitted.hbs',
  'case-assigned.hbs',
  'report-ready.hbs',
  'payment-success.hbs',
  'payment-failed.hbs',
  'case-accepted.hbs',
  'appointment-reminder.hbs',
  'appointment-scheduled.hbs',
  'sla-warning.hbs',
  'case-reassigned.hbs',
  'welcome.hbs',
  'doctor-welcome.hbs',
];

const missingTemplates = requiredTemplates.filter(t => !fs.existsSync(path.join(templatesDir, t)));
check('Email templates (EN)', missingTemplates.length === 0,
  missingTemplates.length ? `Missing: ${missingTemplates.join(', ')}` : `${requiredTemplates.length} templates present`);

const arTemplatesDir = path.join(__dirname, '..', 'src', 'templates', 'email', 'ar');
const arExists = fs.existsSync(arTemplatesDir);
check('Email templates (AR)', arExists, arExists ? 'Arabic template directory exists' : 'Arabic directory missing');

console.log('\n✅ Notification health check complete');
if (hasError) {
  console.log('⚠️  Some checks reported warnings — review above');
}
