'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');

let PDFDocument = null;
try {
  // Optional dependency. If installed, we can render real Arabic (Unicode) text.
  PDFDocument = require('pdfkit');
} catch (e) {
  PDFDocument = null;
}

// public/reports/* is served by express static as /reports/*
const REPORTS_DIR = path.join(process.cwd(), 'public', 'reports');
const REPORTS_URL_PREFIX = '/reports';

function ensureReportsDir() {
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
  return REPORTS_DIR;
}

function firstExistingPath(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

function findArabicFontPath() {
  // Prefer project-local font if you add one later.
  // You can drop any Arabic-capable TTF here.
  const localCandidates = [
    path.join(process.cwd(), 'public', 'fonts', 'arabic.ttf'),
    path.join(process.cwd(), 'public', 'fonts', 'Arabic.ttf'),
    path.join(process.cwd(), 'public', 'fonts', 'NotoNaskhArabic-Regular.ttf'),
    path.join(process.cwd(), 'public', 'fonts', 'NotoSansArabic-Regular.ttf'),
  ];

  // Common macOS fonts that include Arabic glyphs (paths vary by macOS version).
  const macCandidates = [
    '/System/Library/Fonts/Supplemental/GeezaPro.ttf',
    '/System/Library/Fonts/Supplemental/GeezaPro-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode MS.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode MS.ttf',
    '/System/Library/Fonts/HelveticaNeue.ttc',
  ];

  return firstExistingPath([...localCandidates, ...macCandidates]);
}

function pdfkitToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const writable = new stream.Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });

    writable.on('finish', () => resolve(Buffer.concat(chunks)));
    writable.on('error', reject);
    doc.on('error', reject);

    doc.pipe(writable);
    doc.end();
  });
}

function arabicLabel(text) {
  // PDFKit + fontkit usually handles Arabic shaping.
  // If you ever see disconnected letters, we can add shaping later.
  return String(text || '');
}

function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'case'
  );
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function pdfEscape(text) {
  // Escape backslashes and parentheses for PDF literal strings
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function formatReportDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function wrapLines(text, maxChars) {
  const raw = String(text || '').replace(/\r/g, '');
  const words = raw.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push('—');
  return lines;
}

function splitNotesIntoSections(notes) {
  // Markers (case-insensitive): Findings:, Impression:/Conclusion:, Recommendations:
  const text = String(notes || '');
  const sections = { findings: '', impression: '', recommendations: '' };

  const norm = text.replace(/\r/g, '');
  const re = /(findings?|observations?)\s*:\s*|impression\s*:\s*|conclusion\s*:\s*|recommendations?\s*:\s*/gi;

  if (!re.test(norm)) {
    sections.findings = norm.trim();
    return sections;
  }

  re.lastIndex = 0;
  let current = 'findings';
  let idx = 0;
  let m;

  function pushChunk(target, chunk) {
    const c = String(chunk || '').trim();
    if (!c) return;
    sections[target] = (sections[target] ? sections[target] + '\n\n' : '') + c;
  }

  while ((m = re.exec(norm)) !== null) {
    const markerStart = m.index;
    const markerText = String(m[0] || '').toLowerCase();
    pushChunk(current, norm.slice(idx, markerStart));

    if (markerText.startsWith('imp') || markerText.startsWith('concl')) current = 'impression';
    else if (markerText.startsWith('rec')) current = 'recommendations';
    else current = 'findings';

    idx = re.lastIndex;
  }
  pushChunk(current, norm.slice(idx));

  if (!sections.findings && (sections.impression || sections.recommendations)) sections.findings = '—';
  return sections;
}

/**
 * Minimal 1-page PDF builder. `contentStream` is raw PDF operators.
 */
function buildPdf({ contentStream }) {
  const parts = [];
  const offsets = [];

  function push(str) {
    parts.push(Buffer.from(str, 'binary'));
  }

  function addObj(n, body) {
    offsets[n] = Buffer.concat(parts).length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  }

  // Header: use byte escapes to avoid encoding issues.
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  // 1 Catalog
  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);

  // 2 Pages
  addObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);

  // 3 Page
  addObj(
    3,
    `<< /Type /Page\n   /Parent 2 0 R\n   /MediaBox [0 0 612 792]\n   /Resources <<\n     /Font << /F1 4 0 R /F2 5 0 R >>\n     /ExtGState << /GS1 6 0 R >>\n   >>\n   /Contents 7 0 R\n>>`
  );

  // 4 Helvetica
  addObj(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  // 5 Helvetica-Bold
  addObj(5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);

  // 6 ExtGState (watermark opacity)
  addObj(6, `<< /Type /ExtGState /ca 0.08 /CA 0.08 >>`);

  const streamBuf = Buffer.from(String(contentStream || ''), 'binary');
  addObj(7, `<< /Length ${streamBuf.length} >>\nstream\n${contentStream}\nendstream`);

  // xref
  const xrefStart = Buffer.concat(parts).length;
  push('xref\n0 8\n');
  push('0000000000 65535 f \n');
  for (let i = 1; i <= 7; i++) {
    const off = offsets[i] || 0;
    push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }

  // trailer
  push(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(parts);
}

async function generateStyledReportPdfUnicode({ caseId, doctorName, specialty, createdAt, notes, patient, findings, impression, recommendations } = {}) {
  if (!PDFDocument) {
    throw new Error('pdfkit is not installed');
  }

  ensureReportsDir();

  const fileName = `${slugify(caseId)}-${stamp()}.pdf`;
  const absPath = path.join(REPORTS_DIR, fileName);
  const urlPath = `${REPORTS_URL_PREFIX}/${fileName}`;

  const BLUE = '#0073B3';
  const BORDER = '#D0D0D0';
  const MUTED = '#6B7280';
  const BG = '#F6F7F9';

  const title = 'Tashkheesa Diagnostic Opinion Report';
  const caseRef = String(caseId || '—');
  const dateStr = formatReportDate(createdAt);

  const patientName = patient && patient.name ? String(patient.name) : '—';
  const patientAge = patient && patient.age ? String(patient.age) : '—';
  const patientGender = patient && patient.gender ? String(patient.gender) : '—';

  const hasSeparateSections =
    (typeof findings === 'string' && findings.trim()) ||
    (typeof impression === 'string' && impression.trim()) ||
    (typeof recommendations === 'string' && recommendations.trim());

  const sections = hasSeparateSections
    ? {
        findings: String(findings || '').trim() || '—',
        impression: String(impression || '').trim() || '—',
        recommendations: String(recommendations || '').trim() || '—',
      }
    : splitNotesIntoSections(notes);

  const ar = {
    patientInfo: 'بيانات المريض',
    doctorInfo: 'بيانات الطبيب',
    findings: 'النتائج / الملاحظات',
    impression: 'الانطباع / الخلاصة',
    recommendations: 'التوصيات',
    disclaimer: 'إخلاء المسؤولية',
    signature: 'توقيع الطبيب',
  };

  const arabicFontPath = findArabicFontPath();

  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });

  // Layout helpers (keeps content from colliding with the footer)
  function footerTopY() {
    // Footer lives inside the bottom margin area. Keep it close to the bottom.
    return doc.page.height - doc.page.margins.bottom - 28;
  }

  function bottomLimit() {
    // Keep a little breathing room above the footer.
    return footerTopY() - 16;
  }

  function ensureSpace(h) {
    if (doc.y + h > bottomLimit()) {
      doc.addPage();
    }
  }

  function drawWatermark() {
    // IMPORTANT: PDFKit's doc.text() mutates doc.y; preserve cursor so
    // watermark drawing doesn't shift the main layout down the page.
    const savedX = doc.x;
    const savedY = doc.y;

    doc.save();
    doc.fillColor(BLUE);
    doc.opacity(0.06);

    const cx = doc.page.width / 2;
    const cy = doc.page.height / 2;

    doc.rotate(-25, { origin: [cx, cy] });
    doc.font('Helvetica-Bold').fontSize(78);
    // Draw at an absolute position, but do NOT let it affect the layout cursor
    doc.text('Tashkheesa', 0, cy - 40, { width: doc.page.width, align: 'center', lineBreak: false });

    doc.restore();
    doc.opacity(1);

    // Restore layout cursor
    doc.x = savedX;
    doc.y = savedY;
  }

  function drawFooter() {
    // IMPORTANT: PDFKit's doc.text() mutates doc.y; preserve cursor so
    // footer drawing doesn't shift the main layout.
    const savedX = doc.x;
    const savedY = doc.y;

    const x0 = doc.page.margins.left;
    const x1 = doc.page.width - doc.page.margins.right;
    const w = x1 - x0;

    // Place footer near bottom inside reserved area.
    const y1 = footerTopY();
    const y2 = y1 + 12;

    doc.save();
    doc.fillColor(BLUE);
    doc.font('Helvetica').fontSize(9);
    doc.text('www.tashkheesa.com  |  info@tashkheesa.com  |  +20 100 000 0000', x0, y1, { width: w, align: 'center', lineBreak: false });
    doc.text('See healthcare from a different view.', x0, y2, { width: w, align: 'center', lineBreak: false });
    doc.restore();

    // Restore layout cursor
    doc.x = savedX;
    doc.y = savedY;
  }

  // Apply decorations to every page (including first)
  // NOTE: doc.text() can mutate the internal cursor even when we pass absolute x/y.
  // We hard-reset the cursor after drawing decorations to prevent large blank offsets.
  drawWatermark();
  drawFooter();
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;

  doc.on('pageAdded', () => {
    drawWatermark();
    drawFooter();
    // New pages should always start at the normal content origin.
    // (Safe here because we only add pages explicitly via ensureSpace.)
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
  });

  // Title
  doc.fillColor(BLUE);
  doc.font('Helvetica-Bold').fontSize(18).text(title, { align: 'center' });
  doc.moveDown(0.4);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(BORDER)
    .stroke();
  doc.moveDown(0.8);

  // Case row
  const x0 = doc.page.margins.left;
  const x1 = doc.page.width - doc.page.margins.right;
  const rowH = 26;
  const yRow = doc.y;
  doc.roundedRect(x0, yRow, 280, rowH, 6).fillAndStroke(BG, BORDER);
  doc.fillColor('#111827');
  doc.font('Helvetica-Bold').fontSize(11).text(`Case Reference: ${caseRef}`, x0 + 10, yRow + 7, { width: 260 });
  doc.font('Helvetica').fontSize(11).text(`Date: ${dateStr}`, x0 + 300, yRow + 7, { width: x1 - (x0 + 300) });
  // Tighten spacing after the top row
  doc.y = yRow + rowH + 14;

  function sectionHeader(en, arText) {
    // Ensure we don't start a section header in the footer zone
    ensureSpace(34);

    const y = doc.y;
    doc.fillColor(BLUE);
    doc.font('Helvetica-Bold').fontSize(12).text(`${en} /`, x0, y);

    // Arabic label aligned to the right side for a cleaner bilingual look
    if (arabicFontPath && arText) {
      try {
        const arW = 220;
        doc.font(arabicFontPath).fontSize(12);
        doc.text(arabicLabel(arText), x1 - arW, y, { width: arW, align: 'right' });
      } catch (_) {
        // ignore
      }
      doc.font('Helvetica');
    }

    // Compact spacing
    doc.y = y + 16;
  }

  function infoTable(rows) {
    // Keep tables from getting pushed into the footer
    ensureSpace(78);

    const startY = doc.y;
    const w = x1 - x0;
    const h = 48;

    // Proportional columns (keeps layout stable)
    const col1W = Math.round(w * 0.55);
    const col2W = Math.round(w * 0.22);
    const col3W = w - col1W - col2W;
    const c1X = x0 + col1W;
    const c2X = c1X + col2W;

    doc.rect(x0, startY, w, h).strokeColor(BORDER).stroke();

    // split lines
    doc.moveTo(x0, startY + 18).lineTo(x1, startY + 18).strokeColor(BORDER).stroke();
    doc.moveTo(c1X, startY).lineTo(c1X, startY + h).strokeColor(BORDER).stroke();
    doc.moveTo(c2X, startY).lineTo(c2X, startY + h).strokeColor(BORDER).stroke();

    doc.fillColor('#111827');
    doc.font('Helvetica').fontSize(10);

    // row 1 (English values)
    doc.text(rows[0] || '', x0 + 10, startY + 5, { width: col1W - 20 });
    doc.text(rows[1] || '', c1X + 10, startY + 5, { width: col2W - 20 });
    doc.text(rows[2] || '', c2X + 10, startY + 5, { width: col3W - 20 });

    // row 2 (Arabic labels)
    if (arabicFontPath) {
      try {
        doc.fillColor('#111827');
        doc.font(arabicFontPath).fontSize(10);

        // Right-align Arabic inside each cell
        doc.text(arabicLabel(rows[3] || ''), x0 + 10, startY + 25, { width: col1W - 20, align: 'right' });
        doc.text(arabicLabel(rows[4] || ''), c1X + 10, startY + 25, { width: col2W - 20, align: 'right' });
        doc.text(arabicLabel(rows[5] || ''), c2X + 10, startY + 25, { width: col3W - 20, align: 'right' });
      } catch (_) {
        // ignore
      }
      doc.font('Helvetica');
    }

    // Compact spacing after table
    doc.y = startY + h + 14;
  }

  function notesBox(textBody, maxLines) {
    const w = x1 - x0;
    const lines = wrapLines(textBody || '—', 95);
    const visible = lines.slice(0, maxLines);

    const lineH = 14;
    const boxH = Math.max(58, lineH * visible.length + 18);

    // If the box won’t fit, move to a fresh page (so we never clash with footer)
    ensureSpace(boxH + 22);

    const y = doc.y;
    doc.rect(x0, y, w, boxH).strokeColor(BORDER).stroke();

    doc.fillColor('#111827');
    doc.font('Helvetica').fontSize(10);

    let ty = y + 10;
    for (const line of visible) {
      doc.text(line, x0 + 10, ty, { width: w - 20 });
      ty += lineH;
    }

    // Compact spacing after the box
    doc.y = y + boxH + 14;
  }

  // Patient
  sectionHeader('Patient Information', ar.patientInfo);
  infoTable([
    `Name: ${patientName}`,
    `Age: ${patientAge}`,
    `Gender: ${patientGender}`,
    'الاسم',
    'العمر',
    'النوع',
  ]);

  // Doctor
  sectionHeader('Doctor Information', ar.doctorInfo);
  // Use 2-column layout (Doctor / Specialty), leave last column blank
  const docRow = [
    `Doctor: ${doctorName || '—'}`,
    `Specialty: ${specialty || '—'}`,
    '',
    'الطبيب',
    'التخصص',
    '',
  ];
  infoTable(docRow);

  // Findings
  sectionHeader('Findings / Observations', ar.findings);
  notesBox(sections.findings, 10);

  // Impression
  sectionHeader('Impression / Conclusion', ar.impression);
  notesBox(sections.impression || '—', 6);

  // Recommendations
  sectionHeader('Recommendations', ar.recommendations);
  notesBox(sections.recommendations || '—', 6);

  // Disclaimer
  sectionHeader('Disclaimer', ar.disclaimer);
  const disclaimer =
    'This report represents a professional medical opinion based on the files provided. It is intended to assist in medical decision-making and does not replace in-person clinical evaluation.';
  notesBox(disclaimer, 4);

  // Signature
  sectionHeader('Doctor Signature', ar.signature);
  doc.moveTo(x0, doc.y + 8).lineTo(x0 + 240, doc.y + 8).strokeColor('#111827').stroke();
  doc.moveDown(1.2);
  doc.fillColor('#111827');
  doc.font('Helvetica').fontSize(10).text(`${doctorName || '—'}`, x0, doc.y - 4);


  const buf = await pdfkitToBuffer(doc);
  fs.writeFileSync(absPath, buf);

  return urlPath;
}

function generateStyledReportPdfLegacy({ caseId, doctorName, specialty, createdAt, notes, patient, findings, impression, recommendations } = {}) {
  ensureReportsDir();

  const fileName = `${slugify(caseId)}-${stamp()}.pdf`;
  const absPath = path.join(REPORTS_DIR, fileName);
  const urlPath = `${REPORTS_URL_PREFIX}/${fileName}`;

  const title = 'Tashkheesa Diagnostic Opinion Report';
  const caseRef = String(caseId || '—');
  const dateStr = formatReportDate(createdAt);

  const patientName = patient && patient.name ? String(patient.name) : '—';
  const patientAge = patient && patient.age ? String(patient.age) : '—';
  const patientGender = patient && patient.gender ? String(patient.gender) : '—';

  // Notes can come either as one combined blob (notes) OR as separate fields.
  const hasSeparateSections =
    (typeof findings === 'string' && findings.trim()) ||
    (typeof impression === 'string' && impression.trim()) ||
    (typeof recommendations === 'string' && recommendations.trim());

  const sections = hasSeparateSections
    ? {
        findings: String(findings || '').trim() || '—',
        impression: String(impression || '').trim() || '—',
        recommendations: String(recommendations || '').trim() || '—',
      }
    : splitNotesIntoSections(notes);

  const findingsLines = wrapLines(sections.findings, 95);
  const impressionLines = wrapLines(sections.impression || '—', 95);
  const recLines = wrapLines(sections.recommendations || '—', 95);

  // Colors
  const BLUE = '0.00 0.45 0.70';
  const GRAY_BG = '0.96 0.97 0.98';
  const GRAY_STROKE = '0.80 0.80 0.80';

  // Layout
  const left = 72;
  const right = 540;
  const pageTop = 760;
  let y = pageTop;

  function text(font, size, x, yy, txt, rgbFill) {
    const s = pdfEscape(txt);
    const rgb = rgbFill ? `${rgbFill} rg\n` : '';
    return `${rgb}BT /${font} ${size} Tf 1 0 0 1 ${x} ${yy} Tm (${s}) Tj ET\n`;
  }

  function rect(x, yy, w, h, fillRgb, strokeRgb) {
    let out = '';
    if (fillRgb) out += `${fillRgb} rg\n`;
    if (strokeRgb) out += `${strokeRgb} RG\n`;
    out += `${x} ${yy} ${w} ${h} re\n`;
    if (fillRgb && strokeRgb) out += 'B\n';
    else if (fillRgb) out += 'f\n';
    else out += 'S\n';
    return out;
  }

  function hline(x1, x2, yy, strokeRgb) {
    return `${strokeRgb || '0 0 0'} RG\n1 w\n${x1} ${yy} m ${x2} ${yy} l S\n`;
  }

  function arBlock(x, yy, w, h) {
    // Solid black rectangle placeholder for Arabic text (matches your mock)
    return rect(x, yy, w, h, '0 0 0', null);
  }

  let cs = '';

  // Watermark
  cs += `q\n${BLUE} rg\n/GS1 gs\n0.9063 0.4226 -0.4226 0.9063 306 396 cm\n`;
  cs += `BT /F2 72 Tf 1 0 0 1 -230 0 Tm (${pdfEscape('Tashkheesa')}) Tj ET\n`;
  cs += `Q\n`;

  // Title
  cs += text('F2', 18, 170, y, title, BLUE);
  y -= 28;
  cs += hline(left, right, y, GRAY_STROKE);
  y -= 18;

  // Case ref row
  cs += rect(left, y - 22, 280, 26, GRAY_BG, GRAY_STROKE);
  cs += text('F2', 11, left + 10, y - 6, `Case Reference: ${caseRef}`, null);
  cs += text('F1', 11, left + 300, y - 6, `Date: ${dateStr}`, null);
  y -= 48;

  // Patient header
  cs += text('F2', 12, left, y, 'Patient Information /', BLUE);
  cs += arBlock(left + 160, y - 10, 110, 10);
  y -= 16;

  cs += rect(left, y - 44, right - left, 52, null, GRAY_STROKE);
  cs += hline(left, right, y - 18, GRAY_STROKE);
  cs += `${GRAY_STROKE} RG\n1 w\n${left + 280} ${y - 44} m ${left + 280} ${y + 8} l S\n`;
  cs += `${GRAY_STROKE} RG\n1 w\n${left + 420} ${y - 44} m ${left + 420} ${y + 8} l S\n`;

  cs += text('F1', 10, left + 10, y - 10, `Name: ${patientName}`, null);
  cs += text('F1', 10, left + 290, y - 10, `Age: ${patientAge}`, null);
  cs += text('F1', 10, left + 430, y - 10, `Gender: ${patientGender}`, null);

  // Arabic placeholders row
  cs += arBlock(left + 70, y - 34, 120, 10);
  cs += arBlock(left + 305, y - 34, 70, 10);
  cs += arBlock(left + 450, y - 34, 70, 10);

  y -= 74;

  // Doctor header
  cs += text('F2', 12, left, y, 'Doctor Information /', BLUE);
  cs += arBlock(left + 155, y - 10, 110, 10);
  y -= 16;

  cs += rect(left, y - 44, right - left, 52, null, GRAY_STROKE);
  cs += hline(left, right, y - 18, GRAY_STROKE);
  cs += `${GRAY_STROKE} RG\n1 w\n${left + 320} ${y - 44} m ${left + 320} ${y + 8} l S\n`;

  // No license block
  cs += text('F1', 10, left + 10, y - 10, `Doctor: ${doctorName || '—'}`, null);
  cs += text('F1', 10, left + 330, y - 10, `Specialty: ${specialty || '—'}`, null);

  // Arabic placeholders row
  cs += arBlock(left + 70, y - 34, 120, 10);
  cs += arBlock(left + 385, y - 34, 120, 10);

  y -= 78;

  // Findings
  cs += text('F2', 12, left, y, 'Findings / Observations /', BLUE);
  cs += arBlock(left + 205, y - 10, 90, 10);
  y -= 14;

  let boxH = Math.max(74, 16 * Math.min(10, findingsLines.length) + 18);
  cs += rect(left, y - boxH, right - left, boxH, null, GRAY_STROKE);
  let ty = y - 18;
  for (const line of findingsLines.slice(0, 10)) {
    cs += text('F1', 10, left + 10, ty, line, null);
    ty -= 14;
  }
  y -= boxH + 22;

  // Impression
  cs += text('F2', 12, left, y, 'Impression / Conclusion /', BLUE);
  cs += arBlock(left + 200, y - 10, 90, 10);
  y -= 14;

  boxH = Math.max(56, 16 * Math.min(6, impressionLines.length) + 18);
  cs += rect(left, y - boxH, right - left, boxH, null, GRAY_STROKE);
  ty = y - 18;
  for (const line of impressionLines.slice(0, 6)) {
    cs += text('F1', 10, left + 10, ty, line, null);
    ty -= 14;
  }
  y -= boxH + 22;

  // Recommendations
  cs += text('F2', 12, left, y, 'Recommendations /', BLUE);
  cs += arBlock(left + 140, y - 10, 90, 10);
  y -= 14;

  boxH = Math.max(56, 16 * Math.min(6, recLines.length) + 18);
  cs += rect(left, y - boxH, right - left, boxH, null, GRAY_STROKE);
  ty = y - 18;
  for (const line of recLines.slice(0, 6)) {
    cs += text('F1', 10, left + 10, ty, line, null);
    ty -= 14;
  }
  y -= boxH + 18;

  // Disclaimer
  cs += text('F2', 12, left, y, 'Disclaimer /', BLUE);
  cs += arBlock(left + 95, y - 10, 90, 10);
  y -= 14;

  const disclaimer =
    'This report represents a professional medical opinion based on the files provided. It is intended to assist in medical decision-making and does not replace in-person clinical evaluation.';
  const discLines = wrapLines(disclaimer, 95);
  boxH = Math.max(46, 14 * Math.min(4, discLines.length) + 16);
  cs += rect(left, y - boxH, right - left, boxH, null, GRAY_STROKE);
  ty = y - 18;
  for (const line of discLines.slice(0, 4)) {
    cs += text('F1', 9.5, left + 10, ty, line, null);
    ty -= 13;
  }
  // Arabic disclaimer placeholder
  cs += arBlock(left + 10, (y - boxH) + 8, 220, 10);

  y -= boxH + 18;

  // Signature
  cs += text('F2', 12, left, y, 'Doctor Signature /', BLUE);
  cs += arBlock(left + 140, y - 10, 90, 10);
  y -= 10;

  cs += hline(left, left + 240, y, '0 0 0');
  y -= 14;
  cs += text('F1', 10, left, y, `${doctorName || '—'}`, null);

  // Footer
  cs += `${BLUE} rg\n`;
  cs += text('F1', 9, left, 60, 'www.tashkheesa.com  |  info@tashkheesa.com  |  +20 100 000 0000', null);
  cs += text('F1', 9, left, 44, 'See healthcare from a different view.', null);

  const pdf = buildPdf({ contentStream: cs });
  fs.writeFileSync(absPath, pdf);
  return urlPath;
}

async function generateMedicalReportPdf(payload) {
  // Always try styled first; fallback writes a minimal report so the workflow never blocks.
  try {
    const p = payload || {};

    // If routes pass separate fields, normalize them into the generator.
    const normalized = {
      ...p,
      findings: p.findings || p.notes_findings,
      impression: p.impression || p.notes_impression,
      recommendations: p.recommendations || p.notes_recommendations,
    };

    // Prefer Unicode (Arabic-capable) generator when PDFKit is available.
    if (PDFDocument) {
      try {
        return await generateStyledReportPdfUnicode(normalized);
      } catch (_) {
        // fall back to legacy
      }
    }

    return generateStyledReportPdfLegacy(normalized);
  } catch (e) {
    ensureReportsDir();

    const fileName = `${slugify(payload && payload.caseId)}-${stamp()}-fallback.pdf`;
    const absPath = path.join(REPORTS_DIR, fileName);
    const urlPath = `${REPORTS_URL_PREFIX}/${fileName}`;

    const title = 'Tashkheesa Diagnostic Opinion Report';
    const caseRef = String((payload && payload.caseId) || '—');
    const dateStr = formatReportDate(payload && payload.createdAt);

    const notes = (() => {
      const p = payload || {};
      if (p.notes) return String(p.notes);

      const f = String(p.findings || p.notes_findings || '').trim();
      const i = String(p.impression || p.notes_impression || '').trim();
      const r = String(p.recommendations || p.notes_recommendations || '').trim();

      const combined = [
        f ? `Findings:\n${f}` : '',
        i ? `Impression:\n${i}` : '',
        r ? `Recommendations:\n${r}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      return combined || '—';
    })();

    let yy = 760;
    let out = '';
    out += `BT /F2 16 Tf 1 0 0 1 72 ${yy} Tm (${pdfEscape(title)}) Tj ET\n`;
    yy -= 28;
    out += `BT /F1 11 Tf 1 0 0 1 72 ${yy} Tm (${pdfEscape(`Case Reference: ${caseRef}`)}) Tj ET\n`;
    yy -= 18;
    out += `BT /F1 11 Tf 1 0 0 1 72 ${yy} Tm (${pdfEscape(`Date: ${dateStr}`)}) Tj ET\n`;
    yy -= 24;
    out += `BT /F2 12 Tf 1 0 0 1 72 ${yy} Tm (${pdfEscape('Notes:')}) Tj ET\n`;
    yy -= 18;

    const noteLines = wrapLines(notes, 100).slice(0, 70);
    for (const line of noteLines) {
      out += `BT /F1 10 Tf 1 0 0 1 72 ${yy} Tm (${pdfEscape(line)}) Tj ET\n`;
      yy -= 14;
      if (yy < 80) break;
    }

    const pdf = buildPdf({ contentStream: out });
    fs.writeFileSync(absPath, pdf);
    console.warn('[report-generator] report generation failed; used fallback:', e && e.message);
    return urlPath;
  }
}

module.exports = { generateMedicalReportPdf };