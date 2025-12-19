# Tashkheesa Portal — Risk Register (Weak Points + Guardrails)

Purpose:
- Document the fragile parts of the portal.
- Define “how it breaks”, “how to prevent it”, and “how to roll back fast”.
- This file is the source of truth when something goes wrong.

Owner: Ziad (solo dev)
Rule: If a change touches a HIGH-RISK area, you must run `npm run preflight` before + after, then commit immediately.

---

## 0) Always-On Safety Protocol

### Required before and after ANY change
```bash
npm run preflight
```

Preflight must pass:
- doctor ✅
- smoke ✅
- db:integrity ✅
- backup:db ✅

### Rollback quick reference (code)
```bash
git revert HEAD
npm run preflight
```

### Rollback quick reference (DB)
Stop server first. Restore a known-good backup into the active DB path (default is `data/portal.db`):
```bash
ls -lt backups | head
cp backups/<backup-file>.db data/portal.db
npm run preflight
```

---

## 1) HIGH-RISK: Database Layer (`src/db.js` + schema + migrations)

### Why it’s risky
- Schema changes can break routes, views, SLA logic, and case lifecycle.
- SQLite can silently lock or corrupt if misused.
- “ALTER TABLE” mistakes are permanent unless you restore a backup.

### How it breaks (symptoms)
- Server crashes on boot (migration error)
- “no such column / table” errors
- “database is locked”
- Data appears missing or inconsistent

### Guardrails
- Never remove existing columns/tables without a migration plan.
- Only add columns using safe checks (`PRAGMA table_info(...)` → ALTER if missing).
- Always run:
  - `npm run db:integrity`
  - `npm run backup:db`
  before ANY schema change.
- If a change touches DB: commit immediately after it passes preflight.

### Fast rollback
- Revert code: `git revert HEAD`
- If data is corrupted: restore DB backup

---

## 2) HIGH-RISK: Case Lifecycle (`src/case_lifecycle.js` or equivalent)

### Why it’s risky
- Workflow status transitions affect dashboards, assignments, SLA deadlines, and notifications.

### How it breaks (symptoms)
- Cases stuck in wrong status
- Doctors can’t accept/complete
- Admin views don’t match reality
- SLA watcher triggers wrong actions

### Guardrails
- All transitions must be explicit and logged.
- Never introduce “magic statuses”; keep canonical status list.
- Any new status requires:
  - update queries that filter cases/orders
  - update UI labels
  - update SLA logic assumptions
- Before pushing change: test with 2-3 sample cases end-to-end.

### Fast rollback
- Revert last commit; if it modified data states, restore DB backup.

---

## 3) HIGH-RISK: SLA Watchers (`src/sla_watcher.js` and any SLA workers)

### Why it’s risky
- This is automation that mutates state over time.
- Bugs can silently reassign, breach, or alter case/order rows.

### How it breaks (symptoms)
- Unexpected reassignment
- Orders/cases marked breached incorrectly
- Duplicate actions every interval
- Performance spikes every sweep

### Guardrails
- SINGLE WRITER: Only one instance should run in `SLA_MODE=primary`.
- Keep `SLA_MODE=passive` by default, only use primary intentionally.
- Any change must be idempotent:
  - if a breach happened already, don’t breach again
  - if reassigned_count was incremented, don’t increment repeatedly
- Always run with low-volume test data before real usage.

### Fast rollback
- Switch to `SLA_MODE=passive` immediately
- Revert commit
- Restore DB backup if watcher mutated data incorrectly

---

## 4) HIGH-RISK: Server Boot + Routing (`src/server.js`, `src/routes/*`)

### Why it’s risky
- Boot order, middleware order, and error handling can break everything at once.
- Wrong require path crashes on startup.
- Middleware changes can silently block sessions/auth.

### How it breaks (symptoms)
- Server doesn’t start
- 500 everywhere
- Login/session issues
- Static files not loading (CSS/JS/favicons)
- Routes returning wrong format (HTML vs JSON)

### Guardrails
- Keep canonical routes stable; legacy routes only redirect.
- Never reorder middleware unless you understand dependencies (auth, static, body parsing, etc.)
- Crash guardrails must remain enabled (unhandledRejection/uncaughtException fail-fast).
- Always keep 404 + error handler last.

### Fast rollback
- `git revert HEAD` then restart server + preflight

---

## 5) MEDIUM-RISK: Views Rendering (EJS templates)

### Why it’s risky
- Views can fail at runtime only when a specific route renders.
- Missing variables can crash the render.

### How it breaks (symptoms)
- “Failed to lookup view” / “Cannot read property X of undefined”
- Doctor dashboard loads but a specific section crashes

### Guardrails
- No inline styles unless intentional; keep consistent class-based styling.
- Prefer defensive rendering:
  - `if (value)` before printing
  - fallback labels for missing fields
- If a view is new or heavily edited: open it manually in browser as part of testing.

### Fast rollback
- `git revert HEAD`

---

## 6) MEDIUM-RISK: Authentication & Staging Basic Auth

### Why it’s risky
- Misconfigured env vars can lock you out or expose staging.

### Guardrails
- Use consistent env keys:
  - `BASIC_AUTH_USER`
  - `BASIC_AUTH_PASS`
- Keep back-compat if older env vars exist, but prefer the canonical ones.
- Never commit `.env` files.

### Fast rollback
- Restore env vars; revert commit if auth logic changed

---

## 7) MEDIUM-RISK: Static Assets & Branding (favicon, CSS)

### Why it’s risky
- Small mistakes can cause ugly UI or missing assets, but usually not data loss.

### Guardrails
- Never intercept `/favicon.ico` if `public/favicon.ico` exists.
- Keep CSS changes scoped; avoid global overrides unless intended.

### Fast rollback
- `git revert HEAD`

---

## 8) LOW-RISK: Content changes, copy rewrites, spacing/typography tweaks

### Guardrails
- Keep changes incremental.
- Commit often.

---

## 9) Known “Accident Patterns” (What previously broke)

- JSON mistakes in `package.json` scripts (commas / quotes) → run preflight and keep scripts minimal.
- Template literals/backticks inside npm scripts → shell expands `${}` and breaks → avoid backticks, use string concat.
- Git tracking `.db` / `.DS_Store` → pollutes repo → ignore + remove cached tracking.
- SLA interval not clearable → zombie timers on shutdown → keep interval id in outer scope.

---

## 10) Release Checklist (Manual)

Before calling a change “stable”:
1) `git status` clean
2) `npm run preflight` passes
3) Test flows:
   - Doctor dashboard loads
   - Doctor can view a case page
   - Create/accept/complete basic lifecycle (if supported)
4) Commit with clear message
