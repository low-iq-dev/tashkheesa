/**
 * Tashkheesa Instagram Publisher
 * Handles publishing: single images, carousels, stories, reels, + scheduling.
 */

const { InstagramClient, InstagramApiError } = require('./client');
const config = require('./config');

class InstagramPublisher {
  constructor() {
    this.client = new InstagramClient();
  }

  // ── SINGLE IMAGE POST ──
  async publishImage({ imageUrl, caption, locationId, userTags, publishTime }) {
    this._validateCaption(caption);
    const params = {
      image_url: imageUrl,
      caption: this._formatCaption(caption),
    };
    if (locationId) params.location_id = locationId;
    if (userTags) params.user_tags = JSON.stringify(userTags);
    if (publishTime) {
      this._validatePublishTime(publishTime);
      params.published = 'false';
      params.publish_time = publishTime;
    }

    const container = await this.client.createContainer(params);
    console.log(`[IG Publisher] Image container created: ${container.id}`);
    await this.client.waitForContainer(container.id);

    if (publishTime) {
      return { id: container.id, scheduledFor: new Date(publishTime * 1000).toISOString(), type: 'IMAGE', status: 'SCHEDULED' };
    }
    const published = await this.client.publishContainer(container.id);
    console.log(`[IG Publisher] Image published: ${published.id}`);
    return { id: published.id, publishedAt: new Date().toISOString(), type: 'IMAGE', status: 'PUBLISHED' };
  }

  // ── CAROUSEL POST (2-10 images) ──
  async publishCarousel({ imageUrls, caption, publishTime }) {
    if (!imageUrls || imageUrls.length < config.limits.carouselMinItems) {
      throw new InstagramApiError(`Carousel requires at least ${config.limits.carouselMinItems} images`, 0, 'ValidationError');
    }
    if (imageUrls.length > config.limits.carouselMaxItems) {
      throw new InstagramApiError(`Carousel allows max ${config.limits.carouselMaxItems} images`, 0, 'ValidationError');
    }
    this._validateCaption(caption);

    // Create child containers
    const childIds = [];
    for (const [index, url] of imageUrls.entries()) {
      const child = await this.client.createContainer({ image_url: url, is_carousel_item: 'true' });
      console.log(`[IG Publisher] Carousel child ${index + 1}/${imageUrls.length}: ${child.id}`);
      childIds.push(child.id);
    }

    // Wait for all children
    for (const childId of childIds) {
      await this.client.waitForContainer(childId);
    }

    // Create carousel container
    const carouselParams = {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: this._formatCaption(caption),
    };
    if (publishTime) {
      this._validatePublishTime(publishTime);
      carouselParams.published = 'false';
      carouselParams.publish_time = publishTime;
    }

    const carousel = await this.client.createContainer(carouselParams);
    console.log(`[IG Publisher] Carousel container created: ${carousel.id}`);
    await this.client.waitForContainer(carousel.id);

    if (publishTime) {
      return { id: carousel.id, scheduledFor: new Date(publishTime * 1000).toISOString(), type: 'CAROUSEL', slideCount: imageUrls.length, status: 'SCHEDULED' };
    }
    const published = await this.client.publishContainer(carousel.id);
    console.log(`[IG Publisher] Carousel published: ${published.id}`);
    return { id: published.id, publishedAt: new Date().toISOString(), type: 'CAROUSEL', slideCount: imageUrls.length, status: 'PUBLISHED' };
  }

  // ── STORY (image or video) ──
  async publishStory({ mediaUrl, mediaType = 'IMAGE' }) {
    const params = { media_type: 'STORIES' };
    if (mediaType === 'VIDEO') { params.video_url = mediaUrl; } else { params.image_url = mediaUrl; }

    const container = await this.client.createContainer(params);
    console.log(`[IG Publisher] Story container created: ${container.id}`);
    await this.client.waitForContainer(container.id);

    const published = await this.client.publishContainer(container.id);
    console.log(`[IG Publisher] Story published: ${published.id}`);
    const now = new Date();
    return { id: published.id, publishedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86400000).toISOString(), type: 'STORY', status: 'PUBLISHED' };
  }

  // ── REEL (video) ──
  async publishReel({ videoUrl, caption, coverUrl, audioName, shareToFeed = true, publishTime }) {
    this._validateCaption(caption);
    const params = {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: this._formatCaption(caption),
      share_to_feed: shareToFeed ? 'true' : 'false',
    };
    if (coverUrl) params.cover_url = coverUrl;
    if (audioName) params.audio_name = audioName;
    if (publishTime) {
      this._validatePublishTime(publishTime);
      params.published = 'false';
      params.publish_time = publishTime;
    }

    const container = await this.client.createContainer(params);
    console.log(`[IG Publisher] Reel container created: ${container.id}`);
    await this.client.waitForContainer(container.id);

    if (publishTime) {
      return { id: container.id, scheduledFor: new Date(publishTime * 1000).toISOString(), type: 'REEL', status: 'SCHEDULED' };
    }
    const published = await this.client.publishContainer(container.id);
    console.log(`[IG Publisher] Reel published: ${published.id}`);
    return { id: published.id, publishedAt: new Date().toISOString(), type: 'REEL', status: 'PUBLISHED' };
  }

  // ── BULK SCHEDULING ──
  async bulkSchedule(posts) {
    const results = [];
    for (const [index, post] of posts.entries()) {
      try {
        console.log(`[IG Publisher] Scheduling ${index + 1}/${posts.length}: ${post.type}`);
        let result;
        switch (post.type) {
          case 'IMAGE': result = await this.publishImage(post); break;
          case 'CAROUSEL': result = await this.publishCarousel(post); break;
          case 'STORY': result = await this.publishStory(post); break;
          case 'REEL': result = await this.publishReel(post); break;
          default: throw new InstagramApiError(`Unknown post type: ${post.type}`, 0, 'ValidationError');
        }
        results.push({ success: true, index, ...result });
        await this.client._sleep(2000);
      } catch (err) {
        console.error(`[IG Publisher] Failed post ${index + 1}:`, err.message);
        results.push({ success: false, index, error: err.message, type: post.type });
      }
    }
    return results;
  }

  // ── HELPERS ──
  _validateCaption(caption) {
    if (caption && caption.length > config.limits.captionMaxLength) {
      throw new InstagramApiError(`Caption exceeds ${config.limits.captionMaxLength} characters`, 0, 'ValidationError');
    }
  }

  _validatePublishTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    if (timestamp < now + 600) throw new InstagramApiError('Scheduled time must be at least 10 minutes in the future', 0, 'ValidationError');
    if (timestamp > now + 2592000) throw new InstagramApiError('Scheduled time cannot be more than 30 days in the future', 0, 'ValidationError');
  }

  _formatCaption(caption) {
    if (!caption) return '';
    return caption.replace(/#/g, '%23');
  }
}

module.exports = { InstagramPublisher };
