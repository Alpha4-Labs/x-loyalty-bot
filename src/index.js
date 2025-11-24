import { TwitterApi } from 'twitter-api-v2';

export default {
  // HTTP Handler for manual triggers or webhooks
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CRC Check Endpoint (for Account Activity API if used)
    if (request.method === 'GET' && url.searchParams.has('crc_token')) {
      const crc_token = url.searchParams.get('crc_token');
      // Note: Real implementation requires HMAC-SHA256 signature of crc_token with API Secret
      return new Response(JSON.stringify({ 
        response_token: `sha256=mock_signature_for_demo` 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response("🐦 Twitter Loyalty Bot Active.\nUse Scheduled Triggers (Cron) for polling.", { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // Scheduled Handler for Polling (every 15 mins)
  async scheduled(event, env, ctx) {
    console.log("⏰ Running Twitter Poll...");
    
    try {
      // Check if secrets are configured
      if (!env.TWITTER_BEARER_TOKEN && !env.TWITTER_API_KEY) {
        console.log("⚠️ Twitter API secrets not configured. Skipping poll.");
        return;
      }

      // Initialize Twitter Client
      // Use App-Only auth (Bearer Token) for reading public data like mentions
      const client = new TwitterApi(env.TWITTER_BEARER_TOKEN || {
        appKey: env.TWITTER_API_KEY,
        appSecret: env.TWITTER_API_SECRET,
        accessToken: env.TWITTER_ACCESS_TOKEN,
        accessSecret: env.TWITTER_ACCESS_SECRET,
      });

      const roClient = client.readOnly;

      // Get Brand Handle
      const handle = env.TWITTER_HANDLE;
      if (!handle) {
        console.log("⚠️ No Twitter handle configured.");
        return;
      }

      console.log(`🔎 Searching mentions for @${handle}...`);

      // 1. Get User ID for the handle (cache this in KV in production)
      // Note: We wrap this in try/catch as it might fail if limits are hit
      let userId;
      try {
        const user = await roClient.v2.userByUsername(handle);
        if (!user.data) {
          console.error(`❌ User ${handle} not found.`);
          return;
        }
        userId = user.data.id;
      } catch (e) {
        console.error("Error fetching user ID:", e);
        return;
      }

      // 2. Search for recent mentions (excluding retweets)
      // limit to 10 to save quota
      const tweets = await roClient.v2.search(`@${handle} -is:retweet`, {
        'tweet.fields': ['author_id', 'created_at', 'text'],
        'expansions': ['author_id'],
        max_results: 10
      });

      if (!tweets.data || tweets.data.length === 0) {
        console.log("No new mentions found.");
        return;
      }

      console.log(`Found ${tweets.data.length} mentions.`);

      for (const tweet of tweets.data) {
        const tweetId = tweet.id;
        const authorId = tweet.author_id;

        // Check if already processed via KV
        const processedKey = `processed_tweet:${tweetId}`;
        const isProcessed = await env.TWITTER_BOT_KV.get(processedKey);
        
        if (isProcessed) {
          continue;
        }

        console.log(`🎉 Processing tweet ${tweetId} from ${authorId}: "${tweet.text.substring(0, 30)}..."`);

        // Reward logic: Call Event Handler Service
        await processReward(env, authorId, 'tweet_mention', tweetId);

        // Mark as processed (TTL 7 days)
        await env.TWITTER_BOT_KV.put(processedKey, 'true', { expirationTtl: 604800 });
      }

    } catch (error) {
      console.error("❌ Error in scheduled task:", error);
    }
  }
};

async function processReward(env, socialId, eventType, referenceId) {
  // Construct the event payload for the centralized Event Handler
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
    if (env.EVENT_HANDLER) {
      // Call the internal service binding
      const response = await env.EVENT_HANDLER.fetch(new Request("http://internal/process-event", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" }
      }));
      
      if (!response.ok) {
        console.error(`❌ Event Handler returned ${response.status}`);
      } else {
        console.log(`✅ Event sent to handler: ${eventType}`);
      }
    } else {
      console.log(`⚠️ EVENT_HANDLER binding not found. Would send payload:`, payload);
    }
  } catch (e) {
    console.error(`❌ Failed to call Event Handler:`, e);
  }
}
