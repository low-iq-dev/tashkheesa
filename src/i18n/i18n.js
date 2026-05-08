// DEAD CODE — see docs/audits/THEME_10_ARABIC_I18N_FIX_PLAN.md §2B.
// This module is not required by any production code path. It is kept in
// the tree only because Theme 10 Phase 1 archived `src/locales/` to
// `src/locales.archived-2026-05/`. Theme 10 Phase 0 cleanup will delete
// both this file and the archived locales once Phase 2 migration completes.
//
// The path below is updated to track the rename so this file remains
// loadable if anyone accidentally requires it; nobody currently does.
const fs = require('fs');
const path = require('path');

const localesPath = path.join(__dirname, '..', 'locales.archived-2026-05');

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