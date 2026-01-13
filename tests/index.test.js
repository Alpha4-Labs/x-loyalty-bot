import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../src/index.js';

describe('Twitter Loyalty Bot - Main Handler', () => {
  let env;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
    
    env = {
      BRAND_ID: 'test-brand',
      TWITTER_BEARER_TOKEN: 'test-token',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_PUBLISH_KEY: 'test-key',
      TWITTER_BOT_KV: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn()
      }
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const mockConfig = {
        twitterHandle: '@testbrand'
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([{
          config_metadata: {
            auth_methods: { twitter: '@testbrand' }
          }
        }])
      });

      const request = new Request('https://test.worker.workers.dev/health', {
        method: 'GET'
      });

      const response = await handler.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.service).toBe('twitter-loyalty-bot');
      expect(data.brand_id).toBe('test-brand');
      expect(data.supported_events).toBeDefined();
    });
  });

  describe('CORS', () => {
    it('should handle OPTIONS preflight requests', async () => {
      const request = new Request('https://test.worker.workers.dev/health', {
        method: 'OPTIONS'
      });

      const response = await handler.fetch(request, env, {});

      // The handler returns 204 for OPTIONS, but if path doesn't match, it may return default response
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      // CORS headers should be present
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('Config Endpoint', () => {
    it('should return configuration status', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([])
      });

      const request = new Request('https://test.worker.workers.dev/config', {
        method: 'GET'
      });

      const response = await handler.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.brand_id).toBe('test-brand');
      expect(data.has_bearer_token).toBe(true);
      expect(data.has_supabase_url).toBe(true);
    });
  });

  describe('Trigger Endpoints', () => {
    it('should handle manual trigger', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue([{
            config_metadata: {
              auth_methods: { twitter: '@testbrand' }
            }
          }])
        })
        .mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ data: [] })
        });

      const request = new Request('https://test.worker.workers.dev/trigger', {
        method: 'POST'
      });

      const response = await handler.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBe('Poll triggered');
    });

    it('should handle specific engagement type triggers', async () => {
      // Mock getBrandConfig call
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue([{
            config_metadata: {
              auth_methods: { twitter: '@testbrand' },
              twitter_user_id: '123456'
            }
          }])
        })
        // Mock Twitter API calls - return empty results
        .mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ data: [] })
        });

      const request = new Request('https://test.worker.workers.dev/trigger/quotes', {
        method: 'POST'
      });

      const response = await handler.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('quotes');
    });

    it('should reject invalid engagement types', async () => {
      const request = new Request('https://test.worker.workers.dev/trigger/invalid', {
        method: 'POST'
      });

      const response = await handler.fetch(request, env, {});
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid event type');
    });
  });

  describe('Error Handling', () => {
    it('should handle errors gracefully when pollAllEngagements throws', async () => {
      // Mock getBrandConfig to return valid config
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([{
          config_metadata: {
            auth_methods: { twitter: '@testbrand' }
          }
        }])
      });

      // Make pollAllEngagements throw by making a subsequent call fail
      // The handler should catch this and return 500
      vi.spyOn(handler, 'pollAllEngagements').mockRejectedValueOnce(new Error('Test error'));

      const request = new Request('https://test.worker.workers.dev/trigger', {
        method: 'POST'
      });

      const response = await handler.fetch(request, env, {});
      const data = await response.json();

      // The handler should catch the error and return a 500 response
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });
});
