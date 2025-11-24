# Twitter/X Loyalty Bot 🐦

A serverless Twitter integration built on Cloudflare Workers that rewards community engagement with LTZ tokens via the Loyalteez platform.

## Features

- **Serverless Architecture**: Runs entirely on Cloudflare Workers (no paid VPS required).
- **Automatic Polling**: Scheduled triggers check for new engagements every 15 minutes.
- **Mention Tracking**: Rewards users who mention your brand's Twitter handle.
- **Deduplication**: KV storage ensures each tweet is only rewarded once.
- **Instant Rewards**: Calls Loyalteez Event Handler to mint tokens upon detection.

## Current Engagement Types

| Event Type | Description | Status |
|------------|-------------|--------|
| `tweet_mention` | User mentions @YourBrand in a tweet | ✅ Implemented |
| `tweet_reply` | User replies to your tweets | 🚧 Planned |
| `tweet_like` | User likes your tweets | 🚧 Planned (requires elevated API) |
| `tweet_retweet` | User retweets your content | 🚧 Planned (requires elevated API) |

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Cloudflare Account](https://dash.cloudflare.com/)
- [Twitter Developer Account](https://developer.twitter.com/en/portal/dashboard) (Basic tier minimum)
- Loyalteez Brand ID (from Partner Portal)

## Setup Guide

### 1. Install Dependencies

```bash
npm install
```

### 2. Get Twitter API Credentials

1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard).
2. Create a new Project and App.
3. Navigate to **Keys and Tokens**.
4. Generate a **Bearer Token** (easiest for read-only operations).
5. Copy the Bearer Token securely.

> **Note**: Basic (Free) tier allows 10,000 tweet reads/month. For higher volume, consider Pro tier.

### 3. Create KV Namespace

```bash
npx wrangler kv:namespace create TWITTER_BOT_KV
```

Copy the `id` from the output for the next step.

### 4. Configuration

Copy the example config:

```bash
cp wrangler.example.toml wrangler.toml
```

Update `wrangler.toml` with your details:

```toml
[[kv_namespaces]]
binding = "TWITTER_BOT_KV"
id = "your_kv_namespace_id_from_step_3"

[vars]
BRAND_ID = "0xYourWalletAddress"
TWITTER_HANDLE = "YourBrandHandle"  # without @
```

### 5. Set Secrets

**⚠️ NEVER commit secrets to git!**

```bash
npx wrangler secret put TWITTER_BEARER_TOKEN
# Paste your Bearer Token when prompted
```

### 6. Deploy

```bash
npm run deploy
```

The bot will automatically start polling every 15 minutes.

### 7. Configure Events in Partner Portal

1. Go to **Partner Portal** → **Settings** → **Points Distribution**.
2. Click **Add Event** and select **Tweet Mention** (or other Twitter events).
3. Configure reward amount, cooldowns, and limits.
4. Save the configuration.

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Twitter API    │────▶│  Cloudflare      │────▶│  Loyalteez      │
│  (Mentions)     │     │  Worker (Cron)   │     │  Event Handler  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  KV Store        │
                        │  (Deduplication) │
                        └──────────────────┘
```

1. **Cron Trigger** (every 15 mins): Worker wakes up.
2. **Fetch Mentions**: Queries Twitter API for recent mentions of your handle.
3. **Deduplication**: Checks KV store to skip already-processed tweets.
4. **Reward**: Sends event to Loyalteez Event Handler for token minting.
5. **Record**: Stores tweet ID in KV to prevent duplicate rewards.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BRAND_ID` | Your Loyalteez wallet address | Yes |
| `TWITTER_HANDLE` | Twitter handle to monitor (without @) | Yes |
| `LOYALTEEZ_API_URL` | API endpoint | Yes |
| `TWITTER_BEARER_TOKEN` | Twitter API Bearer Token (Secret) | Yes |

## Testing

### Manual Trigger

Visit your worker URL to verify it's running:

```
https://twitter-loyalty-bot.yourname.workers.dev
```

### View Logs

```bash
npx wrangler tail
```

This streams real-time logs from your worker.

### Test with a Mention

1. Have a test account tweet: `"Testing @YourBrand integration!"`
2. Wait for the next cron run (up to 15 mins) or trigger manually.
3. Check logs for processing confirmation.

## Customization

### Change Poll Frequency

Edit `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]  # Every 5 minutes
```

> **Warning**: More frequent polling consumes API quota faster.

### Add Custom Event Types

Edit `src/index.js` to add new detection logic:

```javascript
// Example: Detect quote tweets
const quoteTweets = await roClient.v2.search(`url:twitter.com/${handle}`, {...});
```

## Project Structure

```
twitter-loyalty-bot/
├── src/
│   └── index.js          # Main worker logic
├── wrangler.toml         # Your config (gitignored)
├── wrangler.example.toml # Template config
├── package.json
└── README.md
```

## Troubleshooting

### "Twitter API secrets not configured"
- Ensure you've run `wrangler secret put TWITTER_BEARER_TOKEN`

### "User not found"
- Verify `TWITTER_HANDLE` is correct (without @)
- Check that the account is public

### "Rate limit exceeded"
- Twitter Basic tier has 10,000 reads/month
- Consider reducing poll frequency or upgrading tier

### No rewards appearing
- Verify `BRAND_ID` matches your Partner Portal wallet
- Check that `tweet_mention` event is configured in Partner Portal
- View logs with `wrangler tail`

## Security Notes

- **Never commit** `wrangler.toml` with real secrets
- Use `wrangler.example.toml` as a template
- Store secrets via `wrangler secret put`
- The `.gitignore` excludes sensitive files

## Related Documentation

- [Loyalteez Developer Docs](https://developer.loyalteez.app)
- [Twitter API v2 Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)

## License

MIT
