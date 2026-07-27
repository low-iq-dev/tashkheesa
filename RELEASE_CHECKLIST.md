# RELEASE CHECKLIST (Manual)

Use this checklist whenever you consider the portal “stable” or you want to merge/deploy a change.

If you skip a step, you accept the risk.

---

## 1) Clean state
```bash
git status
```
Must show: **working tree clean**.

---

## 2) Verify (required)
```bash
npm run verify
```
Must pass:
- doctor ✅
- smoke ✅
- db:integrity ✅
- backup:db ✅
- verify ✅

---

## 3) UI spot-check (5 minutes)

Open the portal in the browser and confirm these work:

### Doctor
- Doctor dashboard loads
- Doctor can open a case details page
- Core buttons/links don’t 404

### Auth
- If staging basic auth is enabled, confirm it prompts and accepts credentials

### Assets
- CSS loads (no unstyled page)
- Favicon displays (tab icon)

---

## 4) Log sanity

In the terminal while the server is running:
- No repeating errors every few seconds/minutes
- No “UnhandledRejection” / “UncaughtException” spam
- No repeated SLA sweep failures

---

## 5) Change discipline

### One change set per commit
- Small commits
- Clear messages

Example:
```bash
git add -A
git commit -m "chore: <small description>"
```

### If you used Codex/AI
- Confirm it only changed the files you intended
- Rerun:
```bash
npm run verify
```

---

## 6) Rollback plan (know it before you ship)

### Code rollback
```bash
git revert HEAD
npm run verify
```

### DB rollback (only if data is corrupted)
Prod is **Postgres** (not SQLite). Stop the server first, take a fresh safety
dump, then restore the chosen backup:
```bash
npm run backup:db      # safety dump of current state → backups/portal-<ts>.dump
npm run backups:list   # find the backup file to restore
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" backups/<backup-file>.dump
npm run verify
```
> The legacy `cp backups/<file>.db data/portal.db` / `npm run rollback:db` SQLite
> flow no longer applies — there is no SQLite file in prod. `npm run rollback:db`
> now prints this same guidance and exits without touching anything.

---

## 7) Done
If all steps pass, the release is considered **stable**.
