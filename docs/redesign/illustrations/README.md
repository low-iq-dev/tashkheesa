# Tashkheesa Illustrations

All SVG — brand-matched, color-token-friendly, ready to drop into Claude Design or the portal directly.

## Palette used

- **Primary (deep teal)** — `#0B6B5F` — linework, structure
- **Primary dark** — `#074B43` — (reserved, not used in these assets)
- **Primary light** — `#E8F3F1` — subtle tonal fills
- **Accent (brass)** — `#B38B3E` — luxury accents, active/highlight state
- **Accent light** — `#F2E4C7` — brass fills, chips

## What's here

### `icons/` — 24 functional SVG icons, 48×48 viewBox, 1.75 stroke

Use for: navigation, sidebar, case rows, file-type indicators, section headers.
Size in use: 20–24px typical, stroke auto-scales.

Grouped by theme:

**Medical / clinical (1–10)**
- ecg, chest_xray, echo, blood_test, brain, report, ultrasound, genetic, stethoscope, prescription

**Navigation / UI (11–24)**
- calendar, video_call, alert, patient, doctor, completed, sla, files, messages, review, settings, analytics, earnings, lock

### `empty_states/` — 4 scenic empty-state illustrations, 280×200

Use for: when a page/card has no data yet.

- `empty_no_cases.svg` — stethoscope + floating document + pulse line (used on Dashboard, Case Queue)
- `empty_no_appointments.svg` — calendar + video camera + brass bar (used on Appointments, signals "coming soon")
- `empty_no_alerts.svg` — envelope with big checkmark + floating dots (used on Alerts when empty)
- `empty_no_completed.svg` — archive box with folder tabs (used on Completed when empty)

## How to view

Open `INDEX.html` in a browser — it shows every asset rendered at intended size.

## How to use in Claude Design

1. Drag the entire `illustrations/` folder into Claude Design's "Add fonts, logos and assets" uploader
2. Tell Claude Design: *"Use these custom SVG assets for all medical icons and empty states. Do NOT generate new icons. Use the exact files provided."*

## How to use in the portal directly (if Claude Design doesn't work out)

Copy files into `public/assets/illustrations/` and reference as:

```html
<img src="/assets/illustrations/icons/09_stethoscope.svg" width="24" height="24" alt="">
```

Or inline the SVG so you can color-theme via CSS `currentColor`:

```html
<svg class="icon"><use href="/assets/illustrations/icons/sprite.svg#stethoscope"></use></svg>
```

## Editing notes

All SVGs are flat, hand-coded — no groups or transforms to untangle. If you need to recolor, just find-replace `#0B6B5F` or `#B38B3E` in the file. Stroke-width 1.75 is standard; increase to 2 for larger display, decrease to 1.5 for very small use (<16px).
