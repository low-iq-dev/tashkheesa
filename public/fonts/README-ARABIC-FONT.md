# Arabic font — one manual step required before launch

`src/report-generator.js` renders the report body per line: Latin lines use
Helvetica, Arabic lines use the first font `findArabicFontPath()` finds. Until
an Arabic-capable TTF exists in this directory, that probe returns `null` on
Linux (its other candidates are macOS system paths that do not exist on the
Render host) and Arabic body text falls back to Helvetica — a standard-14 font
under WinAnsiEncoding with no mapping for Arabic codepoints.

It does **not** throw. It encodes every Arabic glyph to `.notdef`, so the PDF is
structurally valid and visually blank. That is why this went unnoticed.

## Fix

Drop one file here and commit it:

```bash
curl -L -o public/fonts/NotoNaskhArabic-Regular.ttf \
  https://github.com/google/fonts/raw/main/ofl/notonaskharabic/static/NotoNaskhArabic-Regular.ttf
git add -f public/fonts/NotoNaskhArabic-Regular.ttf
```

No code change is needed — that exact filename is already third in the probe
list. Any Arabic-capable TTF works; the probe also accepts `arabic.ttf`,
`Arabic.ttf` or `NotoSansArabic-Regular.ttf`.

Noto Naskh Arabic is SIL Open Font License 1.1, which permits redistribution
inside a commercial product. Keep the upstream `OFL.txt` alongside it.

## Verify

Generate a report whose findings, impression and recommendations are written in
Arabic, and open the PDF. You should see Arabic text, right-aligned. If the
boxes are empty or show hollow rectangles, the font was not picked up — check
the filename matches exactly and that the file is committed rather than
gitignored (`public/fonts/` is not currently ignored, but `*.ttf` may be
covered by a global rule — hence the `-f` above).

## Why this file exists

Committing a binary via tooling was not possible in the session that made the
surrounding fix, so the code path was completed and the asset left as the
single remaining step. Everything else about Arabic report rendering is done.
