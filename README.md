# Twitter Loyalty Bot 🐦

A Cloudflare Worker integration for Loyalteez that rewards users for engaging with your brand on X (Twitter).

## Features

- **Engagement Tracking**: Monitors mentions (replies/tags) of your brand handle.
- **Auto-Reward**: Automatically triggers LTZ token rewards via the Loyalteez Event Handler.
- **Deduplication**: Uses KV storage to ensure each tweet is rewarded only once.
- **Serverless**: Runs on Cloudflare Workers with Scheduled Triggers (Cron).

## Setup

1. **Create X Developer Account**:
   - Get your API Key, Secret, and Bearer Token from the [Twitter Developer Portal](https://developer.twitter.com/).
   - Ensure you have Basic Access (v2 API) enabled.

2. **Configure Secrets**:
   ```bash
   wrangler secret put TWITTER_API_KEY
   wrangler secret put TWITTER_API_SECRET
   wrangler secret put TWITTER_BEARER_TOKEN
   # Optional (if performing user actions):
   # wrangler secret put TWITTER_ACCESS_TOKEN
   # wrangler secret put TWITTER_ACCESS_SECRET
   ```

3. **Create KV Namespace**:
   ```bash
   wrangler kv:namespace create "TWITTER_BOT_KV"
   # Update wrangler.toml with the ID returned
   ```

4. **Deploy**:
   ```bash
   npm install
   npm run deploy
   ```

5. **Configure Custom Domain** (Optional):
   - The worker is configured to use `x-demo.loyalteez.app` as a custom domain.
   - Ensure DNS A/AAAA records are configured in Cloudflare Dashboard.
   - The route is automatically configured via `wrangler.toml`.

## Configuration

- `TWITTER_HANDLE`: The brand handle to monitor (without @).
- `BRAND_ID`: Your Loyalteez Brand Wallet Address.
- `EVENT_HANDLER`: Service binding to the main Loyalteez Event Handler worker.

## How it Works

1. **Scheduled Polling**: Every 15 minutes, the worker wakes up.
2. **Search**: It queries the Twitter API for recent mentions of `@YourBrand`.
3. **Filter**: It checks KV storage to see if the tweet ID has already been processed.
4. **Reward**: If new, it sends an event to the `loyalteez-event-handler` service.
5. **Record**: The tweet ID is saved to KV to prevent double-spending.
