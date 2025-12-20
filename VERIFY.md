# VERIFY — What to run before you change anything

## The one rule
Before **and** after any change, run:

```bash
npm run verify
```
---

## DB backups & rollback (safe)

List the latest backups (stored in `backups/`):

```bash
npm run backups:list

If verify fails, you stop and fix it before touching anything else.

---

## Local workflow (two terminals)

Because **smoke checks** hit live endpoints, the server must be running.

Terminal A (leave running):
```bash
npm run dev
```

Terminal B (run whenever you change code):
```bash
npm run safe
```

If you can’t (or don’t want to) run the server, you can temporarily run **preflight-only** by running the scripts individually (doctor/db/backup), but the default `verify` expects a running server.

---

## What `verify` does

`verify` runs:

1) `npm run preflight`
   - **doctor** ✅ (Node + lockfile sanity)
   - **smoke** ✅ (health endpoints)
   - **db:integrity** ✅ (SQLite `PRAGMA quick_check`)
   - **backup:db** ✅ (creates timestamped DB backup)

2) Syntax checks for key files (if present) using `node --check`:
   - `src/server.js`
   - `src/db.js`
   - `src/bootCheck.js`
   - `src/sla_watcher.js`
   - `src/case_lifecycle.js`

3) Ensures critical folders exist:
   - `src/routes`
   - `src/views`
   - `public`

---

## If verify fails — what to do

### If it says “smoke failed”

Most common cause: the server is not running (or it crashed on boot).

1) Start the server in Terminal A:
```bash
npm run dev
```

2) If the server crashes with a BootCheck error (common):
- Ensure you are not using `SLA_MODE=primary` in development unless explicitly allowed.
- In your real `.env` (do not commit), set:
```env
SLA_MODE=passive
```
  Or, if you intentionally want primary in dev:
```env
ALLOW_PRIMARY_IN_DEV=true
```

3) Then rerun in Terminal B:
```bash
npm run safe
```

If your server runs on a different URL/port, set:
```bash
SMOKE_BASE_URL=http://localhost:3000 npm run safe
```

### If it says “db integrity failed”
- Stop everything.
- Restore a known-good backup:

```bash
ls -lt backups | head
cp backups/<backup-file>.db data/portal.db
npm run verify
```

### If it says “missing path”
- Create the missing folder or fix the code/config that points to the wrong folder.
- Rerun `npm run verify`.

### If `node --check` fails
- It’s a syntax error.
- Fix the file immediately, then rerun `npm run verify`.

---

## The only safe workflow loop

1) `git status` (must be clean)
2) `npm run verify`
3) Make the smallest possible change
4) `npm run verify`
5) Commit immediately

```bash
git add -A
git commit -m "<type>: <small description>"
```

# VERIFY — What to run before you change anything

## The one rule
Before **and** after any change, run:

```bash
npm run verify
```

If verify fails, you stop and fix it before touching anything else.

---

## Local workflow (two terminals)

Because **smoke checks** hit live endpoints, the server must be running.

Terminal A (leave running):
```bash
npm run dev
```

Terminal B (run whenever you change code):
```bash
npm run safe
```

If you can’t (or don’t want to) run the server, use the **offline** variant (skips smoke):

```bash
npm run safe:offline
```

Use offline only when you’re making changes that don’t require a live server check (docs, scripts, small refactors). Before you push anything important, run the normal `npm run safe` with the server running.

---

## DB backups & rollback (safe)

List the latest backups (stored in `backups/`):

```bash
npm run backups:list
```

Rollback the database to a specific backup (this will **first** save a safety copy of your current DB into `backups/`):

```bash
npm run rollback:db -- <backup-file.db>
```

Example:

```bash
npm run rollback:db -- portal-2025-12-20T12-29-46-815Z.db
```

---

## What `verify` does

`verify` runs:

1) `npm run preflight`
   - **doctor** ✅ (Node + lockfile sanity)
   - **smoke** ✅ (health endpoints) *(skipped in offline mode)*
   - **db:integrity** ✅ (SQLite `PRAGMA quick_check`)
   - **backup:db** ✅ (creates timestamped DB backup)

2) Syntax checks for key files (if present) using `node --check`:
   - `src/server.js`
   - `src/db.js`
   - `src/bootCheck.js`
   - `src/sla_watcher.js`
   - `src/case_lifecycle.js`

3) Ensures critical folders exist:
   - `src/routes`
   - `src/views`
   - `public`

---

## If verify fails — what to do

### If it says “smoke failed”

Most common cause: the server is not running (or it crashed on boot).

1) Start the server in Terminal A:
```bash
npm run dev
```

2) If the server crashes with a BootCheck error (common):
- Ensure you are not using `SLA_MODE=primary` in development unless explicitly allowed.
- In your real `.env` (do not commit), set:
```env
SLA_MODE=passive
```
  Or, if you intentionally want primary in dev:
```env
ALLOW_PRIMARY_IN_DEV=true
```

3) Then rerun in Terminal B:
```bash
npm run safe
```

If your server runs on a different URL/port, set:
```bash
SMOKE_BASE_URL=http://localhost:3000 npm run safe
```

### If it says “db integrity failed”
- Stop everything.
- Restore a known-good backup:

```bash
npm run backups:list
npm run rollback:db -- <backup-file.db>
npm run verify
```

### If it says “missing path”
- Create the missing folder or fix the code/config that points to the wrong folder.
- Rerun `npm run verify`.

### If `node --check` fails
- It’s a syntax error.
- Fix the file immediately, then rerun `npm run verify`.

---

## The only safe workflow loop

1) `git status` (must be clean)
2) `npm run verify`
3) Make the smallest possible change
4) `npm run verify`
5) Commit immediately

```bash
git add -A
git commit -m "<type>: <small description>"
```