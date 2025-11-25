/**
 * Twitter Loyalty Router - Multi-Tenant Worker
 * 
 * Single worker that handles ALL brand Twitter integrations.
 * Extracts brand from subdomain, looks up encrypted credentials from KV,
 * decrypts, and processes Twitter polling.
 * 
 * Architecture:
 * - DNS: *.loyalteez.app → this worker (wildcard)
 * - Brand identification: {brand}.loyalteez.app → brand slug
 * - Credentials: Stored encrypted in KV, decrypted at runtime
 * - Isolation: Per-brand credentials, per-request execution
 * 
 * Routes handled:
 * - GET  /health     - Health check for specific brand
 * - GET  /config     - View brand configuration (redacted)
 * - POST /trigger    - Manual poll trigger
 * - POST /reset      - Reset high water mark
 * - GET  /           - Info page
 */

import nacl from 'tweetnacl';

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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const hostname = url.hostname;
    
    // Extract brand from subdomain
    // e.g., "acme.loyalteez.app" → "acme"
    const brandSlug = this.extractBrandSlug(hostname);
    
    if (!brandSlug) {
      return this.jsonResponse({
        service: 'twitter-loyalty-router',
        version: '1.0.0',
        description: 'Multi-tenant Twitter loyalty worker',
        usage: 'Access via {brand}.loyalteez.app',
        endpoints: {
          'GET /health': 'Health check',
          'GET /config': 'View configuration',
          'POST /trigger': 'Manual poll trigger',
          'POST /reset': 'Reset high water mark',
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
      switch (url.pathname) {
        case '/':
        case '/health':
          return this.handleHealth(brandSlug, brandConfig, env);
        
        case '/config':
          return this.handleConfig(brandSlug, brandConfig);
        
        case '/trigger':
          if (request.method !== 'POST') {
            return this.jsonError('Method not allowed', 405);
          }
          return this.handleTrigger(brandSlug, brandConfig, env);
        
        case '/reset':
          if (request.method !== 'POST') {
            return this.jsonError('Method not allowed', 405);
          }
          return this.handleReset(brandSlug, brandConfig, env);
        
        default:
          return this.jsonError('Not found', 404);
      }
    } catch (error) {
      console.error(`Error for brand ${brandSlug}:`, error);
      return this.jsonError(`Error: ${error.message}`, 500);
    }
  },

  /**
   * Scheduled handler - polls ALL configured brands
   */
  async scheduled(event, env, ctx) {
    console.log('⏰ Cron triggered - polling all brands...');
    
    try {
      // List all brand configurations from KV
      const brandList = await env.TWITTER_ROUTER_KV.list({ prefix: 'brand:' });
      
      console.log(`📋 Found ${brandList.keys.length} configured brands`);
      
      const results = [];
      
      for (const key of brandList.keys) {
        const brandSlug = key.name.replace('brand:', '');
        
        try {
          const configData = await env.TWITTER_ROUTER_KV.get(key.name);
          if (!configData) continue;
          
          const brandConfig = JSON.parse(configData);
          
          // Skip if not active
          if (!brandConfig.is_active) {
            console.log(`⏭️ Skipping inactive brand: ${brandSlug}`);
            continue;
          }
          
          console.log(`🔄 Polling for brand: ${brandSlug}`);
          await this.pollTwitterMentions(brandSlug, brandConfig, env);
          results.push({ brand: brandSlug, status: 'success' });
          
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
    // Expected format: {brand}.loyalteez.app
    // Also handle: {brand}.loyalteez.app, localhost, workers.dev
    
    if (hostname.endsWith('.loyalteez.app')) {
      const parts = hostname.split('.');
      if (parts.length >= 3) {
        const slug = parts[0];
        // Skip known non-brand subdomains
        if (['api', 'www', 'app', 'portal', 'x-demo'].includes(slug)) {
          return null;
        }
        return slug;
      }
    }
    
    // For workers.dev, use query param
    // e.g., twitter-loyalty-router.xxx.workers.dev?brand=acme
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
    // Decrypt bearer token to verify it's valid
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
      // Redact sensitive fields
      has_bearer_token: !!brandConfig.encrypted_bearer_token,
      has_api_key: !!brandConfig.encrypted_api_key,
      has_api_secret: !!brandConfig.encrypted_api_secret,
    });
  },

  async handleTrigger(brandSlug, brandConfig, env) {
    try {
      await this.pollTwitterMentions(brandSlug, brandConfig, env);
      return this.jsonResponse({ 
        success: true, 
        message: `Poll triggered for @${brandConfig.twitter_handle}` 
      });
    } catch (error) {
      return this.jsonError(`Poll failed: ${error.message}`, 500);
    }
  },

  async handleReset(brandSlug, brandConfig, env) {
    const highWaterKey = `highwater:${brandSlug}`;
    await env.TWITTER_ROUTER_KV.delete(highWaterKey);
    return this.jsonResponse({ 
      success: true, 
      message: `High water mark reset for ${brandSlug}` 
    });
  },

  // ============================================
  // TWITTER POLLING
  // ============================================

  async pollTwitterMentions(brandSlug, brandConfig, env) {
    // Decrypt bearer token
    if (!brandConfig.encrypted_bearer_token) {
      throw new Error('No bearer token configured');
    }
    
    if (!env.ENCRYPTION_PRIVATE_KEY) {
      throw new Error('Encryption key not configured');
    }
    
    const bearerToken = decryptCredential(
      brandConfig.encrypted_bearer_token, 
      env.ENCRYPTION_PRIVATE_KEY
    );
    
    const twitterHandle = brandConfig.twitter_handle;
    if (!twitterHandle) {
      throw new Error('No Twitter handle configured');
    }

    console.log(`🔎 Searching mentions for @${twitterHandle} (brand: ${brandSlug})`);

    // Get high water mark (last processed tweet ID)
    const highWaterKey = `highwater:${brandSlug}`;
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
      throw new Error(`Twitter API error: ${response.status}`);
    }

    const data = await response.json();
    const tweets = data.data || [];

    if (tweets.length === 0) {
      console.log(`📭 No new mentions for @${twitterHandle}`);
      return;
    }

    console.log(`📬 Found ${tweets.length} new mentions for @${twitterHandle}`);

    // Process each mention (limit to 3 per poll to avoid rate limits)
    let newestTweetId = lastTweetId;
    
    for (const tweet of tweets.slice(0, 3)) {
      // Check if already processed
      const processedKey = `processed:${brandSlug}:${tweet.id}`;
      const alreadyProcessed = await env.TWITTER_ROUTER_KV.get(processedKey);
      
      if (alreadyProcessed) {
        console.log(`⏭️ Tweet ${tweet.id} already processed`);
        continue;
      }

      // Send reward event
      await this.sendRewardEvent(brandSlug, brandConfig, tweet, env);
      
      // Mark as processed
      await env.TWITTER_ROUTER_KV.put(processedKey, 'true', { expirationTtl: 86400 * 7 });
      
      // Update high water mark
      if (!newestTweetId || BigInt(tweet.id) > BigInt(newestTweetId)) {
        newestTweetId = tweet.id;
      }
    }

    // Save high water mark
    if (newestTweetId) {
      await env.TWITTER_ROUTER_KV.put(highWaterKey, newestTweetId);
    }

    console.log(`✅ Poll complete for @${twitterHandle}`);
  },

  async sendRewardEvent(brandSlug, brandConfig, tweet, env) {
    const brandId = brandConfig.brand_id;
    const userEmail = `twitter_${tweet.author_id}@loyalteez.app`;
    
    const payload = {
      brandId: brandId,
      eventType: 'tweet_mention',
      userEmail: userEmail,
      domain: `${brandSlug}.loyalteez.app`,
      metadata: {
        platform: 'twitter',
        twitter_user_id: tweet.author_id,
        tweet_id: tweet.id,
        tweet_text: tweet.text?.substring(0, 200),
        timestamp: new Date().toISOString()
      }
    };

    console.log(`📤 Sending reward event for tweet ${tweet.id}`);

    try {
      const apiUrl = env.LOYALTEEZ_API_URL || 'https://api.loyalteez.app';
      const response = await fetch(`${apiUrl}/loyalteez-api/manual-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ API error: ${response.status} - ${errorText}`);
        return false;
      }

      console.log(`✅ Reward event sent for user ${tweet.author_id}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send reward event:`, error);
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

