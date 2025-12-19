# VERIFY — What to run before you change anything

## The one rule
Before **and** after any change, run:

```bash
npm run verify
```

If verify fails, you stop and fix it before touching anything else.

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
- Start the server first:

```bash
npm run dev
```

- Then rerun:

```bash
npm run verify
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
