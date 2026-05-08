# `src/locales/` — Archived 2026-05-08

**Status:** archived, read-only reference.
**Archived by:** Theme 10 (Arabic i18n) Phase 1.
**Original location:** `src/locales/`.
**New location:** `src/locales.archived-2026-05/`.
**Tracked under:** `docs/audits/THEME_10_ARABIC_I18N_FIX_PLAN.md` §2B and §4.B.

## Why archived (not deleted)

This directory is a **parallel, never-loaded i18n system**. The audit
confirmed:

- `src/i18n/i18n.js` is the only file that reads `en.json` / `ar.json`.
- Nothing in `src/`, `server.js`, or any route requires `src/i18n/i18n.js`.
- `grep -rn "getTranslator\|require.*i18n/i18n" src/` returns only the
  module's own definition.
- The live i18n catalog is `src/i18n.js` (flat-key inline dictionary,
  exposed via `res.locals.t` and `res.locals.tt`).

Despite being dead, `ar.json` contains real translation work — 68 AR-only
keys (`patientDashboard.*`, `patientOrder.*`) that drift from the EN side
and were never wired into a view. That content is salvageable as a
**reference for Phase 2 bulk translation**, which is why this directory
was renamed via `git mv` rather than deleted outright.

## What it is good for

- **Translation reference** during Theme 10 Phase 2 (bulk Arabic
  translation pass). When translating a portal view, search this
  directory for prior AR phrasing on similar concepts.
- **Audit trail.** The 68 AR-only keys are evidence that contributors
  edited the dead file thinking it was live; the README in the live
  catalog (`src/i18n.js`) now explicitly forbids `locales/*.json` files
  to prevent recurrence.

## When this directory can be deleted

After **all** of the following are true:

1. Theme 10 Phase 2 (bulk translation) has shipped.
2. Theme 10b (RTL audit) has completed.
3. A follow-up cleanup theme deletes `src/i18n/i18n.js` and `src/i18n/`.

Until then: leave it alone. Do **not** add new translations here. Do **not**
require this module from new code. All new translation work lands in
`src/i18n.js` and inline `tt(key, enFallback, arFallback)` calls in views.

## How to re-load it (emergency rollback only)

If Phase 1 needs to be reverted:

```sh
git mv src/locales.archived-2026-05 src/locales
# revert src/i18n/i18n.js path edit
git checkout HEAD~1 -- src/i18n/i18n.js
```

This restores the prior dead-but-loadable layout. No other code references
this directory.
