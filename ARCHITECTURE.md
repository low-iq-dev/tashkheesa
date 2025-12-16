# Tashkheesa Portal — Architecture & Guardrails

This document defines the **non-negotiable architectural rules** of the Tashkheesa Portal.
Any future changes (manual or via AI/Codex) must comply with this document.

---

## 1. Startup & Boot Safety

### Fail-Fast Boot
- `bootCheck()` runs at startup.
- If critical invariants fail, the app **must not start**.

Invariants checked:
- Project structure exists
- Required views exist
- Environment mode is valid
- SLA writers are not duplicated

**Rule:**  
If the app is running, core assumptions are valid.

---

## 2. Environment Modes

- `MODE`: development | staging | production
- `SLA_MODE`:
  - `primary` → single SLA writer enabled
  - anything else → SLA is passive
- `SLA_DRY_RUN`:
  - `true` → SLA logic runs with **no side effects**
  - `false` → SLA logic mutates data

**Rule:**  
SLA behavior must be controllable via environment flags only.

---

## 3. SLA Architecture (CRITICAL)

### Single Writer Rule
Only **one** SLA engine is allowed to mutate data.

Authoritative SLA execution:
- `src/sla_watcher.js`
- Function: `runSlaSweep()`

Forbidden:
- Multiple SLA timers
- SLA mutations in routes
- SLA mutations outside the watcher

---

### Dry-Run Mode
When `SLA_DRY_RUN=true`:
- No database writes
- No notifications
- No reassignment
- Only logs describing intended actions

**Rule:**  
Dry-run logic must wrap the entire mutation path, not individual statements.

---

## 4. Case / Order Lifecycle

### Single Source of Truth
- `src/case_lifecycle.js` is the **only** place allowed to change case status.
- All status transitions go through `transitionCase()`.

Forbidden:
- Direct `UPDATE cases SET status=...` anywhere else
- Partial lifecycle logic in routes

**Rule:**  
If a case state changes, it must pass lifecycle validation.

---

## 5. Views & Rendering

### Canonical Views
- Portal views are explicitly defined and expected.
- Missing views are treated as **fatal errors**, not runtime surprises.

Protected views include:
- `portal_doctor_dashboard`
- `portal_doctor_case`

**Rule:**  
Routes must not render undeclared or missing views.

---

## 6. Notifications

- Notifications are side effects.
- They must:
  - be disabled in SLA dry-run
  - never occur inside failed transactions
  - be deterministic

---

## 7. What NOT To Do

- ❌ Do not add new SLA timers
- ❌ Do not bypass lifecycle helpers
- ❌ Do not update status fields directly
- ❌ Do not scatter environment checks
- ❌ Do not add “quick fixes” without updating this document

---

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

## Final Principle

**Stability beats speed.  
Observability beats cleverness.  
Guardrails beat memory.**