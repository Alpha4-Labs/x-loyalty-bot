/**
 * Twitter Loyalty Router - Multi-Tenant Worker
 * 
 * Single worker that handles ALL brand Twitter integrations.
 * Extracts brand from subdomain, looks up encrypted credentials from KV,
 * decrypts, and processes Twitter polling.
 * 
 * Supports: mentions, replies, likes, and retweets.
 * 
 * Architecture:
 * - DNS: *.loyalteez.app → this worker (wildcard)
 * - Brand identification: {brand}.loyalteez.app → brand slug
 * - Credentials: Stored encrypted in KV, decrypted at runtime
 * - Isolation: Per-brand credentials, per-request execution
 * 
 * Routes handled:
 * - GET  /health           - Health check for specific brand
 * - GET  /config           - View brand configuration (redacted)
 * - POST /trigger          - Poll all engagement types
 * - POST /trigger/mentions - Poll mentions only
 * - POST /trigger/replies  - Poll replies only
 * - POST /trigger/likes    - Poll likes only (elevated API)
 * - POST /trigger/retweets - Poll retweets only (elevated API)
 * - POST /reset            - Reset all high water marks
 * - GET  /                 - Info page
 */

import nacl from 'tweetnacl';

// Event types supported by the bot
const EVENT_TYPES = {
  MENTION: 'tweet_mention',
  REPLY: 'tweet_reply',
  LIKE: 'tweet_like',
  RETWEET: 'tweet_retweet'
};

// ============================================
// ENCRYPTION UTILITIES
// ============================================

function decodeBase64(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bufferLength = str.length * 0.75;
  if (str[str.length - 1] === '=') bufferLength--;
  if (str[str.length - 2] === '=') bufferLength--;
  
  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  
  for (let i = 0; i < str.length; i += 4) {
    const encoded1 = chars.indexOf(str[i]);
    const encoded2 = chars.indexOf(str[i + 1]);
    const encoded3 = chars.indexOf(str[i + 2]);
    const encoded4 = chars.indexOf(str[i + 3]);
    
    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (encoded3 !== -1) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    if (encoded4 !== -1) bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
  }
  
  return bytes;
}

function encodeUTF8(arr) {
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(arr);
}

/**
 * Decrypt an encrypted credential
 * Format: "enc:v1:base64(ephemeralPubKey + nonce + ciphertext)"
 */
function decryptCredential(encrypted, privateKeyBase64) {
  if (!encrypted || !encrypted.startsWith('enc:')) {
    return encrypted; // Not encrypted, return as-is
  }

  try {
    const parts = encrypted.split(':');
    if (parts.length !== 3) throw new Error('Invalid format');
    
    const version = parts[1];
    const base64Data = parts[2];
    
    if (version !== 'v1') throw new Error(`Unsupported version: ${version}`);

    const combined = decodeBase64(base64Data);
    const ephemeralPublicKey = combined.slice(0, nacl.box.publicKeyLength);
    const nonce = combined.slice(nacl.box.publicKeyLength, nacl.box.publicKeyLength + nacl.box.nonceLength);
    const ciphertext = combined.slice(nacl.box.publicKeyLength + nacl.box.nonceLength);
    
    const privateKey = decodeBase64(privateKeyBase64);
    const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, privateKey);
    
    if (!decrypted) throw new Error('Decryption failed');
    
    return encodeUTF8(decrypted);
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error(`Failed to decrypt: ${error.message}`);
  }
}

// ============================================
// CORS HEADERS
// ============================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ============================================
// MAIN WORKER
// ============================================

// Map of reserved subdomains to their Cloudflare Pages project names
// These get proxied to their respective Pages deployments
const PAGES_PROXY_MAP = {
  'partner': 'partner-frontend',
  'partner-testnet': 'partner-frontend-testnet', 
  'perk-market': 'perk-market-frontend',
  'perk-market-testnet': 'perk-market-frontend-testnet',
  'admin': 'admin-portal',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const hostname = url.hostname;
    
    // Extract brand from subdomain
    const brandSlug = this.extractBrandSlug(hostname);
    
    // If it's a reserved subdomain, proxy to the appropriate Pages deployment
    if (!brandSlug) {
      const subdomain = hostname.split('.')[0];
      
      // Check if we should proxy to a Pages deployment
      const pagesProject = PAGES_PROXY_MAP[subdomain];
      if (pagesProject) {
        // Proxy to Cloudflare Pages - use the pages.dev domain
        const pagesUrl = new URL(request.url);
        pagesUrl.hostname = `${pagesProject}.pages.dev`;
        
        console.log(`🔀 Proxying ${subdomain}.loyalteez.app to ${pagesProject}.pages.dev`);
        
        // Forward the request to Pages
        const proxyResponse = await fetch(pagesUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
          redirect: 'manual', // Don't follow redirects, let the client handle them
        });
        
        // Return the proxied response with CORS headers
        const response = new Response(proxyResponse.body, {
          status: proxyResponse.status,
          statusText: proxyResponse.statusText,
          headers: proxyResponse.headers,
        });
        
        return response;
      }
      
      // Not a proxied subdomain - return router info
      return this.jsonResponse({
        service: 'twitter-loyalty-router',
        version: '2.0.0',
        description: 'Multi-tenant Twitter loyalty worker with full engagement support',
        usage: 'Access via {brand}.loyalteez.app',
        supported_events: Object.values(EVENT_TYPES),
        endpoints: {
          'GET /health': 'Health check',
          'GET /config': 'View configuration',
          'POST /trigger': 'Poll all engagement types',
          'POST /trigger/mentions': 'Poll mentions only',
          'POST /trigger/replies': 'Poll replies only',
          'POST /trigger/likes': 'Poll likes only (elevated API)',
          'POST /trigger/retweets': 'Poll retweets only (elevated API)',
          'POST /reset': 'Reset all high water marks',
        },
      });
    }

    try {
      // Load brand configuration from KV
      const brandConfig = await this.loadBrandConfig(env, brandSlug);
      
      if (!brandConfig) {
        return this.jsonError(`Brand '${brandSlug}' not configured`, 404);
      }

      // Route handling
      if (url.pathname === '/' || url.pathname === '/health') {
        return this.handleHealth(brandSlug, brandConfig, env);
      }
      
      if (url.pathname === '/config') {
        return this.handleConfig(brandSlug, brandConfig);
      }
      
      if (url.pathname === '/trigger' && request.method === 'POST') {
        return this.handleTriggerAll(brandSlug, brandConfig, env);
      }
      
      // Specific engagement type triggers
      if (url.pathname.startsWith('/trigger/') && request.method === 'POST') {
        const eventType = url.pathname.replace('/trigger/', '');
        const validTypes = ['mentions', 'replies', 'likes', 'retweets'];
        if (!validTypes.includes(eventType)) {
          return this.jsonError(`Invalid event type. Valid types: ${validTypes.join(', ')}`, 400);
        }
        return this.handleTriggerType(brandSlug, brandConfig, env, eventType);
      }
      
      if (url.pathname === '/reset' && request.method === 'POST') {
        return this.handleReset(brandSlug, brandConfig, env);
      }
      
      // Method not allowed for trigger endpoints
      if (url.pathname === '/trigger' || url.pathname.startsWith('/trigger/')) {
        return this.jsonError('Method not allowed', 405);
      }
      
      if (url.pathname === '/reset') {
        return this.jsonError('Method not allowed', 405);
      }
      
      return this.jsonError('Not found', 404);
    } catch (error) {
      console.error(`Error for brand ${brandSlug}:`, error);
      return this.jsonError(`Error: ${error.message}`, 500);
    }
  },

  /**
   * Scheduled handler - polls ALL configured brands for all engagement types
   */
  async scheduled(event, env, ctx) {
    console.log('⏰ Cron triggered - polling all brands for all engagement types...');
    
    try {
      const brandList = await env.TWITTER_ROUTER_KV.list({ prefix: 'brand:' });
      console.log(`📋 Found ${brandList.keys.length} configured brands`);
      
      const results = [];
      
      for (const key of brandList.keys) {
        const brandSlug = key.name.replace('brand:', '');
        
        try {
          const configData = await env.TWITTER_ROUTER_KV.get(key.name);
          if (!configData) continue;
          
          const brandConfig = JSON.parse(configData);
          
          if (!brandConfig.is_active) {
            console.log(`⏭️ Skipping inactive brand: ${brandSlug}`);
            continue;
          }
          
          console.log(`🔄 Polling all engagements for brand: ${brandSlug}`);
          const result = await this.pollAllEngagements(brandSlug, brandConfig, env);
          results.push({ brand: brandSlug, status: 'success', ...result });
          
        } catch (error) {
          console.error(`❌ Error polling ${brandSlug}:`, error);
          results.push({ brand: brandSlug, status: 'error', error: error.message });
        }
      }
      
      console.log(`✅ Cron complete. Processed ${results.length} brands.`);
      
    } catch (error) {
      console.error('❌ Cron error:', error);
    }
  },

  // ============================================
  // BRAND EXTRACTION
  // ============================================

  extractBrandSlug(hostname) {
    if (hostname.endsWith('.loyalteez.app')) {
      const parts = hostname.split('.');
      if (parts.length >= 3) {
        const slug = parts[0];
        // Reserved subdomains - these are NOT brand slugs
        // They have their own dedicated services/pages
        const RESERVED_SUBDOMAINS = [
          'api',              // Main API
          'www',              // Website
          'app',              // Main app
          'portal',           // Legacy portal
          'partner',          // Partner Portal
          'partner-testnet',  // Partner Portal testnet
          'perk-market',      // Perk Market
          'perk-market-testnet', // Perk Market testnet
          'x-demo',           // Twitter demo
          'x-deploy',         // Twitter deployment service
          'discord-bot',      // Old Discord bot
          'loyalteez-official-discord-bot', // New Discord bot
          'farcaster-bot',    // Farcaster bot
          'shopify',          // Shopify app
          'admin',            // Admin portal
          'docs',             // Documentation
          'status',           // Status page
        ];
        if (RESERVED_SUBDOMAINS.includes(slug)) {
          return null;
        }
        return slug;
      }
    }
    return null;
  },

  // ============================================
  // BRAND CONFIGURATION
  // ============================================

  async loadBrandConfig(env, brandSlug) {
    const kvKey = `brand:${brandSlug}`;
    const data = await env.TWITTER_ROUTER_KV.get(kvKey);
    
    if (!data) {
      return null;
    }
    
    return JSON.parse(data);
  },

  async saveBrandConfig(env, brandSlug, config) {
    const kvKey = `brand:${brandSlug}`;
    await env.TWITTER_ROUTER_KV.put(kvKey, JSON.stringify(config));
  },

  // ============================================
  // ENDPOINT HANDLERS
  // ============================================

  async handleHealth(brandSlug, brandConfig, env) {
    let hasValidToken = false;
    try {
      if (brandConfig.encrypted_bearer_token && env.ENCRYPTION_PRIVATE_KEY) {
        const token = decryptCredential(brandConfig.encrypted_bearer_token, env.ENCRYPTION_PRIVATE_KEY);
        hasValidToken = token && token.length > 0;
      }
    } catch (e) {
      hasValidToken = false;
    }

    return this.jsonResponse({
      status: hasValidToken ? 'ok' : 'degraded',
      brand: brandSlug,
      twitter_handle: brandConfig.twitter_handle || 'not configured',
      has_bearer_token: hasValidToken,
      is_active: brandConfig.is_active !== false,
      configured_at: brandConfig.configured_at,
      supported_events: Object.values(EVENT_TYPES),
      timestamp: new Date().toISOString(),
    });
  },

  handleConfig(brandSlug, brandConfig) {
    return this.jsonResponse({
      brand: brandSlug,
      twitter_handle: brandConfig.twitter_handle,
      brand_id: brandConfig.brand_id,
      is_active: brandConfig.is_active !== false,
      configured_at: brandConfig.configured_at,
      supported_events: Object.values(EVENT_TYPES),
      has_bearer_token: !!brandConfig.encrypted_bearer_token,
      has_api_key: !!brandConfig.encrypted_api_key,
      has_api_secret: !!brandConfig.encrypted_api_secret,
    });
  },

  async handleTriggerAll(brandSlug, brandConfig, env) {
    try {
      const result = await this.pollAllEngagements(brandSlug, brandConfig, env);
      return this.jsonResponse({ 
        success: true, 
        message: `All engagements polled for @${brandConfig.twitter_handle}`,
        ...result
      });
    } catch (error) {
      return this.jsonError(`Poll failed: ${error.message}`, 500);
    }
  },

  async handleTriggerType(brandSlug, brandConfig, env, type) {
    try {
      let result;
      switch (type) {
        case 'mentions':
          result = await this.pollTwitterMentions(brandSlug, brandConfig, env);
          break;
        case 'replies':
          result = await this.pollTwitterReplies(brandSlug, brandConfig, env);
          break;
        case 'likes':
          result = await this.pollTwitterLikes(brandSlug, brandConfig, env);
          break;
        case 'retweets':
          result = await this.pollTwitterRetweets(brandSlug, brandConfig, env);
          break;
        default:
          throw new Error(`Unknown type: ${type}`);
      }
      return this.jsonResponse({ 
        success: true, 
        message: `${type} polled for @${brandConfig.twitter_handle}`,
        ...result
      });
    } catch (error) {
      return this.jsonError(`Poll failed: ${error.message}`, 500);
    }
  },

  async handleReset(brandSlug, brandConfig, env) {
    const handle = brandConfig.twitter_handle?.toLowerCase() || brandSlug;
    await env.TWITTER_ROUTER_KV.delete(`highwater:mentions:${brandSlug}`);
    await env.TWITTER_ROUTER_KV.delete(`highwater:replies:${brandSlug}`);
    await env.TWITTER_ROUTER_KV.delete(`highwater:tweets:${brandSlug}`);
    return this.jsonResponse({ 
      success: true, 
      message: `All high water marks reset for ${brandSlug}` 
    });
  },

  // ============================================
  // POLL ALL ENGAGEMENTS
  // ============================================

  async pollAllEngagements(brandSlug, brandConfig, env) {
    const results = {
      mentions: { found: 0, rewarded: 0, errors: [] },
      replies: { found: 0, rewarded: 0, errors: [] },
      likes: { found: 0, rewarded: 0, errors: [] },
      retweets: { found: 0, rewarded: 0, errors: [] }
    };

    // Decrypt bearer token
    const bearerToken = await this.getDecryptedBearerToken(brandConfig, env);
    if (!bearerToken) {
      return { error: 'No valid bearer token', results };
    }

    const twitterHandle = brandConfig.twitter_handle;
    if (!twitterHandle) {
      return { error: 'No Twitter handle configured', results };
    }

    console.log(`🔄 Starting full engagement poll for @${twitterHandle} (brand: ${brandSlug})...`);

    // Poll mentions
    try {
      const mentionResult = await this.pollTwitterMentions(brandSlug, brandConfig, env, bearerToken);
      results.mentions = mentionResult;
    } catch (error) {
      console.error(`❌ Mentions poll failed:`, error.message);
      results.mentions.errors.push(error.message);
    }

    // Poll replies
    try {
      const replyResult = await this.pollTwitterReplies(brandSlug, brandConfig, env, bearerToken);
      results.replies = replyResult;
    } catch (error) {
      console.error(`❌ Replies poll failed:`, error.message);
      results.replies.errors.push(error.message);
    }

    // Poll likes (elevated API)
    try {
      const likeResult = await this.pollTwitterLikes(brandSlug, brandConfig, env, bearerToken);
      results.likes = likeResult;
    } catch (error) {
      console.error(`❌ Likes poll failed:`, error.message);
      results.likes.errors.push(error.message);
    }

    // Poll retweets (elevated API)
    try {
      const retweetResult = await this.pollTwitterRetweets(brandSlug, brandConfig, env, bearerToken);
      results.retweets = retweetResult;
    } catch (error) {
      console.error(`❌ Retweets poll failed:`, error.message);
      results.retweets.errors.push(error.message);
    }

    console.log(`✅ Full engagement poll complete for @${twitterHandle}`);
    return { results };
  },

  // ============================================
  // TWITTER POLLING - MENTIONS
  // ============================================

  async pollTwitterMentions(brandSlug, brandConfig, env, providedToken = null) {
    const result = { found: 0, rewarded: 0, failed: 0, errors: [] };

    const bearerToken = providedToken || await this.getDecryptedBearerToken(brandConfig, env);
    if (!bearerToken) {
      result.errors.push('No bearer token configured');
      return result;
    }

    const twitterHandle = brandConfig.twitter_handle;
    if (!twitterHandle) {
      result.errors.push('No Twitter handle configured');
      return result;
    }

    console.log(`🔎 Searching mentions for @${twitterHandle} (brand: ${brandSlug})`);

    // Get high water mark
    const highWaterKey = `highwater:mentions:${brandSlug}`;
    const lastTweetId = await env.TWITTER_ROUTER_KV.get(highWaterKey);

    // Build search query
    const query = encodeURIComponent(`@${twitterHandle} -is:retweet`);
    let url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=author_id,created_at,text`;
    
    if (lastTweetId) {
      url += `&since_id=${lastTweetId}`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error: ${response.status} - ${errorText}`);
      result.errors.push(`Twitter API error: ${response.status}`);
      return result;
    }

    const data = await response.json();
    let tweets = data.data || [];

    // Limit first run to 3 tweets
    if (!lastTweetId && tweets.length > 3) {
      tweets = tweets.slice(0, 3);
    }

    result.found = tweets.length;

    if (tweets.length === 0) {
      console.log(`📭 No new mentions for @${twitterHandle}`);
      return result;
    }

    console.log(`📬 Found ${tweets.length} new mentions for @${twitterHandle}`);

    let newestTweetId = lastTweetId;
    
    for (const tweet of tweets) {
      const processedKey = `processed:${brandSlug}:mention:${tweet.id}`;
      const alreadyProcessed = await env.TWITTER_ROUTER_KV.get(processedKey);
      
      if (alreadyProcessed) {
        continue;
      }

      const success = await this.sendRewardEvent(brandSlug, brandConfig, tweet, EVENT_TYPES.MENTION, env);
      
      if (success) {
        result.rewarded++;
      } else {
        result.failed++;
      }

      await env.TWITTER_ROUTER_KV.put(processedKey, 'true', { expirationTtl: 86400 * 30 });
      
      if (!newestTweetId || BigInt(tweet.id) > BigInt(newestTweetId)) {
        newestTweetId = tweet.id;
      }
    }

    if (newestTweetId) {
      await env.TWITTER_ROUTER_KV.put(highWaterKey, newestTweetId);
    }

    console.log(`✅ Mentions poll complete for @${twitterHandle}: found ${result.found}, rewarded ${result.rewarded}`);
    return result;
  },

  // ============================================
  // TWITTER POLLING - REPLIES
  // ============================================

  async pollTwitterReplies(brandSlug, brandConfig, env, providedToken = null) {
    const result = { found: 0, rewarded: 0, failed: 0, errors: [] };

    const bearerToken = providedToken || await this.getDecryptedBearerToken(brandConfig, env);
    if (!bearerToken) {
      result.errors.push('No bearer token configured');
      return result;
    }

    const twitterHandle = brandConfig.twitter_handle;
    if (!twitterHandle) {
      result.errors.push('No Twitter handle configured');
      return result;
    }

    console.log(`🔎 Searching replies to @${twitterHandle} (brand: ${brandSlug})`);

    // Get brand's user ID for filtering
    const userId = await this.getUserId(bearerToken, twitterHandle, env, brandSlug);
    if (!userId) {
      result.errors.push(`Could not find user ID for @${twitterHandle}`);
      return result;
    }

    // Get high water mark
    const highWaterKey = `highwater:replies:${brandSlug}`;
    const lastTweetId = await env.TWITTER_ROUTER_KV.get(highWaterKey);

    // Search for replies to the brand
    const query = encodeURIComponent(`to:${twitterHandle} is:reply -from:${twitterHandle}`);
    let url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=author_id,created_at,text,in_reply_to_user_id`;
    
    if (lastTweetId) {
      url += `&since_id=${lastTweetId}`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error: ${response.status} - ${errorText}`);
      result.errors.push(`Twitter API error: ${response.status}`);
      return result;
    }

    const data = await response.json();
    let tweets = (data.data || []).filter(t => t.in_reply_to_user_id === userId);

    // Limit first run to 3 tweets
    if (!lastTweetId && tweets.length > 3) {
      tweets = tweets.slice(0, 3);
    }

    result.found = tweets.length;

    if (tweets.length === 0) {
      console.log(`📭 No new replies for @${twitterHandle}`);
      return result;
    }

    console.log(`📬 Found ${tweets.length} new replies for @${twitterHandle}`);

    let newestTweetId = lastTweetId;
    
    for (const tweet of tweets) {
      const processedKey = `processed:${brandSlug}:reply:${tweet.id}`;
      const alreadyProcessed = await env.TWITTER_ROUTER_KV.get(processedKey);
      
      if (alreadyProcessed) {
        continue;
      }

      const success = await this.sendRewardEvent(brandSlug, brandConfig, tweet, EVENT_TYPES.REPLY, env);
      
      if (success) {
        result.rewarded++;
      } else {
        result.failed++;
      }

      await env.TWITTER_ROUTER_KV.put(processedKey, 'true', { expirationTtl: 86400 * 30 });
      
      if (!newestTweetId || BigInt(tweet.id) > BigInt(newestTweetId)) {
        newestTweetId = tweet.id;
      }
    }

    if (newestTweetId) {
      await env.TWITTER_ROUTER_KV.put(highWaterKey, newestTweetId);
    }

    console.log(`✅ Replies poll complete for @${twitterHandle}: found ${result.found}, rewarded ${result.rewarded}`);
    return result;
  },

  // ============================================
  // TWITTER POLLING - LIKES (Elevated API)
  // ============================================

  async pollTwitterLikes(brandSlug, brandConfig, env, providedToken = null) {
    const result = { found: 0, rewarded: 0, failed: 0, errors: [] };

    const bearerToken = providedToken || await this.getDecryptedBearerToken(brandConfig, env);
    if (!bearerToken) {
      result.errors.push('No bearer token configured');
      return result;
    }

    const twitterHandle = brandConfig.twitter_handle;
    if (!twitterHandle) {
      result.errors.push('No Twitter handle configured');
      return result;
    }

    console.log(`🔎 Searching likes on @${twitterHandle}'s tweets (brand: ${brandSlug})`);

    // Get brand's user ID
    const userId = await this.getUserId(bearerToken, twitterHandle, env, brandSlug);
    if (!userId) {
      result.errors.push(`Could not find user ID for @${twitterHandle}`);
      return result;
    }

    // Get brand's recent tweets
    const brandTweets = await this.getBrandRecentTweets(bearerToken, userId, env, brandSlug);
    if (!brandTweets || brandTweets.length === 0) {
      console.log("📭 No recent brand tweets to check for likes.");
      return result;
    }

    console.log(`📋 Checking likes on ${brandTweets.length} brand tweets...`);

    for (const tweet of brandTweets) {
      try {
        const likers = await this.getTweetLikers(bearerToken, tweet.id, env, brandSlug);
        if (!likers || likers.length === 0) continue;

        console.log(`❤️ Found ${likers.length} new likers on tweet ${tweet.id}`);

        for (const liker of likers) {
          result.found++;
          
          const likeEvent = {
            id: `like_${tweet.id}_${liker.id}`,
            author_id: liker.id,
            text: `Liked tweet: ${tweet.text?.substring(0, 50)}...`,
            liked_tweet_id: tweet.id
          };

          const processedKey = `processed:${brandSlug}:like:${likeEvent.id}`;
          const alreadyProcessed = await env.TWITTER_ROUTER_KV.get(processedKey);
          
          if (alreadyProcessed) continue;

          const success = await this.sendRewardEvent(brandSlug, brandConfig, likeEvent, EVENT_TYPES.LIKE, env);
          
          if (success) {
            result.rewarded++;
          } else {
            result.failed++;
          }

          await env.TWITTER_ROUTER_KV.put(processedKey, 'true', { expirationTtl: 86400 * 30 });
        }
      } catch (error) {
        if (error.message?.includes('403')) {
          result.errors.push("Likes tracking requires elevated Twitter API access (Pro tier or OAuth 2.0 User Context)");
          break;
        }
        console.error(`Error checking likes for tweet ${tweet.id}:`, error.message);
      }
    }

    console.log(`✅ Likes poll complete for @${twitterHandle}: found ${result.found}, rewarded ${result.rewarded}`);
    return result;
  },

  // ============================================
  // TWITTER POLLING - RETWEETS (Elevated API)
  // ============================================

  async pollTwitterRetweets(brandSlug, brandConfig, env, providedToken = null) {
    const result = { found: 0, rewarded: 0, failed: 0, errors: [] };

    const bearerToken = providedToken || await this.getDecryptedBearerToken(brandConfig, env);
    if (!bearerToken) {
      result.errors.push('No bearer token configured');
      return result;
    }

    const twitterHandle = brandConfig.twitter_handle;
    if (!twitterHandle) {
      result.errors.push('No Twitter handle configured');
      return result;
    }

    console.log(`🔎 Searching retweets of @${twitterHandle}'s tweets (brand: ${brandSlug})`);

    // Get brand's user ID
    const userId = await this.getUserId(bearerToken, twitterHandle, env, brandSlug);
    if (!userId) {
      result.errors.push(`Could not find user ID for @${twitterHandle}`);
      return result;
    }

    // Get brand's recent tweets
    const brandTweets = await this.getBrandRecentTweets(bearerToken, userId, env, brandSlug);
    if (!brandTweets || brandTweets.length === 0) {
      console.log("📭 No recent brand tweets to check for retweets.");
      return result;
    }

    console.log(`📋 Checking retweets on ${brandTweets.length} brand tweets...`);

    for (const tweet of brandTweets) {
      try {
        const retweeters = await this.getTweetRetweeters(bearerToken, tweet.id, env, brandSlug);
        if (!retweeters || retweeters.length === 0) continue;

        console.log(`🔁 Found ${retweeters.length} new retweeters on tweet ${tweet.id}`);

        for (const retweeter of retweeters) {
          result.found++;
          
          const retweetEvent = {
            id: `retweet_${tweet.id}_${retweeter.id}`,
            author_id: retweeter.id,
            text: `Retweeted: ${tweet.text?.substring(0, 50)}...`,
            retweeted_tweet_id: tweet.id
          };

          const processedKey = `processed:${brandSlug}:retweet:${retweetEvent.id}`;
          const alreadyProcessed = await env.TWITTER_ROUTER_KV.get(processedKey);
          
          if (alreadyProcessed) continue;

          const success = await this.sendRewardEvent(brandSlug, brandConfig, retweetEvent, EVENT_TYPES.RETWEET, env);
          
          if (success) {
            result.rewarded++;
          } else {
            result.failed++;
          }

          await env.TWITTER_ROUTER_KV.put(processedKey, 'true', { expirationTtl: 86400 * 30 });
        }
      } catch (error) {
        if (error.message?.includes('403')) {
          result.errors.push("Retweet tracking requires elevated Twitter API access (Pro tier or OAuth 2.0 User Context)");
          break;
        }
        console.error(`Error checking retweets for tweet ${tweet.id}:`, error.message);
      }
    }

    console.log(`✅ Retweets poll complete for @${twitterHandle}: found ${result.found}, rewarded ${result.rewarded}`);
    return result;
  },

  // ============================================
  // TWITTER API HELPERS
  // ============================================

  async getDecryptedBearerToken(brandConfig, env) {
    if (!brandConfig.encrypted_bearer_token) {
      return null;
    }
    
    if (!env.ENCRYPTION_PRIVATE_KEY) {
      return null;
    }
    
    try {
      return decryptCredential(brandConfig.encrypted_bearer_token, env.ENCRYPTION_PRIVATE_KEY);
    } catch (error) {
      console.error('Failed to decrypt bearer token:', error.message);
      return null;
    }
  },

  async getUserId(bearerToken, handle, env, brandSlug) {
    const cacheKey = `user_id:${brandSlug}:${handle.toLowerCase()}`;
    const cachedId = await env.TWITTER_ROUTER_KV.get(cacheKey);
    if (cachedId) {
      return cachedId;
    }

    const response = await fetch(
      `https://api.twitter.com/2/users/by/username/${handle}`,
      {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error (getUserId): ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    if (!data.data || !data.data.id) {
      return null;
    }

    await env.TWITTER_ROUTER_KV.put(cacheKey, data.data.id, { expirationTtl: 86400 });
    return data.data.id;
  },

  async getBrandRecentTweets(bearerToken, userId, env, brandSlug) {
    const url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text&exclude=retweets,replies`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error (getBrandRecentTweets): ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    return data.data || [];
  },

  async getTweetLikers(bearerToken, tweetId, env, brandSlug) {
    const cacheKey = `likers_checked:${brandSlug}:${tweetId}`;
    const lastCheckedLikers = await env.TWITTER_ROUTER_KV.get(cacheKey);
    const previousLikerIds = lastCheckedLikers ? JSON.parse(lastCheckedLikers) : [];

    const url = `https://api.twitter.com/2/tweets/${tweetId}/liking_users?max_results=100`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('403 - Elevated API access required for likes');
      }
      const errorText = await response.text();
      console.error(`❌ Twitter API error (getTweetLikers): ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    const allLikers = data.data || [];

    const newLikers = allLikers.filter(liker => !previousLikerIds.includes(liker.id));

    const allLikerIds = allLikers.map(l => l.id);
    await env.TWITTER_ROUTER_KV.put(cacheKey, JSON.stringify(allLikerIds), { expirationTtl: 86400 * 7 });

    return newLikers;
  },

  async getTweetRetweeters(bearerToken, tweetId, env, brandSlug) {
    const cacheKey = `retweeters_checked:${brandSlug}:${tweetId}`;
    const lastCheckedRetweeters = await env.TWITTER_ROUTER_KV.get(cacheKey);
    const previousRetweeterIds = lastCheckedRetweeters ? JSON.parse(lastCheckedRetweeters) : [];

    const url = `https://api.twitter.com/2/tweets/${tweetId}/retweeted_by?max_results=100`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('403 - Elevated API access required for retweets');
      }
      const errorText = await response.text();
      console.error(`❌ Twitter API error (getTweetRetweeters): ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    const allRetweeters = data.data || [];

    const newRetweeters = allRetweeters.filter(rt => !previousRetweeterIds.includes(rt.id));

    const allRetweeterIds = allRetweeters.map(r => r.id);
    await env.TWITTER_ROUTER_KV.put(cacheKey, JSON.stringify(allRetweeterIds), { expirationTtl: 86400 * 7 });

    return newRetweeters;
  },

  // ============================================
  // REWARD EVENT
  // ============================================

  async sendRewardEvent(brandSlug, brandConfig, tweet, eventType, env) {
    const brandId = brandConfig.brand_id;
    const userEmail = `twitter_${tweet.author_id}@loyalteez.app`;
    
    const payload = {
      brandId: brandId,
      eventType: eventType,
      userEmail: userEmail,
      twitterHandle: brandConfig.twitter_handle,
      metadata: {
        platform: 'twitter',
        twitter_user_id: tweet.author_id,
        tweet_id: tweet.id,
        original_tweet_id: tweet.liked_tweet_id || tweet.retweeted_tweet_id || null,
        tweet_text: tweet.text?.substring(0, 200),
        timestamp: new Date().toISOString()
      }
    };

    console.log(`📤 Sending ${eventType} reward event for tweet ${tweet.id}`);

    // Try Service Binding first
    if (env.EVENT_HANDLER) {
      try {
        const serviceBindingUrl = 'https://api.loyalteez.app/loyalteez-api/manual-event';
        const request = new Request(serviceBindingUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const response = await env.EVENT_HANDLER.fetch(request);
        const responseText = await response.text();
        
        let data;
        try {
          data = JSON.parse(responseText);
        } catch (e) {
          throw new Error(`Service binding returned invalid JSON: ${response.status}`);
        }

        if (!response.ok) {
          throw new Error(data.error || `API returned ${response.status}`);
        }

        console.log(`✅ ${eventType} reward event sent via Service Binding for user ${tweet.author_id}`);
        return true;
      } catch (error) {
        console.error('Service Binding failed, falling back to HTTP:', error.message);
      }
    }

    // Fallback to HTTP
    try {
      const apiUrl = env.LOYALTEEZ_API_URL || 'https://api.loyalteez.app';
      const response = await fetch(`${apiUrl}/loyalteez-api/manual-event`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Loyalteez-Twitter-Router/2.0'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ API error (HTTP): ${response.status} - ${errorText}`);
        return false;
      }

      console.log(`✅ ${eventType} reward event sent via HTTP for user ${tweet.author_id}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send ${eventType} reward event:`, error);
      return false;
    }
  },

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      },
    });
  },

  jsonError(message, status = 400) {
    return this.jsonResponse({ success: false, error: message }, status);
  },
};
