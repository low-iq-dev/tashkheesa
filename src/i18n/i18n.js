const fs = require('fs');
const path = require('path');

const localesPath = path.join(__dirname, '..', 'locales');

const en = JSON.parse(fs.readFileSync(path.join(localesPath, 'en.json')));
const ar = JSON.parse(fs.readFileSync(path.join(localesPath, 'ar.json')));

function getTranslator(lang = 'en') {
  const dict = lang === 'ar' ? ar : en;

  function t(key) {
    return key.split('.').reduce((obj, part) => {
      return obj && obj[part] !== undefined ? obj[part] : key;
    }, dict);
  }

  return t;
}

module.exports = { getTranslator };