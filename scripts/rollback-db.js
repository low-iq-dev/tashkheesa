'use strict';

// rollback:db is legacy SQLite tooling — RETIRED. Prod is Postgres; the old
// script copied backups/<file>.db over data/portal.db, which restores nothing
// on a Postgres deployment (an operator would think they had rolled back when
// they hadn't). A Postgres restore is a deliberate, destructive pg_restore that
// must be run by hand against the intended DATABASE_URL — never a casual npm
// script that could nuke prod.

console.error([
  '⛔ rollback:db is legacy SQLite tooling and has been retired — prod is Postgres.',
  '',
  'To restore a Postgres backup created by `npm run backup:db`:',
  '',
  '  pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" backups/<file>.dump',
  '',
  '(Stop the server first, run it deliberately against the intended DATABASE_URL.',
  'See RELEASE_CHECKLIST.md § DB rollback.)'
].join('\n'));
process.exit(1);
