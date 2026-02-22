/**
 * Tashkheesa Instagram Admin Routes
 * Mount at: app.use('/api/admin/instagram', instagramRoutes);
 */

const express = require('express');
const router = express.Router();
const { InstagramPublisher } = require('./publisher');
const { InstagramClient } = require('./client');
const { queryOne, queryAll, execute } = require('../pg');

const publisher = new InstagramPublisher();
const client = new InstagramClient();

// ── Account ──

router.get('/account', async (req, res) => {
  try {
    const info = await client.getAccountInfo();
    res.json({ success: true, data: info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/token-status', async (req, res) => {
  try {
    const debug = await client.debugToken();
    res.json({
      success: true,
      data: {
        isValid: debug.is_valid,
        expiresAt: new Date(debug.expires_at * 1000).toISOString(),
        scopes: debug.scopes,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/refresh-token', async (req, res) => {
  try {
    const result = await client.refreshLongLivedToken();
    res.json({ success: true, message: 'Token refreshed', expiresIn: `${Math.round(result.expiresIn / 86400)} days` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Publishing ──

router.post('/publish/image', async (req, res) => {
  try {
    const { imageUrl, caption, publishTime } = req.body;
    if (!imageUrl || !caption) return res.status(400).json({ success: false, error: 'imageUrl and caption required' });
    const result = await publisher.publishImage({ imageUrl, caption, publishTime });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/publish/carousel', async (req, res) => {
  try {
    const { imageUrls, caption, publishTime } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length < 2) return res.status(400).json({ success: false, error: 'imageUrls array (min 2) required' });
    if (!caption) return res.status(400).json({ success: false, error: 'caption required' });
    const result = await publisher.publishCarousel({ imageUrls, caption, publishTime });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/publish/story', async (req, res) => {
  try {
    const { mediaUrl, mediaType } = req.body;
    if (!mediaUrl) return res.status(400).json({ success: false, error: 'mediaUrl required' });
    const result = await publisher.publishStory({ mediaUrl, mediaType });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/publish/reel', async (req, res) => {
  try {
    const { videoUrl, caption, coverUrl, shareToFeed, publishTime } = req.body;
    if (!videoUrl || !caption) return res.status(400).json({ success: false, error: 'videoUrl and caption required' });
    const result = await publisher.publishReel({ videoUrl, caption, coverUrl, shareToFeed, publishTime });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Scheduling ──

router.post('/schedule', async (req, res) => {
  try {
    const { type, imageUrls, caption, scheduledAt, label } = req.body;
    if (!type || !scheduledAt || !caption) return res.status(400).json({ success: false, error: 'type, caption, and scheduledAt required' });

    const { randomUUID } = require('crypto');
    const id = randomUUID();
    const now = new Date().toISOString();

    await execute(
      `INSERT INTO ig_scheduled_posts (id, post_type, image_urls, caption, scheduled_at, post_label, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [id, type, JSON.stringify(imageUrls || []), caption, new Date(scheduledAt).toISOString(), label || null, now, now]
    );

    const post = await queryOne('SELECT * FROM ig_scheduled_posts WHERE id = $1', [id]);
    res.json({ success: true, data: post });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/schedule', async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    let query = 'SELECT * FROM ig_scheduled_posts';
    const params = [];
    let paramIdx = 1;
    if (status) { query += ` WHERE status = $${paramIdx++}`; params.push(status); }
    query += ` ORDER BY scheduled_at ASC LIMIT $${paramIdx}`;
    params.push(Number(limit));

    const posts = await queryAll(query, params);
    res.json({ success: true, data: posts, count: posts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/schedule/:id', async (req, res) => {
  try {
    const result = await execute(
      `DELETE FROM ig_scheduled_posts WHERE id = $1 AND status = 'pending'`,
      [req.params.id]
    );

    if (result.rowCount === 0) return res.status(404).json({ success: false, error: 'Post not found or already published' });
    res.json({ success: true, message: 'Scheduled post cancelled' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AI Image Generation ──

router.post('/generate/:postId', async (req, res) => {
  try {
    const post = await queryOne('SELECT * FROM ig_scheduled_posts WHERE id = $1', [req.params.postId]);
    if (!post) return res.status(404).json({ success: false, error: 'Post not found' });

    if (!post.image_prompt) {
      return res.status(400).json({ success: false, error: 'No image_prompt set for this post' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ success: false, error: 'OPENAI_API_KEY not configured' });
    }

    const { generateImage } = require('./image_generator');
    const result = await generateImage(post.image_prompt, post.id);
    const now = new Date().toISOString();

    await execute(
      `UPDATE ig_scheduled_posts
       SET image_urls = $1, generation_count = COALESCE(generation_count, 0) + 1, updated_at = $2
       WHERE id = $3`,
      [JSON.stringify([result.cloudinaryUrl]), now, post.id]
    );

    res.json({ success: true, imageUrl: result.cloudinaryUrl });
  } catch (err) {
    console.error('[IG Generate] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/regenerate/:postId', async (req, res) => {
  try {
    const post = await queryOne('SELECT * FROM ig_scheduled_posts WHERE id = $1', [req.params.postId]);
    if (!post) return res.status(404).json({ success: false, error: 'Post not found' });

    if (!post.image_prompt) {
      return res.status(400).json({ success: false, error: 'No image_prompt set for this post' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ success: false, error: 'OPENAI_API_KEY not configured' });
    }

    const feedback = (req.body && req.body.feedback) || '';
    const { regenerateImage } = require('./image_generator');
    const result = await regenerateImage(post.image_prompt, feedback, post.id);
    const now = new Date().toISOString();

    await execute(
      `UPDATE ig_scheduled_posts
       SET image_urls = $1, generation_count = COALESCE(generation_count, 0) + 1,
           status = 'pending_approval', rejection_feedback = NULL, updated_at = $2
       WHERE id = $3`,
      [JSON.stringify([result.cloudinaryUrl]), now, post.id]
    );

    res.json({ success: true, imageUrl: result.cloudinaryUrl });
  } catch (err) {
    console.error('[IG Regenerate] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Insights ──

router.get('/insights/account', async (req, res) => {
  try {
    const { period = 'day', since, until } = req.query;
    const insights = await client.getAccountInsights(period, since, until);
    res.json({ success: true, data: insights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/insights/media/:mediaId', async (req, res) => {
  try {
    const insights = await client.getMediaInsights(req.params.mediaId);
    res.json({ success: true, data: insights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Comments ──

router.get('/comments/:mediaId', async (req, res) => {
  try {
    const comments = await client.getComments(req.params.mediaId);
    res.json({ success: true, data: comments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/comments/:commentId/reply', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'message required' });
    const result = await client.replyToComment(req.params.commentId, message);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
