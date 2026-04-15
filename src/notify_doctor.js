// src/notify_doctor.js
// Bridges legacy doctor notification calls to the real notify system.

const { queueNotification } = require('./notify');

module.exports = {
  async sendDoctorEmail(toEmail, subject, message) {
    // Queue as internal notification (email service not yet wired)
    console.log('[notify_doctor] email queued (internal)', { toEmail, subject });
    return queueNotification({
      toUserId: toEmail,
      channel: 'internal',
      template: 'doctor_email',
      response: { subject, message },
    });
  },

  async sendDoctorWhatsApp(toNumber, message) {
    // All WhatsApp now goes through queueNotification; kept for backward compat
    console.log('[notify_doctor] whatsapp call redirected to queueNotification', { toNumber });
  }
};
