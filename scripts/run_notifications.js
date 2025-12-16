require('dotenv').config();
const { migrate } = require('../src/db');
const { runNotificationWorker } = require('../src/notification_worker');

(async () => {
  try {
    console.log('Running notification worker...');
    migrate();
    await runNotificationWorker(50);
    console.log('Notification worker complete.');
    process.exit(0);
  } catch (err) {
    console.error('Notification worker failed', err);
    process.exit(1);
  }
})();
