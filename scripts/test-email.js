#!/usr/bin/env node
/**
 * Tashkheesa Email Delivery Test
 * Sends a test email via Resend (using RESEND_API_KEY from .env) to verify
 * delivery works end-to-end. Bypasses recipientGuard and the templated
 * sendEmail wrappers so this script reflects pure transport health.
 *
 * Usage: node scripts/test-email.js
 */

try { require('@dotenvx/dotenvx').config(); } catch (_) { require('dotenv').config(); }
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'noreply@tashkheesa.com';
const FROM_NAME = process.env.SMTP_FROM_NAME || 'Tashkheesa';
const TO_EMAIL = process.argv[2] || 'info@tashkheesa.com';

async function main() {
  console.log('Email Delivery Test (Resend)');
  console.log('============================');
  console.log(`API key:  ${RESEND_API_KEY ? '***' + RESEND_API_KEY.slice(-4) : 'NOT SET'}`);
  console.log(`From:     ${FROM_NAME} <${FROM_EMAIL}>`);
  console.log(`To:       ${TO_EMAIL}`);
  console.log();

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not configured in .env');
    process.exit(1);
  }

  const resend = new Resend(RESEND_API_KEY);

  console.log('Sending test email...');
  const { data, error } = await resend.emails.send({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to: [TO_EMAIL],
    subject: `Tashkheesa Email Test — ${new Date().toISOString()}`,
    text: 'This is a test email from the Tashkheesa platform.\n\nIf you received this, email delivery is working correctly.',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #0D6EFD;">Tashkheesa Email Test</h2>
        <p>This is a test email from the Tashkheesa platform.</p>
        <p>If you received this, email delivery is working correctly.</p>
        <hr style="border: 1px solid #eee;">
        <p style="color: #888; font-size: 12px;">Sent at ${new Date().toISOString()}</p>
      </div>
    `,
  });

  if (error) {
    console.error(`Email test FAILED: ${error.name}: ${error.message}`);
    process.exit(1);
  }

  console.log('Email sent successfully!');
  console.log(`Message ID: ${data && data.id}`);
  console.log('Verify delivery in the Resend dashboard: https://resend.com/emails');
}

main().catch((err) => {
  console.error(`Email test FAILED: ${err.message}`);
  process.exit(1);
});
