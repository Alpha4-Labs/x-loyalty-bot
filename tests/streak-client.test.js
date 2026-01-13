import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordTwitterEngagement } from '../src/services/streak-client.js';

describe('StreakClient', () => {
  let env;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    env = {
      BRAND_ID: 'test-brand',
      SHARED_SERVICES_URL: 'https://services.loyalteez.app'
    };
    
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('recordTwitterEngagement', () => {
    it('should successfully record engagement and return streak data', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          multiplier: 1.5,
          currentStreak: 5,
          success: true
        })
      };
      global.fetch.mockResolvedValue(mockResponse);

      const result = await recordTwitterEngagement(env, '123456', 'tweet_like');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://services.loyalteez.app/streak/record-activity',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brandId: 'test-brand',
            userIdentifier: 'twitter_123456@loyalteez.app',
            platform: 'twitter',
            streakType: 'engagement'
          })
        })
      );

      expect(result.success).toBe(true);
      expect(result.multiplier).toBe(1.5);
      expect(result.currentStreak).toBe(5);
    });

    it('should use custom shared services URL when provided', async () => {
      env.SHARED_SERVICES_URL = 'https://custom.services.com';
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ multiplier: 1.0, currentStreak: 0 })
      };
      global.fetch.mockResolvedValue(mockResponse);

      await recordTwitterEngagement(env, '123456', 'tweet_like');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom.services.com/streak/record-activity',
        expect.any(Object)
      );
    });

    it('should return default values on API error', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal Server Error')
      };
      global.fetch.mockResolvedValue(mockResponse);

      const result = await recordTwitterEngagement(env, '123456', 'tweet_like');

      expect(result.success).toBe(false);
      expect(result.multiplier).toBe(1.0);
      expect(result.currentStreak).toBe(0);
    });

    it('should return default values on fetch error', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));

      const result = await recordTwitterEngagement(env, '123456', 'tweet_like');

      expect(result.success).toBe(false);
      expect(result.multiplier).toBe(1.0);
      expect(result.currentStreak).toBe(0);
    });

    it('should format user identifier correctly', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ multiplier: 1.0, currentStreak: 0 })
      };
      global.fetch.mockResolvedValue(mockResponse);

      await recordTwitterEngagement(env, '789012', 'tweet_reply');

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.userIdentifier).toBe('twitter_789012@loyalteez.app');
    });
  });
});
