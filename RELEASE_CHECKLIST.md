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
Stop server first. Then:
```bash
ls -lt backups | head
cp backups/<backup-file>.db data/portal.db
npm run verify
```

---

## 7) Done
If all steps pass, the release is considered **stable**.
