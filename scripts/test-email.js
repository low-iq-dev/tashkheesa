#!/usr/bin/env node
/**
 * Tashkheesa Email Delivery Test
 * Sends a test email using SMTP config from .env to verify delivery works.
 *
 * Usage: node scripts/test-email.js
 */

try { require('@dotenvx/dotenvx').config(); } catch (_) { require('dotenv').config(); }
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_SECURE = String(process.env.SMTP_SECURE) === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER;
const FROM_NAME = process.env.SMTP_FROM_NAME || 'Tashkheesa';
const TO_EMAIL = 'info@tashkheesa.com';

async function main() {
  console.log('Email Delivery Test');
  console.log('===================');
  console.log(`SMTP Host:   ${SMTP_HOST}`);
  console.log(`SMTP Port:   ${SMTP_PORT}`);
  console.log(`SMTP Secure: ${SMTP_SECURE}`);
  console.log(`SMTP User:   ${SMTP_USER}`);
  console.log(`From:        ${FROM_NAME} <${FROM_EMAIL}>`);
  console.log(`To:          ${TO_EMAIL}`);
  console.log();

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.error('SMTP credentials not configured in .env');
    console.error('Required: SMTP_HOST, SMTP_USER, SMTP_PASS');
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  console.log('Verifying SMTP connection...');
  await transporter.verify();
  console.log('SMTP connection verified.\n');

  console.log('Sending test email...');
  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to: TO_EMAIL,
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

  console.log(`Email sent successfully!`);
  console.log(`Message ID: ${info.messageId}`);
  console.log(`Response:   ${info.response}`);
}

main().catch((err) => {
  console.error(`Email test FAILED: ${err.message}`);
  process.exit(1);
});
