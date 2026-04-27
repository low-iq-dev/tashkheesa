# Claude Code — Open Questions for the User

Captured while executing CLAUDE_CODE_BRIEF.md Task 1. None of these were
ambiguous enough to halt work — I made a judgement and moved on, with the
choice documented per file. Listed here for the user to confirm or correct
before Task 2 starts.

---

## Q1 — `.p-chip.p-chip--info` is not defined in `patient-portal-v2.css`

**Brief recipe (line 89):** `.status-badge.status-submitted` → `.p-chip.p-chip--info`

**What I observed:** `public/css/patient-portal-v2.css` defines the chip
variants at lines 222–226:

```
.p-chip--teal    { background: var(--primary-light); color: var(--primary-dark); }
.p-chip--brass   { background: var(--accent-light); color: var(--accent-dark); }
.p-chip--neutral { background: var(--surface-sunk); color: var(--ink); }
.p-chip--red     { background: var(--danger-bg); color: var(--danger); }
.p-chip--green   { background: var(--success-bg); color: var(--success); }
```

There is no `.p-chip--info` rule, so any `<span class="p-chip p-chip--info">`
will render with only the base `.p-chip` shape (rounded pill, uppercase,
0.08em tracking) but no background or color — i.e. transparent on the page
background with default text color.

**What I did:** Followed the brief literally. Files now containing
`p-chip--info`:

- `src/views/patient_records.ejs` — record-type label chip (was
  `status-submitted`)
- `src/views/patient_appointments_list.ejs` — default fallback in
  `statusChipClass()` (status not in the known confirmed/pending/
  cancelled/completed/no_show set)

**Question:** is the intended class name…
1. `.p-chip--neutral` (closest existing variant — gray surface-sunk
   background)? or
2. `.p-chip--info` should be added to `patient-portal-v2.css` with its own
   color treatment (e.g. teal-tinted to match the v2 palette)?

If the answer is (1), I'll do a follow-up commit replacing the two
`p-chip--info` occurrences with `p-chip--neutral`. If (2), let me know what
colors you want and I'll add the rule.

---

## Q2 — `status-breached` chip mapping (prescription expired) and `status-cancelled` / `no_show` (appointments)

**Brief recipe:** only enumerated `status-submitted`, `status-completed`,
and `status-pending`.

**Observed in legacy markup:**

- `patient_prescriptions.ejs`: `status-breached` for expired prescriptions.
- `patient_appointments_list.ejs`: `status-cancelled` and `status-breached`
  (used for `no_show`).

**What I did:** mapped both `status-breached` and `status-cancelled` →
`.p-chip.p-chip--red`. The `--danger` color scheme felt right for
"expired / cancelled / no-show" since these are end-of-life terminal states
the patient should notice.

**Question:** is `.p-chip--red` correct for these, or do you want a
softer chip (e.g. `.p-chip--neutral`) for cancelled/expired so red is
reserved for actual error/breach states only?

---

## Q3 — `patient_prescription_detail.ejs` per-page print stylesheet was dropped

**What I observed:** the legacy view had a per-page `<style media="print">`
block hiding `.portal-sidebar`, `.portal-header`, `.portal-hero`,
`.rxd-action-bar`, and resetting `.portal-content` / `.portal-grid` to
full-width.

`public/css/patient-portal-v2.css` lines 808–840 already provide an
equivalent global print rule that hides `.p-sidebar`, `.p-tabbar`,
`.p-topbar`, and `.p-btn`, and resets `.p-main` to full-width. The
specific block for `.rxd-action-bar` is no longer needed because the
action bar contains only `.p-btn` elements (which are hidden by the
global rule).

**What I did:** removed the per-page block. Behaviour should be identical
on print.

**Question:** confirm? Or do you want the rxd-action-bar wrapper itself
hidden on print to avoid an empty block taking visual space (it shouldn't,
but worth verifying with a real print preview).

---

## Q4 — `patient_records.ejs` modal: tokens swapped, but `.modal-overlay` and `.modal-box` are still bespoke

The brief explicitly told me to keep the modal styles in the per-page
`<style>` block and just update the token names (`--p1-surface` → `--surface`
etc.), which I did.

**Question:** any future intent to move this to a shared
`.p-modal` / `.p-modal__box` set of classes? Not blocking — just flagging
that the modal still lives only in this view.
