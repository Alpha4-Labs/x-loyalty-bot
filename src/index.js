/**
 * Twitter/X Loyalty Bot - Cloudflare Worker
 * 
 * Polls Twitter API for brand engagements and rewards users with LTZ tokens.
 * Supports: mentions, replies, likes, and retweets.
 * Reads configuration from Supabase (Partner Portal) for single source of truth.
 */

// CORS headers for health checks from browser
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Event types supported by the bot
const EVENT_TYPES = {
  MENTION: 'tweet_mention',
  REPLY: 'tweet_reply',
  LIKE: 'tweet_like',
  RETWEET: 'tweet_retweet'
};

export default {
  // HTTP Handler for manual triggers or health checks
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Health check endpoint with CORS
    if (url.pathname === '/health') {
      const config = await this.getBrandConfig(env);
      return new Response(JSON.stringify({ 
        status: 'ok',
        service: 'twitter-loyalty-bot',
        brand_id: env.BRAND_ID,
        twitter_handle: config?.twitterHandle || 'not configured',
        supported_events: Object.values(EVENT_TYPES),
        timestamp: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Manual trigger endpoint (for testing)
    if (url.pathname === '/trigger' && request.method === 'POST') {
      try {
        const result = await this.pollAllEngagements(env);
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Poll triggered',
          ...result
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Trigger specific engagement type
    if (url.pathname.startsWith('/trigger/') && request.method === 'POST') {
      const eventType = url.pathname.replace('/trigger/', '');
      const validTypes = ['mentions', 'replies', 'likes', 'retweets'];
      if (!validTypes.includes(eventType)) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: `Invalid event type. Valid types: ${validTypes.join(', ')}` 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const result = await this.pollEngagementType(env, eventType);
        return new Response(JSON.stringify({ 
          success: true, 
          message: `Poll triggered for ${eventType}`,
          ...result
        }), {
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
          const handle = config.twitterHandle.toLowerCase();
          // Reset all high water marks
          await env.TWITTER_BOT_KV.delete(`high_water:mentions:${handle}`);
          await env.TWITTER_BOT_KV.delete(`high_water:replies:${handle}`);
          await env.TWITTER_BOT_KV.delete(`high_water:tweets:${handle}`);
          return new Response(JSON.stringify({ 
            success: true, 
            message: `All high water marks reset for @${config.twitterHandle}. Next poll will be treated as first run.` 
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
        supabase_url: env.SUPABASE_URL || 'NOT SET',
        supported_events: Object.values(EVENT_TYPES)
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(`🐦 Twitter Loyalty Bot Active

Supported Engagement Types:
- tweet_mention: User mentions @YourBrand in a tweet
- tweet_reply: User replies to your tweets  
- tweet_like: User likes your tweets (requires elevated API)
- tweet_retweet: User retweets your content (requires elevated API)

Endpoints:
- GET  /health           - Health check
- GET  /config           - View configuration
- POST /trigger          - Poll all engagement types
- POST /trigger/mentions - Poll mentions only
- POST /trigger/replies  - Poll replies only
- POST /trigger/likes    - Poll likes only (elevated API)
- POST /trigger/retweets - Poll retweets only (elevated API)
- POST /reset            - Reset all high water marks
`, { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // Scheduled Handler for Polling (cron trigger)
  async scheduled(event, env, ctx) {
    console.log("⏰ Cron triggered - Running Twitter Engagement Poll...");
    await this.pollAllEngagements(env);
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

  // Poll a specific engagement type
  async pollEngagementType(env, type) {
    switch (type) {
      case 'mentions':
        return await this.pollTwitterMentions(env);
      case 'replies':
        return await this.pollTwitterReplies(env);
      case 'likes':
        return await this.pollTwitterLikes(env);
      case 'retweets':
        return await this.pollTwitterRetweets(env);
      default:
        throw new Error(`Unknown engagement type: ${type}`);
    }
  },

  // Poll all engagement types
  async pollAllEngagements(env) {
    const results = {
      mentions: { found: 0, rewarded: 0, errors: [] },
      replies: { found: 0, rewarded: 0, errors: [] },
      likes: { found: 0, rewarded: 0, errors: [] },
      retweets: { found: 0, rewarded: 0, errors: [] }
    };

    // Check prerequisites
    if (!env.TWITTER_BEARER_TOKEN) {
      const error = "TWITTER_BEARER_TOKEN not configured";
      console.log(`⚠️ ${error}. Skipping poll.`);
      return { error, results };
    }

    const config = await this.getBrandConfig(env);
    if (!config || !config.twitterHandle) {
      const error = "Twitter handle not configured in Partner Portal";
      console.log(`⚠️ ${error}. Skipping poll.`);
      return { error, results };
    }

    console.log(`🔄 Starting full engagement poll for @${config.twitterHandle}...`);

    // Poll mentions (Basic tier)
    try {
      const mentionResult = await this.pollTwitterMentions(env);
      results.mentions = { found: mentionResult.mentionsFound, rewarded: mentionResult.rewardsIssued, errors: mentionResult.errors };
    } catch (error) {
      console.error(`❌ Mentions poll failed:`, error.message);
      results.mentions.errors.push(error.message);
    }

    // Poll replies (Basic tier)
    try {
      const replyResult = await this.pollTwitterReplies(env);
      results.replies = { found: replyResult.repliesFound, rewarded: replyResult.rewardsIssued, errors: replyResult.errors };
    } catch (error) {
      console.error(`❌ Replies poll failed:`, error.message);
      results.replies.errors.push(error.message);
    }

    // Poll likes (Elevated API required)
    try {
      const likeResult = await this.pollTwitterLikes(env);
      results.likes = { found: likeResult.likesFound, rewarded: likeResult.rewardsIssued, errors: likeResult.errors };
    } catch (error) {
      console.error(`❌ Likes poll failed:`, error.message);
      results.likes.errors.push(error.message);
    }

    // Poll retweets (Elevated API required)
    try {
      const retweetResult = await this.pollTwitterRetweets(env);
      results.retweets = { found: retweetResult.retweetsFound, rewarded: retweetResult.rewardsIssued, errors: retweetResult.errors };
    } catch (error) {
      console.error(`❌ Retweets poll failed:`, error.message);
      results.retweets.errors.push(error.message);
    }

    console.log(`✅ Full engagement poll complete:`, JSON.stringify(results, null, 2));
    return { results };
  },

  // ============================================
  // MENTIONS POLLING (Basic Tier)
  // ============================================

  async pollTwitterMentions(env) {
    const result = {
      mentionsFound: 0,
      rewardsIssued: 0,
      rewardsFailed: 0,
      errors: []
    };

    try {
      if (!env.TWITTER_BEARER_TOKEN) {
        result.errors.push("TWITTER_BEARER_TOKEN not configured");
        return result;
      }

      const config = await this.getBrandConfig(env);
      if (!config || !config.twitterHandle) {
        result.errors.push("Twitter handle not configured in Partner Portal");
        return result;
      }

      const handle = config.twitterHandle;
      console.log(`🔎 Searching mentions for @${handle}...`);

      // Get User ID for the handle
      const userId = await this.getUserId(env, handle);
      if (!userId) {
        result.errors.push(`Could not find user ID for @${handle}`);
        return result;
      }

      // Search for recent mentions
      const { tweets, isFirstRun, newestId } = await this.searchMentions(env, handle);
      result.mentionsFound = tweets?.length || 0;

      if (!tweets || tweets.length === 0) {
        console.log("📭 No new mentions found.");
        if (newestId) {
          await this.updateHighWaterMark(env, 'mentions', handle, newestId);
        }
        return result;
      }

      console.log(`📬 Found ${tweets.length} ${isFirstRun ? 'recent' : 'NEW'} mentions to process.`);

      // Process each mention
      for (const tweet of tweets) {
        const { processed, success } = await this.processTweet(env, tweet, EVENT_TYPES.MENTION);
        if (processed) {
          if (success) result.rewardsIssued++;
          else result.rewardsFailed++;
        }
      }

      // Update high water mark
      if (newestId) {
        await this.updateHighWaterMark(env, 'mentions', handle, newestId);
      }

      console.log(`✅ Mentions poll complete. Found ${result.mentionsFound}, rewarded ${result.rewardsIssued}.`);
      return result;

    } catch (error) {
      result.errors.push(error.message || String(error));
      return result;
    }
  },

  // ============================================
  // REPLIES POLLING (Basic Tier)
  // ============================================

  async pollTwitterReplies(env) {
    const result = {
      repliesFound: 0,
      rewardsIssued: 0,
      rewardsFailed: 0,
      errors: []
    };

    try {
      if (!env.TWITTER_BEARER_TOKEN) {
        result.errors.push("TWITTER_BEARER_TOKEN not configured");
        return result;
      }

      const config = await this.getBrandConfig(env);
      if (!config || !config.twitterHandle) {
        result.errors.push("Twitter handle not configured in Partner Portal");
        return result;
      }

      const handle = config.twitterHandle;
      console.log(`🔎 Searching replies to @${handle}...`);

      // Get User ID for the handle
      const userId = await this.getUserId(env, handle);
      if (!userId) {
        result.errors.push(`Could not find user ID for @${handle}`);
        return result;
      }

      // Search for replies to brand's tweets
      const { tweets, isFirstRun, newestId } = await this.searchReplies(env, handle, userId);
      result.repliesFound = tweets?.length || 0;

      if (!tweets || tweets.length === 0) {
        console.log("📭 No new replies found.");
        if (newestId) {
          await this.updateHighWaterMark(env, 'replies', handle, newestId);
        }
        return result;
      }

      console.log(`📬 Found ${tweets.length} ${isFirstRun ? 'recent' : 'NEW'} replies to process.`);

      // Process each reply
      for (const tweet of tweets) {
        const { processed, success } = await this.processTweet(env, tweet, EVENT_TYPES.REPLY);
        if (processed) {
          if (success) result.rewardsIssued++;
          else result.rewardsFailed++;
        }
      }

      // Update high water mark
      if (newestId) {
        await this.updateHighWaterMark(env, 'replies', handle, newestId);
      }

      console.log(`✅ Replies poll complete. Found ${result.repliesFound}, rewarded ${result.rewardsIssued}.`);
      return result;

    } catch (error) {
      result.errors.push(error.message || String(error));
      return result;
    }
  },

  // Search for replies to brand's tweets using conversation_id
  async searchReplies(env, handle, brandUserId) {
    const highWaterKey = `high_water:replies:${handle.toLowerCase()}`;
    const sinceId = await env.TWITTER_BOT_KV.get(highWaterKey);

    // Search for tweets that are replies to the brand (using "to:" operator)
    // Also filter to only include replies (is:reply)
    const query = encodeURIComponent(`to:${handle} is:reply -from:${handle}`);
    let url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=author_id,created_at,text,in_reply_to_user_id,conversation_id&expansions=author_id`;

    if (sinceId) {
      url += `&since_id=${sinceId}`;
      console.log(`📍 Using replies high water mark: since_id=${sinceId}`);
    } else {
      console.log(`🆕 First replies run - will only process most recent 3 replies`);
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    this.logRateLimits(response);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error (searchReplies): ${response.status} - ${errorText}`);
      return { tweets: [], isFirstRun: !sinceId, newestId: null };
    }

    const data = await response.json();
    let tweets = data.data || [];

    // Filter to only include replies where in_reply_to_user_id matches the brand
    tweets = tweets.filter(tweet => tweet.in_reply_to_user_id === brandUserId);

    const newestId = data.meta?.newest_id || (tweets.length > 0 ? tweets[0].id : null);

    return {
      tweets: !sinceId && tweets.length > 3 ? tweets.slice(0, 3) : tweets,
      isFirstRun: !sinceId,
      newestId
    };
  },

  // ============================================
  // LIKES POLLING (Elevated API Required)
  // ============================================

  async pollTwitterLikes(env) {
    const result = {
      likesFound: 0,
      rewardsIssued: 0,
      rewardsFailed: 0,
      errors: []
    };

    try {
      if (!env.TWITTER_BEARER_TOKEN) {
        result.errors.push("TWITTER_BEARER_TOKEN not configured");
        return result;
      }

      const config = await this.getBrandConfig(env);
      if (!config || !config.twitterHandle) {
        result.errors.push("Twitter handle not configured in Partner Portal");
        return result;
      }

      const handle = config.twitterHandle;
      console.log(`🔎 Searching likes on @${handle}'s tweets...`);

      // Get User ID for the handle
      const userId = await this.getUserId(env, handle);
      if (!userId) {
        result.errors.push(`Could not find user ID for @${handle}`);
        return result;
      }

      // Get the brand's recent tweets
      const brandTweets = await this.getBrandRecentTweets(env, userId, handle);
      if (!brandTweets || brandTweets.length === 0) {
        console.log("📭 No recent brand tweets to check for likes.");
        return result;
      }

      console.log(`📋 Checking likes on ${brandTweets.length} brand tweets...`);

      // For each tweet, get users who liked it
      for (const tweet of brandTweets) {
        const likers = await this.getTweetLikers(env, tweet.id, handle);
        if (!likers || likers.length === 0) continue;

        console.log(`❤️ Found ${likers.length} likers on tweet ${tweet.id}`);

        for (const liker of likers) {
          result.likesFound++;
          
          // Create a synthetic tweet object for processing
          const likeEvent = {
            id: `like_${tweet.id}_${liker.id}`,
            author_id: liker.id,
            text: `Liked tweet: ${tweet.text?.substring(0, 50)}...`,
            liked_tweet_id: tweet.id
          };

          const { processed, success } = await this.processTweet(env, likeEvent, EVENT_TYPES.LIKE);
          if (processed) {
            if (success) result.rewardsIssued++;
            else result.rewardsFailed++;
          }
        }
      }

      console.log(`✅ Likes poll complete. Found ${result.likesFound}, rewarded ${result.rewardsIssued}.`);
      return result;

    } catch (error) {
      // Check for elevated access errors
      if (error.message?.includes('403') || error.message?.includes('elevated')) {
        result.errors.push("Likes tracking requires elevated Twitter API access. Upgrade to Pro tier ($5000/mo) or use OAuth 2.0 User Context.");
      } else {
        result.errors.push(error.message || String(error));
      }
      return result;
    }
  },

  // Get users who liked a specific tweet
  async getTweetLikers(env, tweetId, handle) {
    const cacheKey = `likers_checked:${tweetId}`;
    const lastCheckedLikers = await env.TWITTER_BOT_KV.get(cacheKey);
    const previousLikerIds = lastCheckedLikers ? JSON.parse(lastCheckedLikers) : [];

    // Note: This endpoint requires elevated access (Pro tier) or OAuth 2.0 User Context
    const url = `https://api.twitter.com/2/tweets/${tweetId}/liking_users?max_results=100`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    this.logRateLimits(response);

    if (!response.ok) {
      if (response.status === 403) {
        console.log(`⚠️ Likes endpoint requires elevated API access`);
        throw new Error('403 - Elevated API access required for likes');
      }
      const errorText = await response.text();
      console.error(`❌ Twitter API error (getTweetLikers): ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    const allLikers = data.data || [];

    // Filter to only include NEW likers (not already rewarded)
    const newLikers = allLikers.filter(liker => !previousLikerIds.includes(liker.id));

    // Update the cache with all current likers
    const allLikerIds = allLikers.map(l => l.id);
    await env.TWITTER_BOT_KV.put(cacheKey, JSON.stringify(allLikerIds), { expirationTtl: 86400 * 7 });

    return newLikers;
  },

  // ============================================
  // RETWEETS POLLING (Elevated API Required)
  // ============================================

  async pollTwitterRetweets(env) {
    const result = {
      retweetsFound: 0,
      rewardsIssued: 0,
      rewardsFailed: 0,
      errors: []
    };

    try {
      if (!env.TWITTER_BEARER_TOKEN) {
        result.errors.push("TWITTER_BEARER_TOKEN not configured");
        return result;
      }

      const config = await this.getBrandConfig(env);
      if (!config || !config.twitterHandle) {
        result.errors.push("Twitter handle not configured in Partner Portal");
        return result;
      }

      const handle = config.twitterHandle;
      console.log(`🔎 Searching retweets of @${handle}'s tweets...`);

      // Get User ID for the handle
      const userId = await this.getUserId(env, handle);
      if (!userId) {
        result.errors.push(`Could not find user ID for @${handle}`);
        return result;
      }

      // Get the brand's recent tweets
      const brandTweets = await this.getBrandRecentTweets(env, userId, handle);
      if (!brandTweets || brandTweets.length === 0) {
        console.log("📭 No recent brand tweets to check for retweets.");
        return result;
      }

      console.log(`📋 Checking retweets on ${brandTweets.length} brand tweets...`);

      // For each tweet, get users who retweeted it
      for (const tweet of brandTweets) {
        const retweeters = await this.getTweetRetweeters(env, tweet.id, handle);
        if (!retweeters || retweeters.length === 0) continue;

        console.log(`🔁 Found ${retweeters.length} retweeters on tweet ${tweet.id}`);

        for (const retweeter of retweeters) {
          result.retweetsFound++;

          // Create a synthetic tweet object for processing
          const retweetEvent = {
            id: `retweet_${tweet.id}_${retweeter.id}`,
            author_id: retweeter.id,
            text: `Retweeted: ${tweet.text?.substring(0, 50)}...`,
            retweeted_tweet_id: tweet.id
          };

          const { processed, success } = await this.processTweet(env, retweetEvent, EVENT_TYPES.RETWEET);
          if (processed) {
            if (success) result.rewardsIssued++;
            else result.rewardsFailed++;
          }
        }
      }

      console.log(`✅ Retweets poll complete. Found ${result.retweetsFound}, rewarded ${result.rewardsIssued}.`);
      return result;

    } catch (error) {
      // Check for elevated access errors
      if (error.message?.includes('403') || error.message?.includes('elevated')) {
        result.errors.push("Retweet tracking requires elevated Twitter API access. Upgrade to Pro tier ($5000/mo) or use OAuth 2.0 User Context.");
      } else {
        result.errors.push(error.message || String(error));
      }
      return result;
    }
  },

  // Get users who retweeted a specific tweet
  async getTweetRetweeters(env, tweetId, handle) {
    const cacheKey = `retweeters_checked:${tweetId}`;
    const lastCheckedRetweeters = await env.TWITTER_BOT_KV.get(cacheKey);
    const previousRetweeterIds = lastCheckedRetweeters ? JSON.parse(lastCheckedRetweeters) : [];

    // Note: This endpoint requires elevated access (Pro tier) or OAuth 2.0 User Context
    const url = `https://api.twitter.com/2/tweets/${tweetId}/retweeted_by?max_results=100`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    this.logRateLimits(response);

    if (!response.ok) {
      if (response.status === 403) {
        console.log(`⚠️ Retweets endpoint requires elevated API access`);
        throw new Error('403 - Elevated API access required for retweets');
      }
      const errorText = await response.text();
      console.error(`❌ Twitter API error (getTweetRetweeters): ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    const allRetweeters = data.data || [];

    // Filter to only include NEW retweeters (not already rewarded)
    const newRetweeters = allRetweeters.filter(rt => !previousRetweeterIds.includes(rt.id));

    // Update the cache with all current retweeters
    const allRetweeterIds = allRetweeters.map(r => r.id);
    await env.TWITTER_BOT_KV.put(cacheKey, JSON.stringify(allRetweeterIds), { expirationTtl: 86400 * 7 });

    return newRetweeters;
  },

  // ============================================
  // SHARED UTILITIES
  // ============================================

  // Get brand's recent tweets (for likes/retweets tracking)
  async getBrandRecentTweets(env, userId, handle) {
    const cacheKey = `brand_tweets:${handle.toLowerCase()}`;
    const highWaterKey = `high_water:tweets:${handle.toLowerCase()}`;
    
    // Get cached tweet IDs we've already processed
    const cachedTweetIds = await env.TWITTER_BOT_KV.get(cacheKey);
    const lastTweetId = await env.TWITTER_BOT_KV.get(highWaterKey);

    // Fetch brand's recent tweets (last 7 days)
    let url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text&exclude=retweets,replies`;
    
    // We still want to check existing tweets for new likes/retweets, so don't use since_id here
    // Instead, we limit to tweets from the last 7 days (Twitter's search limit anyway)

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    this.logRateLimits(response);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error (getBrandRecentTweets): ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    const tweets = data.data || [];

    // Update high water mark for future reference
    if (tweets.length > 0) {
      const newestId = tweets[0].id;
      await env.TWITTER_BOT_KV.put(highWaterKey, newestId);
    }

    return tweets;
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
    const highWaterKey = `high_water:mentions:${handle.toLowerCase()}`;
    const sinceId = await env.TWITTER_BOT_KV.get(highWaterKey);
    
    const query = encodeURIComponent(`@${handle} -is:retweet`);
    let url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=author_id,created_at,text&expansions=author_id`;
    
    if (sinceId) {
      url += `&since_id=${sinceId}`;
      console.log(`📍 Using mentions high water mark: since_id=${sinceId}`);
    } else {
      console.log(`🆕 First mentions run - will only process most recent 3 tweets`);
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    this.logRateLimits(response);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Twitter API error (searchMentions): ${response.status} - ${errorText}`);
      if (response.status === 429) {
        const rateReset = response.headers.get('x-rate-limit-reset');
        if (rateReset) {
          const resetTime = new Date(parseInt(rateReset) * 1000);
          console.log(`⏰ Rate limit resets at: ${resetTime.toISOString()}`);
        }
      }
      return { tweets: [], isFirstRun: !sinceId, newestId: null };
    }

    const data = await response.json();
    const tweets = data.data || [];
    const newestId = data.meta?.newest_id || (tweets.length > 0 ? tweets[0].id : null);
    
    return { 
      tweets: !sinceId && tweets.length > 3 ? tweets.slice(0, 3) : tweets,
      isFirstRun: !sinceId, 
      newestId 
    };
  },

  // Log rate limit headers
  logRateLimits(response) {
    const rateLimit = response.headers.get('x-rate-limit-limit');
    const rateRemaining = response.headers.get('x-rate-limit-remaining');
    const rateReset = response.headers.get('x-rate-limit-reset');
    if (rateRemaining !== null) {
      const resetDate = rateReset ? new Date(parseInt(rateReset) * 1000).toISOString() : 'unknown';
      console.log(`📊 Rate limit: ${rateRemaining}/${rateLimit} remaining, resets at ${resetDate}`);
    }
  },

  // Update the high water mark after successful processing
  async updateHighWaterMark(env, type, handle, newestId) {
    if (!newestId) return;
    const highWaterKey = `high_water:${type}:${handle.toLowerCase()}`;
    await env.TWITTER_BOT_KV.put(highWaterKey, newestId);
    console.log(`📍 Updated ${type} high water mark to: ${newestId}`);
  },

  // Process a single tweet/engagement - returns { processed: boolean, success: boolean }
  async processTweet(env, tweet, eventType) {
    const tweetId = tweet.id;
    const authorId = tweet.author_id;

    // Check if already processed (belt-and-suspenders with high water mark)
    const processedKey = `processed:${eventType}:${tweetId}`;
    const isProcessed = await env.TWITTER_BOT_KV.get(processedKey);
    
    if (isProcessed) {
      console.log(`⏭️ Skipping already processed ${eventType}: ${tweetId}`);
      return { processed: false, success: false };
    }

    const tweetPreview = tweet.text?.substring(0, 50) || 'No text';
    console.log(`🎉 Processing ${eventType} ${tweetId} from user ${authorId}: "${tweetPreview}..."`);

    // Send reward event
    const success = await this.sendRewardEvent(env, authorId, eventType, tweetId, tweet);

    // Mark as processed (TTL 30 days to prevent re-processing)
    await env.TWITTER_BOT_KV.put(processedKey, JSON.stringify({
      processed_at: new Date().toISOString(),
      event_type: eventType,
      success: success
    }), { expirationTtl: 2592000 }); // 30 days
    
    return { processed: true, success };
  },

  // Send reward event to Loyalteez Event Handler
  async sendRewardEvent(env, socialId, eventType, referenceId, tweet = {}) {
    const userEmail = `twitter_${socialId}@loyalteez.app`;
    
    const config = await this.getBrandConfig(env);
    const twitterHandle = config?.twitterHandle;

    const payload = {
      brandId: env.BRAND_ID,
      eventType: eventType,
      userEmail: userEmail,
      twitterHandle: twitterHandle,
      metadata: {
        platform: 'twitter',
        twitter_user_id: socialId,
        tweet_id: referenceId,
        original_tweet_id: tweet.liked_tweet_id || tweet.retweeted_tweet_id || null,
        timestamp: new Date().toISOString()
      }
    };

    // Try Service Binding first (preferred - avoids 522 timeouts)
    if (env.EVENT_HANDLER) {
      try {
        console.log(`📤 Sending ${eventType} event via Service Binding...`);
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
          console.error('Failed to parse service binding response:', responseText.substring(0, 200));
          throw new Error(`Service binding returned invalid JSON: ${response.status}`);
        }

        if (!response.ok) {
          console.error(`❌ API error (Service Binding): ${response.status}`, data);
          throw new Error(data.error || `API returned ${response.status}`);
        }

        console.log(`✅ ${eventType} event sent successfully via Service Binding:`, data.message || '');
        return true;
      } catch (error) {
        console.error('Service Binding failed, falling back to HTTP:', error.message);
      }
    }

    // Fallback to HTTP fetch
    try {
      console.log(`📤 Sending ${eventType} event via HTTP to ${env.LOYALTEEZ_API_URL}/loyalteez-api/manual-event...`);
      const response = await fetch(`${env.LOYALTEEZ_API_URL}/loyalteez-api/manual-event`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Loyalteez-Twitter-Bot/1.0'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ API error (HTTP): ${response.status} - ${errorText}`);
        return false;
      }
      
      const result = await response.json().catch(() => ({}));
      console.log(`✅ ${eventType} event sent successfully via HTTP:`, result.message || '');
      return true;
    } catch (error) {
      console.error(`❌ Failed to send ${eventType} reward event:`, error.message || error);
      return false;
    }
  }
};
