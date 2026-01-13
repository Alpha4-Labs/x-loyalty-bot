/**
 * Hashtag Campaign Polling
 * 
 * Tracks hashtag campaigns and rewards users who use brand hashtags
 */

import { recordTwitterEngagement } from '../services/streak-client.js';

export async function pollHashtagCampaigns(env, config) {
  const result = {
    hashtagsFound: 0,
    rewardsIssued: 0,
    rewardsFailed: 0,
    errors: []
  };

  try {
    if (!env.TWITTER_BEARER_TOKEN) {
      result.errors.push("TWITTER_BEARER_TOKEN not configured");
      return result;
    }

    const campaigns = config.hashtagCampaigns || [];
    
    if (campaigns.length === 0) {
      console.log("📭 No hashtag campaigns configured.");
      return result;
    }

    console.log(`🔎 Polling ${campaigns.length} hashtag campaigns...`);

    for (const campaign of campaigns) {
      // Check if campaign is active
      const now = new Date();
      const startDate = new Date(campaign.start_date);
      const endDate = new Date(campaign.end_date);

      if (now < startDate || now > endDate) {
        console.log(`⏸️ Campaign ${campaign.hashtag} is not active (${campaign.start_date} - ${campaign.end_date})`);
        continue;
      }

      const campaignResult = await pollHashtagCampaign(env, campaign, config);
      result.hashtagsFound += campaignResult.hashtagsFound;
      result.rewardsIssued += campaignResult.rewardsIssued;
      result.rewardsFailed += campaignResult.rewardsFailed;
      result.errors.push(...campaignResult.errors);
    }

    console.log(`✅ Hashtag campaigns poll complete. Found ${result.hashtagsFound}, rewarded ${result.rewardsIssued}.`);
    return result;

  } catch (error) {
    result.errors.push(error.message || String(error));
    return result;
  }
}

async function pollHashtagCampaign(env, campaign, config) {
  const result = {
    hashtagsFound: 0,
    rewardsIssued: 0,
    rewardsFailed: 0,
    errors: []
  };

  try {
    const handle = config.twitterHandle;
    const query = `${campaign.hashtag} -from:${handle}`;
    
    const response = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=author_id,created_at`,
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
    result.hashtagsFound = tweets.length;

    if (tweets.length === 0) {
      return result;
    }

    console.log(`📬 Found ${tweets.length} tweets with ${campaign.hashtag}`);

    // Process each tweet
    for (const tweet of tweets) {
      const { processed, success } = await processHashtagTweet(env, tweet, campaign, config);
      if (processed) {
        if (success) result.rewardsIssued++;
        else result.rewardsFailed++;
      }
    }

    return result;

  } catch (error) {
    result.errors.push(error.message || String(error));
    return result;
  }
}

async function processHashtagTweet(env, tweet, campaign, config) {
  try {
    const userId = tweet.author_id;
    const userIdentifier = `twitter_${userId}@loyalteez.app`;

    // Check if user has exceeded max claims
    const claimKey = `hashtag_claims:${campaign.hashtag}:${userId}`;
    const claimCount = parseInt(await env.TWITTER_BOT_KV.get(claimKey) || '0', 10);
    
    if (claimCount >= campaign.max_claims_per_user) {
      return { processed: false, success: false };
    }

    // Check if already processed (deduplication)
    const processedKey = `processed:tweet_hashtag:${campaign.hashtag}:${tweet.id}`;
    const alreadyProcessed = await env.TWITTER_BOT_KV.get(processedKey);
    
    if (alreadyProcessed) {
      return { processed: false, success: false };
    }

    // Record engagement for streak
    const streakResult = await recordTwitterEngagement(env, userId, 'engagement');

    // Calculate reward with campaign multiplier
    const baseReward = 30; // Default reward for hashtag usage
    const multipliedReward = Math.floor(baseReward * (campaign.reward_multiplier || 1.0) * streakResult.multiplier);

    // Send reward event
    const rewardResult = await sendRewardEvent(env, {
      brandId: env.BRAND_ID,
      eventType: 'tweet_hashtag',
      userEmail: userIdentifier,
      metadata: {
        platform: 'twitter',
        twitter_user_id: userId,
        tweet_id: tweet.id,
        hashtag: campaign.hashtag,
        campaign_multiplier: campaign.reward_multiplier,
        streak_multiplier: streakResult.multiplier,
        total_reward: multipliedReward
      }
    });

    if (rewardResult.success) {
      // Mark as processed
      await env.TWITTER_BOT_KV.put(processedKey, '1', {
        expirationTtl: 60 * 60 * 24 * 30 // 30 days
      });

      // Increment claim count
      await env.TWITTER_BOT_KV.put(claimKey, (claimCount + 1).toString(), {
        expirationTtl: 60 * 60 * 24 * 90 // 90 days
      });

      return { processed: true, success: true };
    }

    return { processed: true, success: false };

  } catch (error) {
    console.error('Error processing hashtag tweet:', error);
    return { processed: true, success: false };
  }
}


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
