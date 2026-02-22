/**
 * Tashkheesa Instagram Image Generator
 * Uses OpenAI DALL-E 3 for generation + Cloudinary for permanent hosting.
 */

const OpenAI = require('openai');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const BRAND_PREFIX =
  'STRICT RULES: Abstract minimal geometric vector design only. Dark navy background (#0f172a). Teal (#38B2AC) and blue (#2B6CB0) accent colors only. ABSOLUTELY NO people, no faces, no hands, no human figures, no photorealism. Clean flat vector illustration style. No text or words. Square format. Design: ';

/**
 * Generate an image with DALL-E 3 and upload to Cloudinary.
 * @param {string} prompt - Image description
 * @param {string} postId - Used as Cloudinary public_id
 * @returns {Promise<{dalleUrl: string, cloudinaryUrl: string, publicId: string}>}
 */
async function generateImage(prompt, postId) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const fullPrompt = BRAND_PREFIX + prompt;
  console.log(`[IG ImageGen] Generating image for ${postId}: "${prompt.substring(0, 80)}..."`);

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: fullPrompt,
    n: 1,
    size: '1024x1024',
    quality: 'standard',
  });

  const dalleUrl = response.data[0].url;
  console.log(`[IG ImageGen] DALL-E returned image, uploading to Cloudinary...`);

  const cloudResult = await uploadToCloudinary(dalleUrl, postId);

  return {
    dalleUrl,
    cloudinaryUrl: cloudResult.cloudinaryUrl,
    publicId: cloudResult.publicId,
  };
}

/**
 * Regenerate image with original prompt + revision feedback.
 * @param {string} originalPrompt
 * @param {string} feedback - Owner's revision instructions
 * @param {string} postId
 * @returns {Promise<{dalleUrl: string, cloudinaryUrl: string, publicId: string}>}
 */
async function regenerateImage(originalPrompt, feedback, postId) {
  const combinedPrompt = feedback
    ? `${originalPrompt}. Revision instructions: ${feedback}`
    : originalPrompt;

  return generateImage(combinedPrompt, postId);
}

/**
 * Upload an image URL to Cloudinary.
 * @param {string} imageUrl - Source URL (e.g. DALL-E temporary URL)
 * @param {string} postId - Used for folder/naming
 * @returns {Promise<{cloudinaryUrl: string, publicId: string}>}
 */
async function uploadToCloudinary(imageUrl, postId) {
  const sanitizedId = String(postId).replace(/[^a-zA-Z0-9_-]/g, '_');

  const result = await cloudinary.uploader.upload(imageUrl, {
    folder: 'tashkheesa/instagram',
    public_id: sanitizedId,
    overwrite: true,
    resource_type: 'image',
  });

  console.log(`[IG ImageGen] Cloudinary upload complete: ${result.secure_url}`);

  return {
    cloudinaryUrl: result.secure_url,
    publicId: result.public_id,
  };
}

module.exports = { generateImage, regenerateImage, uploadToCloudinary };
