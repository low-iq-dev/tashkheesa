// src/ai_image_check.js
// AI-powered medical image validation using Claude Vision API

var fs = require('fs');
var https = require('https');
var http = require('http');

var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

function isImageMime(mime) {
  return /^image\/(jpeg|jpg|png|gif|webp|bmp|tiff)$/i.test(mime || '');
}

function isImageExtension(filename) {
  return /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(filename || '');
}

/**
 * Validate a medical image using Claude Vision API.
 * @param {Buffer} imageBuffer - raw image bytes
 * @param {string} mimeType - MIME type (e.g. image/jpeg)
 * @param {string} expectedScanType - what scan type was expected (e.g. "Brain MRI")
 * @returns {Promise<Object>} validation result
 */
async function validateMedicalImage(imageBuffer, mimeType, expectedScanType) {
  if (!ANTHROPIC_API_KEY) {
    return { skipped: true, reason: 'No API key configured' };
  }

  var base64Image = imageBuffer.toString('base64');

  // Supported media types for Claude Vision
  var mediaType = mimeType || 'image/jpeg';
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
    mediaType = 'image/jpeg'; // fallback
  }

  var requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64Image }
        },
        {
          type: 'text',
          text: 'You are a medical image quality checker for a telemedicine platform. Analyze this uploaded image and respond in JSON only:\n\n{\n  "is_medical_image": true/false,\n  "image_quality": "good" | "acceptable" | "poor",\n  "quality_issues": ["list of issues if any, e.g. too dark, blurry, cropped"],\n  "detected_scan_type": "what type of scan this appears to be (e.g. MRI brain, CT chest, X-ray chest, ECG, blood test report, etc)",\n  "matches_expected": true/false,\n  "confidence": 0.0-1.0,\n  "recommendation": "brief recommendation for the user"\n}\n\nExpected scan type for this case: ' + (expectedScanType || 'not specified') + '\n\nBe strict about quality — blurry or dark images will be useless for diagnosis. But be helpful in your recommendation.'
        }
      ]
    }]
  });

  return new Promise(function(resolve) {
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      timeout: 30000
    }, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try {
          var body = Buffer.concat(chunks).toString();
          var parsed = JSON.parse(body);
          if (parsed.content && parsed.content[0] && parsed.content[0].text) {
            var text = parsed.content[0].text;
            var clean = text.replace(/```json\n?|```\n?/g, '').trim();
            resolve(JSON.parse(clean));
          } else {
            resolve(fallbackResult('Unexpected API response'));
          }
        } catch (e) {
          resolve(fallbackResult('Parse error: ' + e.message));
        }
      });
    });

    req.on('error', function(e) {
      resolve(fallbackResult('Request error: ' + e.message));
    });

    req.on('timeout', function() {
      req.destroy();
      resolve(fallbackResult('Request timed out'));
    });

    req.write(requestBody);
    req.end();
  });
}

function fallbackResult(reason) {
  return {
    is_medical_image: null,
    image_quality: 'unknown',
    quality_issues: ['AI check failed: ' + reason],
    detected_scan_type: 'unknown',
    matches_expected: null,
    confidence: 0,
    recommendation: 'Manual review required'
  };
}

/**
 * Fetch image from URL and validate.
 * @param {string} url - image URL (UploadCare CDN or similar)
 * @param {string} expectedScanType
 * @returns {Promise<Object>}
 */
async function validateImageFromUrl(url, expectedScanType) {
  if (!ANTHROPIC_API_KEY || !url) {
    return { skipped: true, reason: 'No API key or URL' };
  }

  return new Promise(function(resolve) {
    var proto = url.startsWith('https') ? https : http;
    proto.get(url, { timeout: 15000 }, function(res) {
      if (res.statusCode !== 200) {
        return resolve(fallbackResult('HTTP ' + res.statusCode));
      }
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        var buffer = Buffer.concat(chunks);
        var contentType = res.headers['content-type'] || 'image/jpeg';
        resolve(validateMedicalImage(buffer, contentType, expectedScanType));
      });
    }).on('error', function(e) {
      resolve(fallbackResult('Fetch error: ' + e.message));
    });
  });
}

module.exports = {
  validateMedicalImage,
  validateImageFromUrl,
  isImageMime,
  isImageExtension
};
