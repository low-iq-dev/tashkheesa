/**
 * Tashkheesa Instagram Automation - Configuration
 */

module.exports = {
  graphApiVersion: 'v21.0',
  graphApiBaseUrl: 'https://graph.facebook.com',

  appId: process.env.META_APP_ID,
  appSecret: process.env.META_APP_SECRET,
  accessToken: process.env.IG_ACCESS_TOKEN,
  igAccountId: process.env.IG_BUSINESS_ACCOUNT_ID,
  fbPageId: process.env.FB_PAGE_ID,
  mediaBaseUrl: process.env.MEDIA_BASE_URL || 'https://tashkheesa.com/media/instagram',

  limits: {
    postsPerDay: 25,
    carouselMinItems: 2,
    carouselMaxItems: 10,
    captionMaxLength: 2200,
    hashtagMax: 30,
    containerPollInterval: 2000,
    containerPollTimeout: 120000,
    rateLimitPerHour: 200,
  },

  defaultSchedule: {
    timezone: 'Africa/Cairo',
    slots: [
      { day: 'Monday',    time: '09:00' },
      { day: 'Wednesday', time: '12:00' },
      { day: 'Friday',    time: '18:00' },
    ],
  },
};
