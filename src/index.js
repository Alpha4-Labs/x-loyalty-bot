/**
 * Twitter/X Loyalty Bot - Cloudflare Worker
 * 
 * Polls Twitter API for brand mentions and rewards users with LTZ tokens.
 * Uses native fetch() for Cloudflare Workers compatibility.
 */

export default {
  // HTTP Handler for manual triggers or health checks
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ 
        status: 'ok',
        service: 'twitter-loyalty-bot',
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

    return new Response("🐦 Twitter Loyalty Bot Active\n\nEndpoints:\n- GET /health - Health check\n- POST /trigger - Manual poll trigger", { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // Scheduled Handler for Polling (cron trigger)
  async scheduled(event, env, ctx) {
    console.log("⏰ Cron triggered - Running Twitter Poll...");
    await this.pollTwitterMentions(env);
  },

  // Main polling logic
  async pollTwitterMentions(env) {
    try {
      // Check if Bearer Token is configured
      if (!env.TWITTER_BEARER_TOKEN) {
        console.log("⚠️ TWITTER_BEARER_TOKEN not configured. Skipping poll.");
        return;
      }

      // Check if handle is configured
      const handle = env.TWITTER_HANDLE;
      if (!handle || handle === 'configure_in_dashboard') {
        console.log("⚠️ TWITTER_HANDLE not configured. Skipping poll.");
        return;
      }

      console.log(`🔎 Searching mentions for @${handle}...`);

      // Step 1: Get User ID for the handle
      const userId = await this.getUserId(env, handle);
      if (!userId) {
        console.error(`❌ Could not find user ID for @${handle}`);
        return;
      }
      console.log(`✅ Found user ID: ${userId}`);

      // Step 2: Search for recent mentions
      const mentions = await this.searchMentions(env, handle);
      if (!mentions || mentions.length === 0) {
        console.log("📭 No new mentions found.");
        return;
      }

      console.log(`📬 Found ${mentions.length} mentions to process.`);

      // Step 3: Process each mention
      for (const tweet of mentions) {
        await this.processTweet(env, tweet, 'tweet_mention');
      }

      console.log("✅ Poll complete.");

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

  // Search for recent mentions
  async searchMentions(env, handle) {
    // Twitter API v2 search endpoint
    // Note: Basic tier allows recent search (last 7 days)
    const query = encodeURIComponent(`@${handle} -is:retweet`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=author_id,created_at,text&expansions=author_id`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error (searchMentions): ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    return data.data || [];
  },

  // Process a single tweet
  async processTweet(env, tweet, eventType) {
    const tweetId = tweet.id;
    const authorId = tweet.author_id;

    // Check if already processed
    const processedKey = `processed:${tweetId}`;
    const isProcessed = await env.TWITTER_BOT_KV.get(processedKey);
    
    if (isProcessed) {
      console.log(`⏭️ Skipping already processed tweet: ${tweetId}`);
      return;
    }

    const tweetPreview = tweet.text?.substring(0, 50) || 'No text';
    console.log(`🎉 Processing tweet ${tweetId} from user ${authorId}: "${tweetPreview}..."`);

    // Send reward event
    await this.sendRewardEvent(env, authorId, eventType, tweetId);

    // Mark as processed (TTL 7 days to prevent re-processing)
    await env.TWITTER_BOT_KV.put(processedKey, JSON.stringify({
      processed_at: new Date().toISOString(),
      event_type: eventType
    }), { expirationTtl: 604800 });
  },

  // Send reward event to Loyalteez Event Handler
  async sendRewardEvent(env, socialId, eventType, referenceId) {
    const payload = {
      brand_id: env.BRAND_ID,
      event_type: eventType,
      user_identifier: `twitter:${socialId}`,
      metadata: {
        platform: 'twitter',
        reference_id: referenceId,
        timestamp: new Date().toISOString()
      }
    };

    try {
      // Use service binding if available (faster, no external HTTP)
      if (env.EVENT_HANDLER) {
        console.log(`📤 Sending event via service binding...`);
        const response = await env.EVENT_HANDLER.fetch(
          new Request("http://internal/process-event", {
            method: "POST",
            body: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" }
          })
        );
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ Event Handler error: ${response.status} - ${errorText}`);
        } else {
          const result = await response.json();
          console.log(`✅ Event sent successfully:`, result);
        }
      } else {
        // Fallback to HTTP API
        console.log(`📤 Sending event via HTTP API...`);
        const response = await fetch(`${env.LOYALTEEZ_API_URL}/loyalteez-api/process-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ API error: ${response.status} - ${errorText}`);
        } else {
          console.log(`✅ Event sent to API`);
        }
      }
    } catch (error) {
      console.error(`❌ Failed to send reward event:`, error.message || error);
    }
  }
};
