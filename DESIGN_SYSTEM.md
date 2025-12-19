# Tashkheesa Portal — Mini Design System (v1)

This document defines the **minimum set of UI rules** we reuse across the portal so pages look consistent, professional, and calm.

**Goals**
- Clean, modern, clinical (not flashy)
- Consistent spacing and typography
- Reusable components (panels, rows, buttons, pills)
- Safe to evolve: changes go to `public/styles.css` and are scoped where possible

---

## 1) Design principles

1) **Clarity beats decoration**
- Prefer whitespace, alignment, and hierarchy over borders and heavy gradients.

2) **One primary action per screen**
- Each page should have a clear “next action” (Accept, Save notes, Submit, etc.).

3) **Scannability**
- Lists use consistent columns.
- Status/SLA should be readable at a glance.

4) **Safe changes**
- Visual changes live in `public/styles.css`.
- Avoid inline styles and per-page style blocks.

---

## 2) Global tokens (CSS variables)

Location: `public/styles.css` (near the bottom we append “consistency packs”).

We reuse these tokens:
- Backgrounds: `--bg`, `--card-bg`
- Text: `--text-main`, `--text-muted`
- Borders: `--border-soft`
- Radius: `--radius-sm`, `--radius-md`, `--radius-lg`
- Shadows: `--shadow-sm`, `--shadow-md`

Rule: **don’t hardcode colors** inside markup; prefer tokens or existing component classes.

---

## 3) Spacing + layout rules

### Containers
- Standard max width: **980px**
- Standard page padding: **24px 16px 48px**

We use:
- `.worklist-container` for dashboard-like pages
- `.wrap` for detail pages

### Rhythm
- Between major sections/cards: **16–22px**
- Inside cards/panels: **16–18px**

Avoid:
- Huge empty space or very tight stacks. The UI should feel breathable.

---

## 4) Typography rules

### Titles
- `.page-title`: bold, ~22px
- `.page-subtitle`: muted, ~13px, line-height 1.5

### Section headers
- `.panel-title` / `.worklist-group-title`: ~15–16px, bold
- `.panel-hint` / `.worklist-group-hint`: muted helper copy, ~13px

### Muted text
- Use `.muted` for secondary metadata.

Avoid:
- All caps on headings (except micro-labels in `.worklist-meta .muted`).

---

## 5) Core components

### 5.1 Panel (the reusable “card section”)
Used in case detail pages and any page with grouped content.

Markup:
```html
<section class="panel">
  <h2 class="panel-title">Title</h2>
  <p class="panel-hint">One line helper text.</p>
  <!-- content -->
</section>
```

### 5.2 Worklist section (dashboard blocks)
Used on doctor queue/dashboard.

- Wrapper: `.worklist-group`
- Title: `.worklist-group-title`
- Hint: `.worklist-group-hint`

### 5.3 Worklist row (case row)
We standardize to **4 columns** when possible:
1) Case info
2) Status
3) Deadline/SLA
4) Actions

Markup (inside loops):
```html
<div class="worklist-row">
  <div class="worklist-main">…</div>
  <div class="worklist-meta">…</div>
  <div class="worklist-meta">…</div>
  <div class="worklist-action">…</div>
</div>
```

### 5.4 Buttons
- `.btn-primary`: main action
- `.btn-secondary`: navigation/secondary action

Rules:
- Use **one** primary button per row/section when possible.
- Prefer short labels: “Accept”, “Open case”, “Save notes”.

### 5.5 Pills (status + small tags)
- `.pill`: neutral tag used in headers
- `.status-pill`: status labels in lists
- Variants we already use:
  - `.status-pill--new`
  - `.status-pill--info`
  - `.status-pill--done`

Rule:
- Use pills for **state**, not for decoration.

### 5.6 Empty state
Use a calm empty state so the page never feels broken.

Markup:
```html
<div class="worklist-empty">
  <strong>No files uploaded</strong>
  <div class="muted">This case cannot be reviewed until files are provided.</div>
</div>
```

---

## 6) Copy rules (tone)

Tone: **professional, modern, friendly, clinically appropriate**.

Rules:
- One idea per sentence.
- Remove repeated labels (no “Completed Completed”).
- Prefer action guidance: “Accept a case to begin review.”

Examples:
- Good: “Complete and submit reviews before the deadline.”
- Bad: “You must ensure that you have completed and submitted your review by the review deadline shown below.”

---

## 7) Accessibility + UX guardrails

Minimum requirements:
- Buttons/links must have clear labels.
- Use visible focus states (already standardized in CSS).
- Keep interactive targets reasonably large (avoid tiny links).

For forms:
- Textareas should have a label or a clear heading above.
- Error/success messages should be readable and not rely on color alone.

---

## 8) File boundaries (where things live)

- **UI markup:** `src/views/*.ejs`
- **All styling:** `public/styles.css`
- **No inline CSS** in templates (keeps consistency and avoids overrides)

When adding a new page:
1) Start with `.page-header` (title + subtitle)
2) Use `.panel` sections
3) Reuse `.btn-primary` and `.btn-secondary`
4) Add any new CSS at the bottom of `public/styles.css`, scoped by body class

---

## 9) Safe change workflow (solo dev)

Before committing:
1) Refresh the page with **Cmd+Shift+R**
2) Check doctor queue + a case detail page
3) Confirm no console/terminal errors
4) `git status` → review changed files
5) Commit with a focused message

Suggested commit message format:
- `Doctor portal: <what changed>`
- `UI: <component> polish`

---

## 10) Next components to standardize (future)

- Alerts page layout
- Tables → unified table component
- Form rows → consistent label/value blocks
- Real favicon + manifest (instead of 204 placeholder)
