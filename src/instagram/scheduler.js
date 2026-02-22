/**
 * Tashkheesa Instagram Scheduler
 * Cron-based: reads due posts from PostgreSQL DB and publishes them.
 * Also handles token refresh.
 */

const config = require('./config');
const { InstagramPublisher } = require('./publisher');
const { InstagramClient } = require('./client');
const { queryAll, execute } = require('../pg');

class InstagramScheduler {
  constructor() {
    this.publisher = new InstagramPublisher();
    this.client = new InstagramClient();
    this.intervalId = null;
  }

  /**
   * Start the scheduler — call once on server boot.
   * Checks every 5 minutes for due posts.
   */
  start() {
    if (!process.env.IG_ACCESS_TOKEN) {
      console.log('[IG Scheduler] No IG_ACCESS_TOKEN set, skipping Instagram scheduler.');
      return;
    }

    console.log('[IG Scheduler] Starting — checking for posts every 5 minutes.');

    // Run immediately on start, then every 5 min
    this.publishDuePosts().catch(err => console.error('[IG Scheduler] Initial run error:', err.message));

    this.intervalId = setInterval(async () => {
      try {
        await this.publishDuePosts();
      } catch (err) {
        console.error('[IG Scheduler] Error:', err.message);
      }
    }, 5 * 60 * 1000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[IG Scheduler] Stopped.');
    }
  }

  /**
   * Query DB for posts that are due and publish them.
   */
  async publishDuePosts() {
    const now = new Date().toISOString();

    const duePosts = await queryAll(
      `SELECT * FROM ig_scheduled_posts
       WHERE status = 'approved' AND scheduled_at <= $1
       ORDER BY scheduled_at ASC LIMIT 5`,
      [now]
    );

    if (duePosts.length === 0) return;

    console.log(`[IG Scheduler] Found ${duePosts.length} posts to publish`);

    for (const post of duePosts) {
      try {
        // Mark as publishing
        await execute(
          `UPDATE ig_scheduled_posts SET status = 'publishing', updated_at = $1 WHERE id = $2`,
          [new Date().toISOString(), post.id]
        );

        let result;
        const imageUrls = JSON.parse(post.image_urls || '[]');

        switch (post.post_type) {
          case 'IMAGE':
            result = await this.publisher.publishImage({ imageUrl: imageUrls[0], caption: post.caption });
            break;
          case 'CAROUSEL':
            result = await this.publisher.publishCarousel({ imageUrls, caption: post.caption });
            break;
          case 'STORY':
            result = await this.publisher.publishStory({ mediaUrl: imageUrls[0], mediaType: post.media_subtype || 'IMAGE' });
            break;
          case 'REEL':
            result = await this.publisher.publishReel({ videoUrl: imageUrls[0], caption: post.caption });
            break;
          default:
            throw new Error(`Unknown post type: ${post.post_type}`);
        }

        // Mark as published
        await execute(
          `UPDATE ig_scheduled_posts SET status = 'published', ig_media_id = $1, published_at = $2, updated_at = $3 WHERE id = $4`,
          [result.id, new Date().toISOString(), new Date().toISOString(), post.id]
        );

        console.log(`[IG Scheduler] Published post #${post.id}: ${result.id}`);

      } catch (err) {
        console.error(`[IG Scheduler] Failed post #${post.id}:`, err.message);
        await execute(
          `UPDATE ig_scheduled_posts SET status = 'failed', error_message = $1, updated_at = $2 WHERE id = $3`,
          [err.message, new Date().toISOString(), post.id]
        );
      }

      // Pause between posts
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  /**
   * Refresh the long-lived access token.
   */
  async refreshToken() {
    console.log('[IG Scheduler] Refreshing access token...');
    const result = await this.client.refreshLongLivedToken();
    // Note: In production, you'd store the new token in DB/env.
    // For Render, you'll need to update the env var manually or via Render API.
    console.log(`[IG Scheduler] Token refreshed. Expires in ${Math.round(result.expiresIn / 86400)} days.`);
    return result;
  }
}

module.exports = { InstagramScheduler };
