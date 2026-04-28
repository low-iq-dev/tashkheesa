# Claude Code Brief — Legacy Style Audit (doctor + patient portals)

**Goal:** produce a definitive list of every doctor-portal and patient-portal view that still has legacy chrome (medical-blue palette, pre-v2 markup) so we know exactly what's left to migrate.

**This is an AUDIT — read-only. No code changes. No commits except the final findings doc.**

---

## Scope

In scope:
- All `src/views/doctor_*.ejs`
- All `src/views/portal_doctor_*.ejs`
- All `src/views/patient_*.ejs`
- All `src/views/portal_patient_*.ejs` (if any)
- Doctor + patient partials in `src/views/partials/doctor/`, `src/views/partials/patient/`, and shared partials in `src/views/partials/` that those portals load

Out of scope (do NOT audit):
- `admin_*.ejs`, `superadmin_*.ejs`
- `ops-*.ejs`
- Public marketing pages (`index.ejs`, `about.ejs`, `services.ejs`, `contact.ejs`, `terms.ejs`, `privacy.ejs`, etc.)
- Order flow pages (`order_*.ejs`) — payment-flow-adjacent, owned separately
- Login / signup / reset-password / set-password (separate workstream)
- The `.bak` files

---

## Method

For each in-scope file, classify into one of three buckets:

### V2 (clean)
File uses warm-clinical v2 design system. Indicators:
- References `--v2-*` CSS tokens, OR
- Loads `doctor-portal-v2.css` / `patient-portal-v2.css`, OR
- Wraps content in a `body.doctor-theme.portal-v2` or `body.p-portal` scope, OR
- Uses v2 BEM class names (`.v2-card`, `.v2-btn`, `.v2-chip`, `.p-card`, `.p-btn`, etc.) consistently

### Partial-v2
File has SOME v2 markers but ALSO has legacy chrome. Indicators:
- Uses some `--v2-*` tokens but also hardcoded hex colors, OR
- Loads v2 CSS file but markup still uses old class names, OR
- Mixes `.v2-*` and pre-v2 class names in the same file

### Legacy
File has no v2 markers. Indicators:
- Zero references to `--v2-*` tokens
- Zero `.v2-*` or `.p-*` class names
- May reference old palette tokens (`--primary-blue`, `--medical-*`), legacy class names (`.page-shell`, `.doctor-shell`, `.portal-shell`), or use raw hex colors throughout

---

## What to record per file

For each file, the audit must capture:

1. **Path** — full relative path
2. **Lines** — line count (`wc -l`)
3. **Bucket** — V2 / Partial-v2 / Legacy
4. **Evidence** — the specific markers found (count of `--v2-*` references, count of `.v2-*` class usages, presence of legacy class names, hardcoded hex colors)
5. **Reachable from** — the route(s) that render this view (`grep -n "render.*<viewname>" src/routes/*.js`)
6. **Linked from** — any nav, partial, or other view that links to this surface (`grep -rn "/portal/<role>/<path>" src/views/`)
7. **Verdict** — one of:
   - **OK** — already v2, no work needed
   - **POLISH** — partial-v2, needs token/class cleanup
   - **REDESIGN** — full legacy, needs v2 migration
   - **DELETE** — legacy AND no route renders it AND no view links to it (orphaned)

---

## Where to write findings

Append a new section to `PHASE_2_BACKLOG.md` titled:

```
## Legacy style audit — <YYYY-MM-DD>
```

Inside that section:

1. **Summary table** — one row per file with columns: Path | Bucket | Verdict | Reachable | Notes
2. **By bucket** — group files under three subsections (V2 / Partial-v2 / Legacy)
3. **Orphan list** — any file marked DELETE (no route + no link)
4. **Cross-reference with prior audit** — Round 1's Task C audit covered some of these files. Note any disagreements between the two audits and which one is correct.

---

## Hard rules

- Read-only. **No code edits.** Only the backlog doc gets modified.
- Do NOT touch admin / superadmin / ops / order_flow / public marketing files.
- Do NOT classify a file as "V2" without finding actual v2 markers — guessing or going by filename is forbidden. Show evidence.
- If a file's classification is ambiguous (some sections v2, others legacy), classify as Partial-v2 and note WHICH parts of the file are which.
- If you're unsure about a file, log the uncertainty in the notes column rather than guessing.
- One commit at the end with the audit findings appended to `PHASE_2_BACKLOG.md`. Commit message:
  ```
  docs: legacy style audit — doctor + patient portal views
  ```

---

## Stop conditions — ASK USER if

- You find views outside the in-scope list that look related (e.g. an `appointment_*.ejs` that's clearly a doctor surface). Ask before including or excluding.
- A view loads a partial that itself looks legacy — should the partial be audited too? Ask.
- The classification for a file is genuinely ambiguous and you can't decide between two buckets. Ask.

---

## What "done" looks like

The user can read the audit section and answer in 30 seconds:
- "How many doctor views are still legacy?" → exact count
- "How many patient views are still legacy?" → exact count
- "Which legacy files are orphaned and safe to delete?" → exact list
- "Which legacy files are reachable but need redesign?" → exact list with priorities

Stop and report when the audit section is committed.
