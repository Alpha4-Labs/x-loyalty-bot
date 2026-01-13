/**
 * Thread Participation Polling
 * 
 * Detects when users participate in brand's tweet threads
 */

import { recordTwitterEngagement } from '../services/streak-client.js';

export async function pollThreadParticipation(env, config) {
  const result = {
    threadRepliesFound: 0,
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

    console.log(`🔎 Searching thread participation for @${handle}...`);

    // Get brand's recent tweets (potential thread starters)
    const brandTweetsResponse = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=conversation_id,created_at`,
      {
        headers: {
          'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`
        }
      }
    );

    if (!brandTweetsResponse.ok) {
      const errorText = await brandTweetsResponse.text();
      result.errors.push(`Twitter API error: ${brandTweetsResponse.status} - ${errorText}`);
      return result;
    }

    const brandTweetsData = await brandTweetsResponse.json();
    const brandTweets = brandTweetsData.data || [];

    if (brandTweets.length === 0) {
      console.log("📭 No brand tweets found.");
      return result;
    }

    // For each brand tweet, find thread replies
    const uniqueParticipants = new Set();

    for (const tweet of brandTweets) {
      const conversationId = tweet.conversation_id || tweet.id;
      
      // Search for replies in this conversation
      const query = `conversation_id:${conversationId} -from:${handle}`;
      
      const response = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=author_id,created_at,referenced_tweets`,
        {
          headers: {
            'Authorization': `Bearer ${env.TWITTER_BEARER_TOKEN}`
          }
        }
      );

      if (!response.ok) {
        continue; // Skip this thread if API call fails
      }

      const data = await response.json();
      const replies = data.data || [];

      // Process unique participants
      for (const reply of replies) {
        if (reply.author_id && reply.author_id !== userId) {
          uniqueParticipants.add({
            userId: reply.author_id,
            tweetId: reply.id,
            conversationId: conversationId
          });
        }
      }
    }

    result.threadRepliesFound = uniqueParticipants.size;

    if (uniqueParticipants.size === 0) {
      console.log("📭 No new thread participation found.");
      return result;
    }

    console.log(`📬 Found ${uniqueParticipants.size} unique thread participants to process.`);

    // Process each participant
    for (const participant of uniqueParticipants) {
      const { processed, success } = await processThreadParticipant(env, participant, config);
      if (processed) {
        if (success) result.rewardsIssued++;
        else result.rewardsFailed++;
      }
    }

    console.log(`✅ Thread participation poll complete. Found ${result.threadRepliesFound}, rewarded ${result.rewardsIssued}.`);
    return result;

  } catch (error) {
    result.errors.push(error.message || String(error));
    return result;
  }
}

async function processThreadParticipant(env, participant, config) {
  try {
    const userId = participant.userId;
    const userIdentifier = `twitter_${userId}@loyalteez.app`;

    // Check if already processed (deduplication)
    const processedKey = `processed:tweet_thread_reply:${participant.conversationId}:${userId}`;
    const alreadyProcessed = await env.TWITTER_BOT_KV.get(processedKey);
    
    if (alreadyProcessed) {
      return { processed: false, success: false };
    }

    // Record engagement for streak
    const streakResult = await recordTwitterEngagement(env, userId, 'engagement');

    // Send reward event
    const rewardResult = await sendRewardEvent(env, {
      brandId: env.BRAND_ID,
      eventType: 'tweet_thread_reply',
      userEmail: userIdentifier,
      metadata: {
        platform: 'twitter',
        twitter_user_id: userId,
        tweet_id: participant.tweetId,
        conversation_id: participant.conversationId,
        streak_multiplier: streakResult.multiplier,
        current_streak: streakResult.currentStreak
      }
    });

    if (rewardResult.success) {
      // Mark as processed (per conversation, so user can participate in multiple threads)
      await env.TWITTER_BOT_KV.put(processedKey, '1', {
        expirationTtl: 60 * 60 * 24 * 7 // 7 days
      });
      return { processed: true, success: true };
    }

    return { processed: true, success: false };

  } catch (error) {
    console.error('Error processing thread participant:', error);
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
