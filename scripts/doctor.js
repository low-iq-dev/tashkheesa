const fs = require('fs');

console.log('node', process.version);

if (!fs.existsSync('package-lock.json')) {
  console.error('⛔ Missing package-lock.json — run npm i and commit the lockfile');
  process.exit(1);
}

console.log('✅ package-lock.json present');
