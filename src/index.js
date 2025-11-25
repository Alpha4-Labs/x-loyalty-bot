/**
 * Twitter/X Loyalty Bot - Cloudflare Worker
 * 
 * Polls Twitter API for brand mentions and rewards users with LTZ tokens.
 * Reads configuration from Supabase (Partner Portal) for single source of truth.
 */

export default {
  // HTTP Handler for manual triggers or health checks
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Health check endpoint
    if (url.pathname === '/health') {
      const config = await this.getBrandConfig(env);
      return new Response(JSON.stringify({ 
        status: 'ok',
        service: 'twitter-loyalty-bot',
        brand_id: env.BRAND_ID,
        twitter_handle: config?.twitterHandle || 'not configured',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Manual trigger endpoint (for testing)
    if (url.pathname === '/trigger' && request.method === 'POST') {
      try {
        await this.pollTwitterMentions(env);
        return new Response(JSON.stringify({ success: true, message: 'Poll triggered' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Reset high water mark (for testing)
    if (url.pathname === '/reset' && request.method === 'POST') {
      try {
        const config = await this.getBrandConfig(env);
        if (config?.twitterHandle) {
          const highWaterKey = `high_water:${config.twitterHandle.toLowerCase()}`;
          await env.TWITTER_BOT_KV.delete(highWaterKey);
          return new Response(JSON.stringify({ 
            success: true, 
            message: `High water mark reset for @${config.twitterHandle}. Next poll will be treated as first run.` 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ success: false, error: 'No Twitter handle configured' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Config check endpoint
    if (url.pathname === '/config') {
      const config = await this.getBrandConfig(env);
      const supabaseKey = env.SUPABASE_PUBLISH_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_SECRET_KEY;
      return new Response(JSON.stringify({ 
        brand_id: env.BRAND_ID,
        brand_id_lowercase: env.BRAND_ID?.toLowerCase(),
        config: config || 'not found',
        has_bearer_token: !!env.TWITTER_BEARER_TOKEN,
        has_supabase_url: !!env.SUPABASE_URL,
        has_vite_supabase_secret_key: !!env.VITE_SUPABASE_SECRET_KEY,
        has_supabase_publish_key: !!env.SUPABASE_PUBLISH_KEY,
        supabase_key_available: !!supabaseKey,
        supabase_url: env.SUPABASE_URL || 'NOT SET'
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response("🐦 Twitter Loyalty Bot Active\n\nEndpoints:\n- GET /health - Health check\n- GET /config - View configuration\n- POST /trigger - Manual poll trigger\n- POST /reset - Reset high water mark (for testing)", { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // Scheduled Handler for Polling (cron trigger)
  async scheduled(event, env, ctx) {
    console.log("⏰ Cron triggered - Running Twitter Poll...");
    await this.pollTwitterMentions(env);
  },

  // Fetch brand configuration from Supabase
  async getBrandConfig(env) {
    // Support multiple key naming conventions
    const supabaseKey = env.SUPABASE_PUBLISH_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_SECRET_KEY;
    
    if (!env.SUPABASE_URL || !supabaseKey) {
      console.log("⚠️ Supabase credentials not configured");
      console.log("   SUPABASE_URL:", env.SUPABASE_URL ? "✅" : "❌");
      console.log("   SUPABASE_PUBLISH_KEY:", env.SUPABASE_PUBLISH_KEY ? "✅" : "❌");
      console.log("   VITE_SUPABASE_SECRET_KEY:", env.VITE_SUPABASE_SECRET_KEY ? "✅" : "❌");
      return null;
    }

    if (!env.BRAND_ID || env.BRAND_ID === '0x_configure_in_dashboard') {
      console.log("⚠️ BRAND_ID not configured");
      return null;
    }

    try {
      const brandId = env.BRAND_ID.toLowerCase();
      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/brand_automation_configs?brand_id=eq.${brandId}&select=config_metadata`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Supabase error: ${response.status} - ${errorText}`);
        return null;
      }

      const data = await response.json();
      if (!data || data.length === 0) {
        console.log(`⚠️ No config found for brand ${brandId}`);
        return null;
      }

      const configMetadata = data[0].config_metadata;
      const twitterHandle = configMetadata?.auth_methods?.twitter;

      console.log(`📋 Loaded config for ${brandId}: Twitter handle = ${twitterHandle || 'not set'}`);

      return {
        twitterHandle,
        configMetadata
      };
    } catch (error) {
      console.error(`❌ Error fetching brand config:`, error.message || error);
      return null;
    }
  },

  // Main polling logic
  async pollTwitterMentions(env) {
    try {
      // Check if Bearer Token is configured
      if (!env.TWITTER_BEARER_TOKEN) {
        console.log("⚠️ TWITTER_BEARER_TOKEN not configured. Skipping poll.");
        return;
      }

      // Fetch Twitter handle from Supabase (Partner Portal config)
      const config = await this.getBrandConfig(env);
      if (!config || !config.twitterHandle) {
        console.log("⚠️ Twitter handle not configured in Partner Portal. Skipping poll.");
        console.log("   → Go to Partner Portal → Settings → Profile → X (Twitter) to set your handle.");
        return;
      }

      const handle = config.twitterHandle;
      console.log(`🔎 Searching mentions for @${handle}...`);

      // Step 1: Get User ID for the handle
      const userId = await this.getUserId(env, handle);
      if (!userId) {
        console.error(`❌ Could not find user ID for @${handle}`);
        return;
      }
      console.log(`✅ Found user ID: ${userId}`);

      // Step 2: Search for recent mentions (with high water mark)
      const { tweets, isFirstRun, newestId } = await this.searchMentions(env, handle);
      
      if (!tweets || tweets.length === 0) {
        console.log("📭 No new mentions found.");
        // Still update high water mark if we got a newestId from API meta
        if (newestId) {
          await this.updateHighWaterMark(env, handle, newestId);
        }
        return;
      }

      if (isFirstRun) {
        console.log(`🆕 First run: Processing ${tweets.length} most recent tweets (limited to 3)`);
      } else {
        console.log(`📬 Found ${tweets.length} NEW mentions to process.`);
      }

      // Step 3: Process each mention
      let processedCount = 0;
      for (const tweet of tweets) {
        const processed = await this.processTweet(env, tweet, 'tweet_mention');
        if (processed) processedCount++;
      }

      // Step 4: Update high water mark AFTER successful processing
      if (newestId) {
        await this.updateHighWaterMark(env, handle, newestId);
      }

      console.log(`✅ Poll complete. Processed ${processedCount}/${tweets.length} tweets.`);

    } catch (error) {
      console.error("❌ Error in poll:", error.message || error);
    }
  },

  // Get Twitter User ID from handle
  async getUserId(env, handle) {
    // Check cache first
    const cacheKey = `user_id:${handle.toLowerCase()}`;
    const cachedId = await env.TWITTER_BOT_KV.get(cacheKey);
    if (cachedId) {
      console.log(`📦 Using cached user ID for @${handle}`);
      return cachedId;
    }

    // Fetch from Twitter API
    const response = await fetch(
      `https://api.twitter.com/2/users/by/username/${handle}`,
      {
        headers: {
          'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
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
      console.error(`❌ User @${handle} not found in response`);
      return null;
    }

    // Cache the user ID for 24 hours
    await env.TWITTER_BOT_KV.put(cacheKey, data.data.id, { expirationTtl: 86400 });
    
    return data.data.id;
  },

  // Search for recent mentions (with high water mark to avoid re-processing)
  async searchMentions(env, handle) {
    // Get the high water mark (last processed tweet ID)
    const highWaterKey = `high_water:${handle.toLowerCase()}`;
    const sinceId = await env.TWITTER_BOT_KV.get(highWaterKey);
    
    // Twitter API v2 search endpoint
    // Note: Basic tier allows recent search (last 7 days)
    const query = encodeURIComponent(`@${handle} -is:retweet`);
    let url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=author_id,created_at,text&expansions=author_id`;
    
    // Only fetch tweets NEWER than our last processed tweet
    if (sinceId) {
      url += `&since_id=${sinceId}`;
      console.log(`📍 Using high water mark: since_id=${sinceId}`);
    } else {
      console.log(`🆕 First run - will only process most recent 3 tweets and set high water mark`);
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    // Log rate limit headers for debugging
    const rateLimit = response.headers.get('x-rate-limit-limit');
    const rateRemaining = response.headers.get('x-rate-limit-remaining');
    const rateReset = response.headers.get('x-rate-limit-reset');
    if (rateRemaining !== null) {
      const resetDate = rateReset ? new Date(parseInt(rateReset) * 1000).toISOString() : 'unknown';
      console.log(`📊 Rate limit: ${rateRemaining}/${rateLimit} remaining, resets at ${resetDate}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error (searchMentions): ${response.status} - ${errorText}`);
      // If rate limited, log when it resets
      if (response.status === 429 && rateReset) {
        const resetTime = new Date(parseInt(rateReset) * 1000);
        console.log(`⏰ Rate limit resets at: ${resetTime.toISOString()} (in ${Math.ceil((resetTime - new Date()) / 60000)} minutes)`);
      }
      return { tweets: [], isFirstRun: !sinceId, newestId: null };
    }

    const data = await response.json();
    const tweets = data.data || [];
    
    // Get the newest tweet ID to update high water mark
    const newestId = data.meta?.newest_id || (tweets.length > 0 ? tweets[0].id : null);
    
    return { 
      tweets: !sinceId && tweets.length > 3 ? tweets.slice(0, 3) : tweets, // Limit first run to 3 tweets
      isFirstRun: !sinceId, 
      newestId 
    };
  },

  // Update the high water mark after successful processing
  async updateHighWaterMark(env, handle, newestId) {
    if (!newestId) return;
    const highWaterKey = `high_water:${handle.toLowerCase()}`;
    await env.TWITTER_BOT_KV.put(highWaterKey, newestId);
    console.log(`📍 Updated high water mark to: ${newestId}`);
  },

  // Process a single tweet - returns true if processed, false if skipped
  async processTweet(env, tweet, eventType) {
    const tweetId = tweet.id;
    const authorId = tweet.author_id;

    // Check if already processed (belt-and-suspenders with high water mark)
    const processedKey = `processed:${tweetId}`;
    const isProcessed = await env.TWITTER_BOT_KV.get(processedKey);
    
    if (isProcessed) {
      console.log(`⏭️ Skipping already processed tweet: ${tweetId}`);
      return false;
    }

    const tweetPreview = tweet.text?.substring(0, 50) || 'No text';
    console.log(`🎉 Processing tweet ${tweetId} from user ${authorId}: "${tweetPreview}..."`);

    // Send reward event
    const success = await this.sendRewardEvent(env, authorId, eventType, tweetId);

    // Mark as processed (TTL 30 days to prevent re-processing)
    await env.TWITTER_BOT_KV.put(processedKey, JSON.stringify({
      processed_at: new Date().toISOString(),
      event_type: eventType,
      success: success
    }), { expirationTtl: 2592000 }); // 30 days
    
    return true;
  },

  // Send reward event to Loyalteez Event Handler - returns true on success
  async sendRewardEvent(env, socialId, eventType, referenceId) {
    // Use same payload format as Discord bot (loyalteez.js)
    // Twitter users get a synthetic email: twitter_{userId}@loyalteez.app
    const userEmail = `twitter_${socialId}@loyalteez.app`;
    
    const payload = {
      brandId: env.BRAND_ID,
      eventType: eventType,
      userEmail: userEmail,
      domain: 'x-demo.loyalteez.app',
      metadata: {
        platform: 'twitter',
        twitter_user_id: socialId,
        tweet_id: referenceId,
        timestamp: new Date().toISOString()
      }
    };

    try {
      // Using the same endpoint as Discord bot: /loyalteez-api/manual-event
      console.log(`📤 Sending event to ${env.LOYALTEEZ_API_URL}/loyalteez-api/manual-event...`);
      const response = await fetch(`${env.LOYALTEEZ_API_URL}/loyalteez-api/manual-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ API error: ${response.status} - ${errorText}`);
        return false;
      }
      
      const result = await response.json().catch(() => ({}));
      console.log(`✅ Event sent successfully`, result.message || '');
      return true;
    } catch (error) {
      console.error(`❌ Failed to send reward event:`, error.message || error);
      return false;
    }
  }
};
