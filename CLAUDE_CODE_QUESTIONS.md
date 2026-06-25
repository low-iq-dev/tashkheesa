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

---
---

# Patient Navy Redesign — Phase 1 (tokens) — deltas & decisions

Logged while executing `CLAUDE_CODE_BRIEF_PATIENT_NAVY_REDESIGN.md` Phase 0–1.
**Token source of truth = canonical `docs/redesign/patient-navy/styles/tokens.css`**
(extracted from the prototype bundle `tashkheesa app.zip1`). Where the brief's
hand-transcribed values disagreed with that file, the **spec wins** (per Ziad's
overrides). This records the disagreements, the decisions taken, and Phase 2/3 follow-ups.

## A. Resolved by Ziad's overrides (recorded for the diff trail)

1. **Report-world tokens use the canonical spec, not the brief.** 5 brief values + 1
   omission differed; `patient-report.css` uses canonical:
   `--rpt-ink-2 #45524a` (brief `#2f3b34`), `--rpt-muted #7c887f` (brief `#6b7768`),
   `--rpt-rule rgba(31,77,58,0.16)` translucent (brief opaque `#e3dcc8`),
   `--rpt-rule-gold rgba(176,133,49,0.32)` (brief `0.35`),
   `--shadow-rpt` two-layer (brief single-layer), **added `--rpt-green-2 #2f6b4f`**.

2. **Full spec radius scale** (not current+2): `--r-xs 6 / --r-sm 10 / --r-md 14 /
   --r-lg 18 / --r-xl 24 / --r-pill 999`, plus **`--r-2xl: 30px`** — spec defines it as
   **30px**, not the `24px` the brief stated.

3. **Navy app-world alphas/shadows use the canonical spec** (brief values were also
   transcriptions): `--primary-light 0.14`, `--primary-tint 0.22`;
   `--rule rgba(174,191,210,0.13)`, `--rule-strong 0.22`; semantic `*-bg` at `0.13`;
   `--shadow-1/2/3` = spec's deeper values; `--shadow-teal 0 6px 22px rgba(95,230,224,0.22)`.
   (All solid hexes matched the brief already.)

## B. Judgment calls (no spec/brief value existed; flag if you disagree)

4. **`--rule-on-dark`** (not in brief) re-pointed from warm cream `rgba(248,245,239,0.10)`
   to the spec's faint hairline `rgba(174,191,210,0.07)` (spec `--rule-faint`). Name kept.
5. **`--shadow-inset`** was a light white inset at `0.6` (wrong on dark) → subtle on-dark
   `inset 0 1px 0 rgba(255,255,255,0.04)`. Name kept.
6. **`--accent*` neutralized to teal** (brief 1.4 default): `--accent → var(--primary)`,
   `-dark/-light/-tint → primary equivalents`, `--on-accent → #042027`. App world is teal-only.
7. **`theme-color` meta** (`head.ejs`) `#0B6B5F` → `#081120` so the mobile status bar matches navy.
8. **Sidebar (desktop chrome) fully converted to navy.** Its teal gradient / brass tile /
   cream text were hardcoded light-world values (not token-driven) → part of the 1.2 sweep.
   Principle applied app-wide: **large branded fills → navy surfaces; small accents → teal.**
9. **Dashboard blog hero-strip** (in scope): teal gradient → navy
   `linear-gradient(var(--surface-2) → var(--navy-900))`; brass watermark numeral → `var(--primary-tint)`.
10. **Sora self-hosted** (400/500/600/700, woff2+woff, OFL) under `public/fonts/sora/`,
    downloaded from the fontsource CDN and committed — **no `package.json` change**, mirroring
    Cormorant. `--font-display` serif→Sora. Cormorant `@font-face` kept (lazy) for rollback,
    but its two `<link rel=preload>` lines were **removed** (Cormorant is now unreferenced —
    dead preloads). **If Phase 3's report world wants serif, re-add a Cormorant preload.**

## C. Open follow-ups for Phase 2/3 (NOT changed in Phase 1, by scope)

11. **Arabic font:** spec wants **IBM Plex Sans Arabic**; we kept the working `SF Arabic`/`Noto`
    stack (`--font-arabic`) per the brief's hard constraint. Follow-up: self-host IBM Plex Sans
    Arabic (OFL) the same way Sora was done, then prepend it to `--font-arabic`.
12. **Hardcoded component radii not tokenized:** Phase 1 changed radius *tokens* only.
    `.p-card` (14px), `.p-btn`/`.p-field` (10px), tiles (9px), nav (8px), etc. keep their
    literals, so they don't pick up `--r-lg: 18px` yet — only components already using
    `var(--r-*)` (e.g. `.p-dash-blog__card`) do. Reconcile in the Phase 2 component pass.
13. **Type scale differs from spec, kept as-is** (brief 1.1 changed fonts only). Spec mobile
    scale (`--t-body 15`, `--t-display 32`, `--t-h1 26`…) vs our desktop scale + our token
    names; `--lh-*` and tracking differ slightly. Decide in Phase 2/3.
14. **Spacing `--s-9`:** ours/brief `36px`, spec `40px`. Kept `36px` (spacing out of override
    scope). Flag if you want the spec value.
15. **Motion kept per brief** (`--t-fast/base/slow` 120/200/320; `--ease` matches spec). Spec
    is 130/220/340 and adds **`--ease-out`** (sheet/toast slide-ins) — add in Phase 2.
16. **Spec tokens not added in Phase 1** (Phase 2/3 ports reference them): `--teal-bright #7af0ea`,
    `--rule-faint` (value reused for `--rule-on-dark`), `--on-navy-faint rgba(234,242,249,0.05)`,
    named `--teal-tint`/`--teal-tint-2`, `--track-label`, `--ease-out`, `--safe-top`/`--safe-bottom`
    (iOS safe-area — relevant to the WebView). Ported spec components reference
    `--teal`/`--text`/`--teal-tint`/`--on-teal` directly; add aliases or rename on port.
17. **Landing hero block left untouched** (`.p-landing`, `.p-hero*`, ~lines 327–387) — flagged
    "out of scope / kept for reference" in the file header; still has warm-clinical literals.
    (See item 19 — an independent audit re-confirmed this block is **dead/unreferenced**.)

## D. Adoption / verification pass (2026-06-25)

This branch's Phase 0–1 was completed by a prior session and pushed to `origin`. This pass
**adopted** it (no redo), independently verified it, and added cross-surface screenshots.

18. **⛔ BLOCKER — `npm run smoke` / `npm run dev` cannot run locally.** Local Postgres lacks
    the Supabase `anon` role, so migration `070` fails on boot and the server refuses to start
    (`src/db.js` aborts on migration failure). **Per Ziad's explicit instruction this pass made
    ZERO DB changes** — did not add/seed the `anon` role, did not skip migrations, did not work
    around the DB inside or outside the repo. Consequence: live smoke + a real `npm run dev`
    boot could not run for this PR. **Pre-existing infra gap, not introduced by the redesign.**
    Verified instead via a headless-Chrome static-render fallback (see item 21).

19. **Independent multi-agent audit → adopt-clean.** A 6-dimension adversarial audit of the
    committed navy diff (`merge-base(main)..HEAD`) ran. **5/6 PASS:** file-scope (no
    routes/controllers/db/migrations/payment/SLA/cron/auth/pg-boss; `package.json` deps
    unchanged), token-name preservation (all 83 original names kept; 7 allowed additive), 
    canonical-value fidelity (radius incl. `--r-2xl 30`, navy alphas `0.13/0.14/0.22`, deeper
    shadows, `--rpt-green-2 #2f6b4f`), RTL/logical-props + `.num` integrity, report-sheet inert
    + Sora self-host + warm-originals untouched. **1 finding (medium):** the dead `.p-hero*`
    block (item 17) still carries warm literals (`#0B6B5F` gradient, `#F8F5EF`/`#E6D7B0` cream).
    Confirmed **unreferenced by any view** (the live patient landing uses `app-landing__*`), so
    **no rendered regression**. Left as-is per the brief's sweep rule ("if a rule's intent is
    unclear, leave it and note it — do not guess"); the right on-dark token is ambiguous (a naive
    `--on-primary` swap = dark ink on a teal card → broken contrast). **Decision for Ziad:** fold
    a hero re-token into the Phase 3 landing pass, or request it now.

20. **Observation (pre-existing, view-layer, NOT the redesign):** Arabic *date* strings render
    in **Eastern-Arabic digits** (e.g. `۲۷ يونيو`) because the views format dates via
    `toLocaleDateString('ar-EG', …)` (e.g. `fmtDayDate` in `patient_dashboard.ejs`). All other
    numerals (case IDs, prices, phone, countdown hours) are Western, and the `.num` tabular
    treatment is untouched (audit-confirmed). This predates Phase 1 and is outside CSS-token
    scope, but is flagged against the "Western numerals in both languages" constraint — a future
    view-layer fix (`'ar-EG-u-nu-latn'` or pre-format) would resolve it. Not changed here (a
    view-logic edit, out of this phase).

21. **Screenshots added:** `docs/redesign/patient-navy/screenshots/phase1-{dashboard,case,profile}-{en,ar}.png`
    — 3 surfaces × EN/AR, captured via the static-render fallback (real EJS views + the actual
    committed CSS/fonts, mock locals, headless Chrome at 1180px / 2× DPR). Confirms: navy world
    end-to-end, raised navy surfaces, bright-teal primary CTA + `--shadow-teal` glow, Sora sans
    (no serif), RTL fully mirrored in AR, Western numerals (except item 20's locale dates). The
    prior `phase1-tokens-{en,ar}.png` (dashboard-only) are retained.
