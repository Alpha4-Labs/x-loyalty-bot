# Twitter/X Loyalty Bot 🐦

A serverless Twitter integration built on Cloudflare Workers that rewards community engagement with LTZ tokens via the Loyalteez platform.

## Features

- **Serverless Architecture**: Runs entirely on Cloudflare Workers (no paid VPS required).
- **Automatic Polling**: Scheduled triggers check for new engagements every 15 minutes.
- **Mention Tracking**: Rewards users who mention your brand's Twitter handle.
- **Smart Deduplication**: High water mark + KV storage ensures each tweet is only rewarded once.
- **Partner Portal Integration**: Twitter handle configured in Partner Portal (single source of truth).
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

> **Note**: Basic (Free) tier allows ~10,000 tweet reads/month and 10 requests per 15-minute window. For higher volume, consider Pro tier ($100/month).

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
```

### 5. Set Secrets

**⚠️ NEVER commit secrets to git!**

```bash
# Twitter Bearer Token (from step 2)
npx wrangler secret put TWITTER_BEARER_TOKEN

# Supabase key (get from Loyalteez team)
npx wrangler secret put SUPABASE_PUBLISH_KEY
```

### 6. Configure Twitter Handle in Partner Portal

1. Go to **Partner Portal** → **Settings** → **Profile**.
2. In the **Authentication Methods** section, find **Twitter**.
3. Enter your Twitter handle (without @).
4. Save the configuration.

> **Important**: The Twitter handle is read from Partner Portal, not from environment variables. This ensures a single source of truth.

### 7. Deploy

```bash
npm run deploy
```

The bot will automatically start polling every 15 minutes.

### 8. Configure Events in Partner Portal

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
        │                       │                        │
        │                       ▼                        │
        │               ┌──────────────────┐             │
        │               │  KV Store        │             │
        │               │  (Deduplication) │             │
        │               └──────────────────┘             │
        │                       │                        │
        │                       ▼                        │
        │               ┌──────────────────┐             │
        └──────────────▶│  Supabase        │◀────────────┘
                        │  (Config)        │
                        └──────────────────┘
```

1. **Cron Trigger** (every 15 mins): Worker wakes up.
2. **Load Config**: Fetches Twitter handle from Supabase (Partner Portal).
3. **Fetch Mentions**: Queries Twitter API for mentions since last poll (high water mark).
4. **Deduplication**: Skips already-processed tweets using KV store.
5. **Reward**: Sends event to Loyalteez Event Handler for token minting.
6. **Record**: Updates high water mark and stores tweet ID in KV.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and available endpoints |
| `/health` | GET | Health check with config status |
| `/config` | GET | Debug endpoint showing configuration |
| `/trigger` | POST | Manually trigger a poll (for testing) |
| `/reset` | POST | Reset high water mark (start fresh) |

### Example: Manual Trigger

```bash
curl -X POST https://your-worker.workers.dev/trigger
```

### Example: Reset High Water Mark

```bash
curl -X POST https://your-worker.workers.dev/reset
```

## Environment Variables

| Variable | Description | Required | Where to Set |
|----------|-------------|----------|--------------|
| `BRAND_ID` | Your Loyalteez wallet address | Yes | wrangler.toml |
| `LOYALTEEZ_API_URL` | API endpoint | Yes | wrangler.toml |
| `SUPABASE_URL` | Supabase instance URL | Yes | wrangler.toml |
| `TWITTER_BEARER_TOKEN` | Twitter API Bearer Token | Yes | Secret |
| `SUPABASE_PUBLISH_KEY` | Supabase public key | Yes | Secret |

> **Note**: Twitter handle is configured in Partner Portal, not here.

## Testing

### View Logs

```bash
npx wrangler tail
```

This streams real-time logs from your worker.

### Test with a Mention

1. Configure your Twitter handle in Partner Portal.
2. Have a test account tweet: `"Testing @YourBrand integration!"`
3. Either wait for the next cron run (up to 15 mins) or trigger manually:
   ```bash
   curl -X POST https://your-worker.workers.dev/trigger
   ```
4. Check logs for processing confirmation.

### First Run Behavior

On first deployment (no high water mark), the bot will:
- Process only the **3 most recent mentions** (to avoid mass-processing old tweets)
- Set a high water mark for future polls
- Subsequent polls only fetch tweets newer than the high water mark

## Customization

### Change Poll Frequency

Edit `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]  # Every 5 minutes
```

> **Warning**: More frequent polling consumes Twitter API quota faster (10 requests per 15 mins on Basic tier).

### Custom Domain

Add to `wrangler.toml`:

```toml
[[routes]]
pattern = "x-bot.your-domain.com/*"
zone_name = "your-domain.com"
```

## Project Structure

```
twitter-loyalty-bot/
├── src/
│   └── index.js          # Main worker logic
├── wrangler.toml         # Your config (gitignored)
├── wrangler.example.toml # Template config
├── package.json
├── .gitignore
└── README.md
```

## Troubleshooting

### "Twitter API secrets not configured"
- Ensure you've run `npx wrangler secret put TWITTER_BEARER_TOKEN`

### "Twitter handle not configured in Partner Portal"
- Go to Partner Portal → Settings → Profile → Twitter
- Enter your handle (without @) and save

### "No config found for brand"
- Verify `BRAND_ID` in wrangler.toml matches your Partner Portal wallet
- Ensure `SUPABASE_PUBLISH_KEY` secret is set correctly

### "Rate limit exceeded" (429 error)
- Twitter Basic tier has 10 requests per 15-minute window
- Wait 15 minutes for the rate limit to reset
- Consider reducing poll frequency or upgrading to Pro tier

### No rewards appearing
- Verify `BRAND_ID` matches your Partner Portal wallet
- Check that `tweet_mention` event is configured in Partner Portal
- View logs with `npx wrangler tail`

### High water mark issues
- Use `POST /reset` to clear the high water mark
- Next poll will be treated as first run (processes 3 most recent tweets)

## Security Notes

- **Never commit** `wrangler.toml` with real values (it's gitignored)
- Use `wrangler.example.toml` as a template
- Store secrets via `npx wrangler secret put`
- The `.gitignore` excludes sensitive files

## Rate Limits & Costs

| Twitter API Tier | Monthly Cost | Requests/15min | Monthly Reads |
|------------------|--------------|----------------|---------------|
| Basic (Free) | $0 | 10 | ~10,000 |
| Pro | $100 | 450 | ~500,000 |
| Enterprise | Custom | Custom | Custom |

For most brands, Basic tier is sufficient. Each poll uses ~2-3 requests (user lookup + search).

## Related Documentation

- [Loyalteez Developer Docs](https://developer.loyalteez.app)
- [Twitter API v2 Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)

## License

MIT
