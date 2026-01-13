/**
 * Quote Tweet Polling
 * 
 * Detects when users quote-tweet brand content
 */

import { recordTwitterEngagement } from '../services/streak-client.js';

export async function pollQuoteTweets(env, config) {
  const result = {
    quotesFound: 0,
    rewardsIssued: 0,
    rewardsFailed: 0,
    errors: []
  };

  try {
    if (!env.TWITTER_BEARER_TOKEN) {
      result.errors.push("TWITTER_BEARER_TOKEN not configured");
      return result;
    }

    const handle = config.twitterHandle;
    const userId = config.twitterUserId;

    if (!userId) {
      result.errors.push("Twitter user ID not found");
      return result;
    }

    console.log(`🔎 Searching quote tweets for @${handle}...`);

    // Search for quote tweets of brand's tweets
    // Query: url:twitter.com/{handle}/status -from:{handle}
    const query = `url:twitter.com/${handle}/status -from:${handle}`;
    
    const response = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=author_id,created_at,referenced_tweets`,
      {
        headers: {
          'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      result.errors.push(`Twitter API error: ${response.status} - ${errorText}`);
      return result;
    }

    const data = await response.json();
    const tweets = data.data || [];
    result.quotesFound = tweets.length;

    if (tweets.length === 0) {
      console.log("📭 No new quote tweets found.");
      return result;
    }

    console.log(`📬 Found ${tweets.length} quote tweets to process.`);

    // Process each quote tweet
    for (const tweet of tweets) {
      const { processed, success } = await processQuoteTweet(env, tweet, config);
      if (processed) {
        if (success) result.rewardsIssued++;
        else result.rewardsFailed++;
      }
    }

    console.log(`✅ Quote tweets poll complete. Found ${result.quotesFound}, rewarded ${result.rewardsIssued}.`);
    return result;

  } catch (error) {
    result.errors.push(error.message || String(error));
    return result;
  }
}

async function processQuoteTweet(env, tweet, config) {
  try {
    const userId = tweet.author_id;
    const userIdentifier = `twitter_${userId}@loyalteez.app`;

    // Check if already processed (deduplication)
    const processedKey = `processed:tweet_quote:${tweet.id}`;
    const alreadyProcessed = await env.TWITTER_BOT_KV.get(processedKey);
    
    if (alreadyProcessed) {
      return { processed: false, success: false };
    }

    // Record engagement for streak
    const streakResult = await recordTwitterEngagement(env, userId, 'engagement');

    // Send reward event
    const rewardResult = await sendRewardEvent(env, {
      brandId: env.BRAND_ID,
      eventType: 'tweet_quote',
      userEmail: userIdentifier,
      metadata: {
        platform: 'twitter',
        twitter_user_id: userId,
        tweet_id: tweet.id,
        tweet_text: tweet.text,
        streak_multiplier: streakResult.multiplier,
        current_streak: streakResult.currentStreak
      }
    });

    if (rewardResult.success) {
      // Mark as processed
      await env.TWITTER_BOT_KV.put(processedKey, '1', {
        expirationTtl: 60 * 60 * 24 * 30 // 30 days
      });
      return { processed: true, success: true };
    }

    return { processed: true, success: false };

  } catch (error) {
    console.error('Error processing quote tweet:', error);
    return { processed: true, success: false };
  }
}

import { recordTwitterEngagement } from '../services/streak-client.js';

async function sendRewardEvent(env, params) {
  try {
    const response = await fetch(`${env.LOYALTEEZ_API_URL || 'https://api.loyalteez.app'}/loyalteez-api/manual-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandId: params.brandId,
        eventType: params.eventType,
        userEmail: params.userEmail,
        metadata: params.metadata
      })
    });

    return { success: response.ok };
  } catch (error) {
    console.error('Error sending reward event:', error);
    return { success: false };
  }
}
