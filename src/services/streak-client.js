/**
 * Streak Service Client
 * 
 * Client for calling the shared streak service API
 */

export async function recordTwitterEngagement(env, twitterUserId, engagementType) {
  const userIdentifier = `twitter_${twitterUserId}@loyalteez.app`;
  const sharedServicesUrl = env.SHARED_SERVICES_URL || 'https://services.loyalteez.app';
  
  try {
    const response = await fetch(`${sharedServicesUrl}/streak/record-activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandId: env.BRAND_ID,
        userIdentifier,
        platform: 'twitter',
        streakType: 'engagement'
      })
    });
    
    if (response.ok) {
      const streakData = await response.json();
      return {
        multiplier: streakData.multiplier || 1.0,
        currentStreak: streakData.currentStreak || 0,
        success: true
      };
    } else {
      const errorText = await response.text();
      console.error('Streak service error:', response.status, errorText);
    }
  } catch (error) {
    console.error('Error calling streak service:', error);
  }
  
  // Return default values on error
  return { multiplier: 1.0, currentStreak: 0, success: false };
}
