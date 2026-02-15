/**
 * Tashkheesa Instagram Graph API Client
 * Handles API requests, rate limiting, token refresh, container polling.
 */

const config = require('./config');

class InstagramClient {
  constructor() {
    this.baseUrl = `${config.graphApiBaseUrl}/${config.graphApiVersion}`;
    this.accessToken = config.accessToken;
    this.igAccountId = config.igAccountId;
    this.requestCount = 0;
    this.requestWindowStart = Date.now();
  }

  async request(endpoint, method = 'GET', params = {}) {
    await this._checkRateLimit();

    const url = new URL(`${this.baseUrl}${endpoint}`);
    const fetchOptions = { method, headers: { 'Content-Type': 'application/json' } };

    if (method === 'GET') {
      Object.entries({ ...params, access_token: this.accessToken }).forEach(
        ([key, val]) => url.searchParams.append(key, val)
      );
    } else {
      const body = new URLSearchParams({ ...params, access_token: this.accessToken });
      fetchOptions.body = body.toString();
      fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    try {
      const response = await fetch(url.toString(), fetchOptions);
      const data = await response.json();
      this.requestCount++;

      if (data.error) {
        throw new InstagramApiError(data.error.message, data.error.code, data.error.type);
      }
      return data;
    } catch (err) {
      if (err instanceof InstagramApiError) throw err;
      throw new InstagramApiError(`Network error: ${err.message}`, 0, 'NetworkError');
    }
  }

  // Token Management
  async refreshLongLivedToken() {
    const data = await this.request('/oauth/access_token', 'GET', {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: this.accessToken,
    });
    this.accessToken = data.access_token;
    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
    };
  }

  async debugToken() {
    const data = await this.request('/debug_token', 'GET', {
      input_token: this.accessToken,
    });
    return data.data;
  }

  // Account Info
  async getAccountInfo() {
    return this.request(`/${this.igAccountId}`, 'GET', {
      fields: 'id,name,biography,followers_count,follows_count,media_count,profile_picture_url,website',
    });
  }

  // Container Management
  async createContainer(params) {
    return this.request(`/${this.igAccountId}/media`, 'POST', params);
  }

  async getContainerStatus(containerId) {
    return this.request(`/${containerId}`, 'GET', {
      fields: 'status_code,status',
    });
  }

  async waitForContainer(containerId) {
    const { containerPollInterval, containerPollTimeout } = config.limits;
    const startTime = Date.now();

    while (Date.now() - startTime < containerPollTimeout) {
      const status = await this.getContainerStatus(containerId);
      if (status.status_code === 'FINISHED') return status;
      if (status.status_code === 'ERROR') {
        throw new InstagramApiError(
          `Container ${containerId} failed: ${status.status || 'Unknown error'}`,
          0, 'ContainerError'
        );
      }
      await this._sleep(containerPollInterval);
    }

    throw new InstagramApiError(
      `Container ${containerId} timed out after ${containerPollTimeout / 1000}s`,
      0, 'ContainerTimeout'
    );
  }

  async publishContainer(containerId) {
    return this.request(`/${this.igAccountId}/media_publish`, 'POST', {
      creation_id: containerId,
    });
  }

  // Insights
  async getMediaInsights(mediaId) {
    return this.request(`/${mediaId}/insights`, 'GET', {
      metric: 'impressions,reach,engagement,saved,shares',
    });
  }

  async getAccountInsights(period = 'day', since = null, until = null) {
    const params = {
      metric: 'impressions,reach,profile_views,follower_count',
      period,
    };
    if (since) params.since = since;
    if (until) params.until = until;
    return this.request(`/${this.igAccountId}/insights`, 'GET', params);
  }

  // Comments
  async getComments(mediaId) {
    return this.request(`/${mediaId}/comments`, 'GET', {
      fields: 'id,text,username,timestamp',
    });
  }

  async replyToComment(commentId, message) {
    return this.request(`/${commentId}/replies`, 'POST', { message });
  }

  // Rate Limiting
  async _checkRateLimit() {
    const hourMs = 60 * 60 * 1000;
    const now = Date.now();
    if (now - this.requestWindowStart > hourMs) {
      this.requestCount = 0;
      this.requestWindowStart = now;
    }
    if (this.requestCount >= config.limits.rateLimitPerHour - 5) {
      const waitMs = hourMs - (now - this.requestWindowStart);
      console.warn(`[Instagram] Rate limit approaching. Waiting ${Math.round(waitMs / 1000)}s`);
      await this._sleep(waitMs);
      this.requestCount = 0;
      this.requestWindowStart = Date.now();
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

class InstagramApiError extends Error {
  constructor(message, code, type) {
    super(message);
    this.name = 'InstagramApiError';
    this.code = code;
    this.type = type;
  }
}

module.exports = { InstagramClient, InstagramApiError };
