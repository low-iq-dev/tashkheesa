## 8. Change Discipline

Before modifying:
- SLA logic
- lifecycle logic
- startup flow
- view rendering

Ask:
> “Does this violate ARCHITECTURE.md?”

If yes → redesign first.

---

## 9. Runbook — Safe Workflow (MANDATORY)

This runbook is the default workflow for *every* change. If you skip it, you accept the risk of breaking production.

### 9.1 Golden Rules
- Never edit without a clean git state: `git status` must be clean before you start.
- Always run preflight before and after changes.
- Always take a DB backup before anything that touches lifecycle/SLA/database code.
- One change set per commit. Small commits are roll-backable commits.

### 9.2 Preflight (the "is the portal healthy?" command)
Run this before/after any change:

```bash
npm run preflight
```

Preflight must pass:
- `smoke` ✅ (health endpoints)
- `backup:db` ✅ (DB copy succeeds)

### 9.3 Start / Stop
```bash
npm run dev
# or
npm start
```

### 9.4 Safe Edit Loop (the only allowed loop)
1. `git status` (must be clean)
2. `npm run preflight`
3. Make the smallest possible change
4. `npm run preflight`
5. Commit immediately:

```bash
git add -A
git commit -m "<type>: <small description>"
```

### 9.5 If something breaks (fast rollback)

#### Roll back code only (most common)
If the last commit caused the issue:

```bash
git revert HEAD
npm run preflight
```

If you have uncommitted changes and want to discard them:

```bash
git restore .
```

#### Roll back DB (only if data is corrupted)
**Stop the server first.** Then restore a backup file *into the active DB path*.

Default DB path is `data/portal.db` (unless `PORTAL_DB_PATH` or `DB_PATH` overrides it).

Example restore (default path):

```bash
# pick a backup file you trust
ls -lt backups | head

# restore
cp backups/<backup-file>.db data/portal.db
```

Then:
```bash
npm run preflight
```

### 9.6 Codex / AI changes (guarded)
If you use Codex:
- Make it change **one file at a time**.
- Never allow it to edit `src/db.js`, `src/case_lifecycle.js`, or `src/sla_watcher.js` without an immediate preflight + commit.
- After any AI change: run `npm run preflight` *before you even look at the UI*.

### 9.7 High-risk files (require extra discipline)
Changes here require:
- DB backup first (`npm run backup:db`)
- preflight before + after
- commit immediately

High-risk files:
- `src/db.js`
- `src/case_lifecycle.js`
- `src/sla_watcher.js`
- `src/server.js`
- `src/routes/*`

## Final Principle

**Stability beats speed.  
Observability beats cleverness.  
Guardrails beat memory.**