// src/video_helpers.js
// Twilio Video token generation and room name helpers.

require('dotenv').config();
const twilio = require('twilio');

// ⚠️ REQUIRES ENV VARS: TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET — set in Render dashboard before this will work
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const RAW_API_KEY = process.env.TWILIO_API_KEY || '';
const RAW_API_SECRET = process.env.TWILIO_API_SECRET || '';
const VIDEO_ENABLED = String(process.env.VIDEO_CONSULTATION_ENABLED || 'false') === 'true';

// If API Key equals Account SID, no dedicated API key is configured — fall back
// to Account SID + Auth Token, which is valid for development token generation.
const API_KEY = (RAW_API_KEY && RAW_API_KEY !== ACCOUNT_SID) ? RAW_API_KEY : ACCOUNT_SID;
const API_SECRET = (RAW_API_SECRET && RAW_API_SECRET !== AUTH_TOKEN) ? RAW_API_SECRET : AUTH_TOKEN;

const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

/**
 * Returns a deterministic Twilio room name for an appointment.
 * @param {string} appointmentId
 * @returns {string}
 */
function getRoomName(appointmentId) {
  return `tashkheesa-${appointmentId}`;
}

/**
 * Returns true if video consultation feature is enabled and Twilio credentials are configured.
 * @returns {boolean}
 */
function isVideoEnabled() {
  return VIDEO_ENABLED && Boolean(ACCOUNT_SID) && Boolean(API_KEY) && Boolean(API_SECRET);
}

/**
 * Generate a Twilio Video access token for a participant.
 * @param {string} roomName  - Twilio room name (use getRoomName())
 * @param {string} identity  - Unique participant identity (user ID or "patient-{id}" / "doctor-{id}")
 * @returns {{ token: string, roomName: string }}
 */
function generateToken(roomName, identity) {
  if (!ACCOUNT_SID || !API_KEY || !API_SECRET) {
    throw new Error('TWILIO_CREDENTIALS_MISSING: Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET in .env');
  }

  const token = new AccessToken(ACCOUNT_SID, API_KEY, API_SECRET, {
    identity,
    ttl: 3600 // 1 hour
  });

  const videoGrant = new VideoGrant({ room: roomName });
  token.addGrant(videoGrant);

  return {
    token: token.toJwt(),
    roomName
  };
}

module.exports = {
  getRoomName,
  generateToken,
  isVideoEnabled
};
