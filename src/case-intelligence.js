// src/case-intelligence.js
// Core pipeline: extract text from case files, structure via Claude, aggregate per case.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Anthropic = require('@anthropic-ai/sdk');
var pdfParse = require('pdf-parse');
var { queryOne, queryAll, execute } = require('./pg');
var { major: logMajor, fatal: logFatal } = require('./logger');

var UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads');

var MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
var RETRY_DELAY_MS = 5000;

var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

var EXTRACTION_SYSTEM_PROMPT =
  'You are a medical document data extractor. You extract and organize data EXACTLY as it appears in documents. ' +
  'You NEVER interpret, diagnose, summarize findings, or add clinical commentary. ' +
  'Extract only. Never interpret.';

var EXTRACTION_USER_PROMPT =
  'Given the following extracted text from medical documents, return a JSON object with:\n\n' +
  '1. "document_category": one of: lab_report, imaging, referral_letter, prescription, intake_form, other\n' +
  '2. "language": "ar", "en", or "mixed"\n' +
  '3. "lab_values": array of objects, ONLY if this is a lab report:\n' +
  '   { "test": "exact test name as printed", "value": "numeric value with unit", "unit": "unit as printed", "reference_range": "range as printed on report", "status": "above" | "below" | "in_range" }\n' +
  '   Status is determined ONLY by comparing the numeric value to the printed reference range. Nothing else.\n' +
  '4. "patient_info": object with fields ONLY if explicitly stated in the text:\n' +
  '   { "name": "...", "age": "...", "gender": "...", "complaint": "...", "medications": "...", "allergies": "...", "family_history": "..." }\n' +
  '   If a field is not explicitly mentioned, set it to null. Do NOT infer.\n\n' +
  'Return ONLY valid JSON. No markdown, no explanation, no commentary.\n\n' +
  '--- DOCUMENT TEXT ---\n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var EXT_TO_TYPE = {
  '.pdf': 'pdf',
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image',
  '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.tiff': 'image', '.tif': 'image',
  '.dcm': 'dicom', '.dicom': 'dicom'
};

var EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.dcm': 'application/dicom'
};

function detectFileType(filename) {
  var ext = path.extname(filename || '').toLowerCase();
  return { type: EXT_TO_TYPE[ext] || 'other', mime: EXT_TO_MIME[ext] || 'application/octet-stream' };
}

// Arabic Unicode range: \u0600-\u06FF (Arabic), \u0750-\u077F (Arabic Supplement),
// \uFB50-\uFDFF (Arabic Presentation Forms-A), \uFE70-\uFEFF (Arabic Presentation Forms-B)
var ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
var ARABIC_CHAR_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;
var LATIN_CHAR_RE = /[a-zA-Z]/g;

function detectLanguage(text) {
  if (!text) return null;
  var arabicCount = (text.match(ARABIC_CHAR_RE) || []).length;
  var latinCount = (text.match(LATIN_CHAR_RE) || []).length;
  var total = arabicCount + latinCount;
  if (total === 0) return null;
  var arabicRatio = arabicCount / total;
  if (arabicRatio > 0.6) return 'ar';
  if (arabicRatio > 0.2) return 'mixed';
  return 'en';
}

// Check if extracted text looks like garbage/mojibake
// Heuristic: high ratio of replacement chars, control chars, or very low
// printable-to-total ratio relative to page count
var GARBAGE_RE = /[\uFFFD\uFFFE\uFFFF\u0000-\u0008\u000E-\u001F]/g;

function isGarbageText(text, pageCount) {
  if (!text) return true;
  var len = text.length;
  if (len === 0) return true;

  // Very short text relative to pages is suspicious (< 50 chars per page)
  if (pageCount && pageCount > 0 && len < pageCount * 50) return true;

  var garbageChars = (text.match(GARBAGE_RE) || []).length;
  // More than 20% garbage characters → bad OCR
  if (garbageChars / len > 0.2) return true;

  // Mostly whitespace/unprintable
  var printable = text.replace(/\s/g, '').length;
  if (printable < len * 0.1) return true;

  return false;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// 1. processUploadedFile
// ---------------------------------------------------------------------------

async function processUploadedFile(caseId, filePath, originalFilename) {
  var detected = detectFileType(originalFilename);
  var fileType = detected.type;
  var mime = detected.mime;
  var fileSize = null;

  try {
    var stats = fs.statSync(filePath);
    fileSize = stats.size;
  } catch (_) {}

  // --- DUPLICATE CHECK ---
  // Skip if a file with the same name + size already exists and is processed
  if (fileSize !== null) {
    var dupe = await queryOne(
      "SELECT id, processing_status FROM case_files WHERE case_id = $1 AND filename = $2 AND file_size_bytes = $3 AND processing_status NOT IN ('pending', 'failed') LIMIT 1",
      [caseId, originalFilename, fileSize]
    );
    if (dupe) {
      logMajor('[case-intelligence] Skipping duplicate: ' + originalFilename + ' (' + fileSize + ' bytes)');
      return;
    }
  }

  // Find or create the case_files row for this file
  var fileRow = await queryOne(
    'SELECT id FROM case_files WHERE case_id = $1 AND storage_path = $2 LIMIT 1',
    [caseId, filePath]
  );

  if (!fileRow) {
    var fileId = crypto.randomUUID();
    await execute(
      'INSERT INTO case_files (id, case_id, filename, file_type, storage_path, uploaded_at, is_valid, file_size_bytes, mime_type, processing_status) VALUES ($1, $2, $3, $4, $5, NOW(), true, $6, $7, $8)',
      [fileId, caseId, originalFilename, fileType, filePath, fileSize, mime, 'pending']
    );
    fileRow = { id: fileId };
  } else {
    await execute(
      'UPDATE case_files SET file_size_bytes = $1, mime_type = $2, processing_status = $3 WHERE id = $4',
      [fileSize, mime, 'pending', fileRow.id]
    );
  }

  // --- LARGE FILE CHECK ---
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    await execute(
      "UPDATE case_files SET processing_status = 'too_large', processing_error = $1, processed_at = NOW() WHERE id = $2",
      ['File exceeds 20 MB limit (' + Math.round(fileSize / 1024 / 1024) + ' MB) — cataloged without AI processing', fileRow.id]
    );
    return;
  }

  // Extract text based on file type
  var extractedText = null;
  var detectedLang = null;

  if (fileType === 'pdf') {
    try {
      var pdfBuffer = fs.readFileSync(filePath);
      var pdfData = await pdfParse(pdfBuffer);
      var rawText = (pdfData.text || '').trim();
      var pageCount = (pdfData.numpages || 0);

      // --- ARABIC / GARBAGE OCR CHECK ---
      if (isGarbageText(rawText, pageCount)) {
        // OCR failed — likely scanned Arabic or image-based PDF
        detectedLang = ARABIC_RE.test(rawText) ? 'ar' : null;
        await execute(
          "UPDATE case_files SET processing_status = 'ocr_failed', language_detected = $1, processing_error = $2, processed_at = NOW() WHERE id = $3",
          [detectedLang, 'OCR extraction returned unusable text — original PDF available for manual review', fileRow.id]
        );
        return;
      }

      extractedText = rawText;
      detectedLang = detectLanguage(extractedText);
    } catch (err) {
      await execute(
        "UPDATE case_files SET processing_status = 'failed', processing_error = $1, processed_at = NOW() WHERE id = $2",
        ['PDF parse error: ' + err.message, fileRow.id]
      );
      return;
    }
  } else if (fileType === 'image') {
    // --- SINGLE IMAGE / PHOTO HANDLING ---
    // Images are cataloged. No text extraction from photos.
    // Set category to unknown since we can't determine from pixels alone.
    await execute(
      "UPDATE case_files SET processing_status = 'partial', document_category = 'unknown', language_detected = $1, processing_error = $2, processed_at = NOW() WHERE id = $3",
      [null, 'Unable to extract text — original image available for review', fileRow.id]
    );
    return;
  } else {
    // DICOM / other — catalog only
    await execute(
      "UPDATE case_files SET processing_status = 'partial', document_category = $1, processed_at = NOW() WHERE id = $2",
      [fileType === 'dicom' ? 'imaging' : 'other', fileRow.id]
    );
    return;
  }

  // Update the row with extracted text + detected language
  await execute(
    "UPDATE case_files SET extracted_text = $1, language_detected = $2, processing_status = 'extracted', processed_at = NOW() WHERE id = $3",
    [extractedText, detectedLang, fileRow.id]
  );

  // If we got text, send it through Claude for structuring
  if (extractedText && extractedText.length > 0) {
    await structureFileData(fileRow.id, extractedText);
  }
}

// ---------------------------------------------------------------------------
// structureFileData — structure a single file's extracted text via Claude
// ---------------------------------------------------------------------------

async function structureFileData(fileId, text) {
  if (!process.env.ANTHROPIC_API_KEY) {
    await execute(
      "UPDATE case_files SET processing_error = 'No ANTHROPIC_API_KEY configured' WHERE id = $1",
      [fileId]
    );
    return;
  }

  var lastErr = null;

  // --- RETRY LOGIC: try up to 2 times ---
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: EXTRACTION_USER_PROMPT + text
        }]
      });

      var raw = (response.content && response.content[0] && response.content[0].text) || '';
      var clean = raw.replace(/```json\n?|```\n?/g, '').trim();
      var structured = JSON.parse(clean);

      await execute(
        'UPDATE case_files SET structured_data = $1, document_category = $2, language_detected = COALESCE(language_detected, $3) WHERE id = $4',
        [JSON.stringify(structured), structured.document_category || null, structured.language || null, fileId]
      );
      return; // success — exit retry loop

    } catch (err) {
      lastErr = err;
      var msg = err.message || '';
      var status = err.status || err.statusCode || 0;

      // Only retry on transient errors (rate limit, overloaded, timeout)
      var isRetryable = (
        status === 429 ||
        status === 529 ||
        msg.indexOf('rate_limit') !== -1 ||
        msg.indexOf('Rate limit') !== -1 ||
        msg.indexOf('overloaded') !== -1 ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNABORTED' ||
        msg.indexOf('timeout') !== -1
      );

      if (isRetryable && attempt === 0) {
        logMajor('[case-intelligence] Claude API failed (attempt 1), retrying in ' + RETRY_DELAY_MS + 'ms: ' + msg);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      // Not retryable or second attempt — fall through to error handling
      break;
    }
  }

  // Both attempts failed — record the error but don't block the case
  await execute(
    "UPDATE case_files SET processing_error = $1 WHERE id = $2",
    ['Structure error: ' + (lastErr ? lastErr.message : 'unknown'), fileId]
  );
}

// ---------------------------------------------------------------------------
// 2. structureExtractedData — re-run structuring for all files with text
// ---------------------------------------------------------------------------

async function structureExtractedData(caseId) {
  var files = await queryAll(
    "SELECT id, extracted_text FROM case_files WHERE case_id = $1 AND extracted_text IS NOT NULL AND extracted_text != '' AND structured_data IS NULL",
    [caseId]
  );

  for (var i = 0; i < files.length; i++) {
    await structureFileData(files[i].id, files[i].extracted_text);
  }

  await aggregateCaseData(caseId);
}

// ---------------------------------------------------------------------------
// 3. aggregateCaseData
// ---------------------------------------------------------------------------

async function aggregateCaseData(caseId) {
  var files = await queryAll(
    'SELECT id, filename, file_type, mime_type, file_size_bytes, document_category, language_detected, structured_data, processing_status FROM case_files WHERE case_id = $1',
    [caseId]
  );

  // Merge lab_values from all files
  var allLabValues = [];
  var mergedPatientInfo = { name: null, age: null, gender: null, complaint: null, medications: null, allergies: null, family_history: null };

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var sd = f.structured_data;
    if (!sd) continue;

    // sd might be a string if the DB returns it that way
    if (typeof sd === 'string') {
      try { sd = JSON.parse(sd); } catch (_) { continue; }
    }

    // Collect lab values
    if (Array.isArray(sd.lab_values)) {
      for (var j = 0; j < sd.lab_values.length; j++) {
        var lv = sd.lab_values[j];
        lv.source_file = f.filename;
        allLabValues.push(lv);
      }
    }

    // Merge patient info — prefer intake_form, then others
    if (sd.patient_info) {
      var isIntake = (sd.document_category === 'intake_form' || f.document_category === 'intake_form');
      var keys = Object.keys(mergedPatientInfo);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (key.indexOf('_source_file') !== -1) continue;
        var val = sd.patient_info[key];
        if (val !== null && val !== undefined) {
          if (isIntake || mergedPatientInfo[key] === null) {
            mergedPatientInfo[key] = val;
            mergedPatientInfo[key + '_source_file'] = f.filename;
          }
        }
      }
    }
  }

  // Build documents inventory
  var documentsInventory = [];
  for (var di = 0; di < files.length; di++) {
    var df = files[di];
    documentsInventory.push({
      filename: df.filename,
      type: df.document_category || df.file_type || 'unknown',
      language: df.language_detected || null,
      size: df.file_size_bytes || null,
      extracted: (df.processing_status === 'extracted'),
      status: df.processing_status
    });
  }

  // Determine missing documents
  var categoriesPresent = {};
  for (var ci = 0; ci < files.length; ci++) {
    var cat = files[ci].document_category;
    if (cat && cat !== 'unknown' && cat !== 'other') categoriesPresent[cat] = true;
  }

  var missingDocuments = [];
  if (!categoriesPresent.lab_report) {
    missingDocuments.push('No lab/blood work results');
  }
  if (!categoriesPresent.imaging) {
    missingDocuments.push('No imaging reports (X-ray, CT, MRI, ultrasound)');
  }
  if (!categoriesPresent.referral_letter) {
    missingDocuments.push('No referral letter or physician notes');
  }
  if (!categoriesPresent.prescription) {
    missingDocuments.push('No current medication list or prescriptions');
  }

  // Count files by processing outcome
  var filesExtracted = 0;
  var filesFailed = 0;
  var filesPartial = 0;
  for (var mi = 0; mi < files.length; mi++) {
    var ps = files[mi].processing_status;
    if (ps === 'extracted') filesExtracted++;
    else if (ps === 'failed' || ps === 'ocr_failed') filesFailed++;
    else if (ps === 'partial' || ps === 'too_large') filesPartial++;
  }

  // Upsert into case_extractions
  var metadata = JSON.stringify({
    files_processed: files.length,
    files_extracted: filesExtracted,
    files_failed: filesFailed,
    files_partial: filesPartial
  });

  var existing = await queryOne('SELECT id FROM case_extractions WHERE case_id = $1', [caseId]);

  if (existing) {
    await execute(
      'UPDATE case_extractions SET lab_values = $1, patient_info = $2, documents_inventory = $3, missing_documents = $4, extraction_metadata = $5, updated_at = NOW() WHERE case_id = $6',
      [
        JSON.stringify(allLabValues),
        JSON.stringify(mergedPatientInfo),
        JSON.stringify(documentsInventory),
        JSON.stringify(missingDocuments),
        metadata,
        caseId
      ]
    );
  } else {
    await execute(
      'INSERT INTO case_extractions (id, case_id, lab_values, patient_info, documents_inventory, missing_documents, extraction_metadata, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())',
      [
        crypto.randomUUID(),
        caseId,
        JSON.stringify(allLabValues),
        JSON.stringify(mergedPatientInfo),
        JSON.stringify(documentsInventory),
        JSON.stringify(missingDocuments),
        metadata
      ]
    );
  }

  // Mark case as ready
  await execute(
    "UPDATE cases SET intelligence_status = 'ready' WHERE id = $1",
    [caseId]
  );
}

// ---------------------------------------------------------------------------
// 4. processCaseIntelligence — main entry point
// ---------------------------------------------------------------------------

async function processCaseIntelligence(caseId) {
  try {
    await execute(
      "UPDATE cases SET intelligence_status = 'processing' WHERE id = $1",
      [caseId]
    );

    // Get all unprocessed files for this case
    var files = await queryAll(
      "SELECT id, storage_path, filename, file_size_bytes FROM case_files WHERE case_id = $1 AND (processing_status = 'pending' OR processing_status IS NULL)",
      [caseId]
    );

    var startTime = Date.now();

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var filePath = f.storage_path;

      // Resolve relative paths against upload root
      if (filePath && !path.isAbsolute(filePath)) {
        filePath = path.join(UPLOAD_ROOT, filePath);
      }

      if (!filePath || !fs.existsSync(filePath)) {
        await execute(
          "UPDATE case_files SET processing_status = 'failed', processing_error = 'File not found on disk' WHERE id = $1",
          [f.id]
        );
        continue;
      }

      await processUploadedFile(caseId, filePath, f.filename);
    }

    // Re-run structuring for any files that have text but no structured data
    await structureExtractedData(caseId);

    // Update metadata with timing
    var elapsed = Date.now() - startTime;
    var extraction = await queryOne('SELECT id FROM case_extractions WHERE case_id = $1', [caseId]);
    if (extraction) {
      await execute(
        "UPDATE case_extractions SET extraction_metadata = jsonb_set(COALESCE(extraction_metadata, '{}'), '{processing_time_ms}', $1::jsonb) WHERE case_id = $2",
        [JSON.stringify(elapsed), caseId]
      );
    }

    logMajor('[case-intelligence] Processed case ' + caseId + ' in ' + elapsed + 'ms (' + files.length + ' files)');
  } catch (err) {
    logFatal('[case-intelligence] Failed for case ' + caseId + ': ' + err.message);
    await execute(
      "UPDATE cases SET intelligence_status = 'failed' WHERE id = $1",
      [caseId]
    ).catch(function() {});
  }
}

// ---------------------------------------------------------------------------
// 5. reprocessCase — reset all files and re-run pipeline
// ---------------------------------------------------------------------------

async function reprocessCase(caseId) {
  // Reset all case_files back to pending
  await execute(
    "UPDATE case_files SET processing_status = 'pending', extracted_text = NULL, structured_data = NULL, document_category = NULL, language_detected = NULL, processing_error = NULL, processed_at = NULL WHERE case_id = $1",
    [caseId]
  );

  // Clear existing extractions
  await execute('DELETE FROM case_extractions WHERE case_id = $1', [caseId]);

  // Reset case status
  await execute(
    "UPDATE cases SET intelligence_status = 'none' WHERE id = $1",
    [caseId]
  );

  // Re-run the full pipeline
  await processCaseIntelligence(caseId);
}

module.exports = {
  processUploadedFile: processUploadedFile,
  structureExtractedData: structureExtractedData,
  aggregateCaseData: aggregateCaseData,
  processCaseIntelligence: processCaseIntelligence,
  reprocessCase: reprocessCase
};
