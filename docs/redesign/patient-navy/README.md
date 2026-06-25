# Patient Navy Redesign — Claude Design prototype (visual spec)

Claude Design **navy world** prototype — the visual + interaction spec for the patient
navy redesign ("Calm Clinical · Night"). **Not production code.** This is a
non-production React prototype (Babel-in-browser, CDN React, inline styles, hardcoded
sample data); we translate its *design* into our real stack (Express + EJS + scoped CSS),
we do **not** port its React.

## Token source of truth
- **`styles/tokens.css`** — the canonical, enumerated token system (every hex, alpha,
  radius, shadow, type and motion value). This is authoritative; where the original brief's
  hand-transcribed values disagree with this file, **this file wins**. (Extracted from the
  prototype bundle `tashkheesa app.zip1` and committed here so the source lives in-repo.)
- `ds-app.jsx` + `design-system.html` render the system visually (ColorsSection /
  TypeSection / SpacingSection) but only enumerate the solid hexes; the alphas/shadows/
  motion literals live in `styles/tokens.css`.

## Other files (reference only — none are wired into the app or served)
- `components.jsx` — every UI primitive in real states.
- `i18n.jsx` — bilingual EN / Egyptian-Arabic dictionary + specialties + sample data.
- `screens-home.jsx`, `screens-report.jsx`, `screens-wizard.jsx`, `screens-auth.jsx`,
  `screens-account.jsx` — the screens, grouped.
- `app.jsx`, `illustrations.jsx`, `index.html` — prototype shell / assets.
- `ios-frame.jsx` — **IGNORE.** Prototype device chrome only; not part of our app.

The reserved green/gold **report world** (`--rpt-*`) is used ONLY on the signed specialist
report; everything else is the navy world.
