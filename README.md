# Twitter/X Loyalty Bot 🐦

A serverless Twitter integration built on Cloudflare Workers that rewards community engagement with LTZ tokens via the Loyalteez platform.

## Features

- **Serverless Architecture**: Runs entirely on Cloudflare Workers (no paid VPS required).
- **Automatic Polling**: Scheduled triggers check for new engagements (hourly on free tier, more frequent on paid).
- **Multi-Engagement Support**: Rewards users for mentions, replies, likes, and retweets.
- **Smart Deduplication**: High water mark + KV storage ensures each engagement is only rewarded once.
- **Partner Portal Integration**: Twitter handle configured in Partner Portal (single source of truth).
- **Instant Rewards**: Calls Loyalteez Event Handler to mint tokens upon detection.

## Supported Engagement Types

| Event Type | Description | Status | API Tier Required |
|------------|-------------|--------|-------------------|
| `tweet_mention` | User mentions @YourBrand in a tweet | ✅ Implemented | Basic ($100/mo) |
| `tweet_reply` | User replies to your tweets | ✅ Implemented | Basic ($100/mo) |
| `tweet_like` | User likes your tweets | ✅ Implemented | Pro ($5,000/mo)* |
| `tweet_retweet` | User retweets your content | ✅ Implemented | Pro ($5,000/mo)* |

> **\*** Likes and retweets require Twitter API Pro tier OR OAuth 2.0 User Context authentication. The Basic tier will gracefully skip these with an informative error message.

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

> **⚠️ Free Tier Limitations**: The free tier is very restrictive - only **1 request per 15 minutes** and **100 tweets/month**. Use daily polling on free tier. For production use, consider Basic tier ($100/month) which allows 10,000 tweets/month.

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

The bot will automatically start polling according to your configured schedule.

### 8. Configure Events in Partner Portal

1. Go to **Partner Portal** → **Settings** → **Points Distribution**.
2. Click **Add Event** and select Twitter events:
   - **Tweet Mention** - Rewards for @mentions
   - **Tweet Reply** - Rewards for replies to your tweets
   - **Tweet Like** - Rewards for likes (Pro tier)
   - **Tweet Retweet** - Rewards for retweets (Pro tier)
3. Configure reward amounts, cooldowns, and limits for each event.
4. Save the configuration.

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Twitter API    │────▶│  Cloudflare      │────▶│  Loyalteez      │
│  (Engagements)  │     │  Worker (Cron)   │     │  Event Handler  │
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

### Polling Flow

1. **Cron Trigger**: Worker wakes up at scheduled interval.
2. **Load Config**: Fetches Twitter handle from Supabase (Partner Portal).
3. **Fetch Engagements**: Queries Twitter API for each engagement type:
   - **Mentions**: Search API with `@handle` query
   - **Replies**: Search API with `to:handle is:reply` query
   - **Likes**: User lookup on brand's tweets (Pro tier)
   - **Retweets**: User lookup on brand's tweets (Pro tier)
4. **Deduplication**: Skips already-processed engagements using KV store.
5. **Reward**: Sends event to Loyalteez Event Handler for token minting.
6. **Record**: Updates high water mark and stores engagement ID in KV.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and available endpoints |
| `/health` | GET | Health check with config status |
| `/config` | GET | Debug endpoint showing configuration |
| `/trigger` | POST | Poll all engagement types |
| `/trigger/mentions` | POST | Poll mentions only |
| `/trigger/replies` | POST | Poll replies only |
| `/trigger/likes` | POST | Poll likes only (Pro tier) |
| `/trigger/retweets` | POST | Poll retweets only (Pro tier) |
| `/reset` | POST | Reset all high water marks (start fresh) |

### Example: Manual Trigger (All Engagements)

```bash
curl -X POST https://your-worker.workers.dev/trigger
```

### Example: Trigger Specific Type

```bash
# Poll only mentions
curl -X POST https://your-worker.workers.dev/trigger/mentions

# Poll only replies
curl -X POST https://your-worker.workers.dev/trigger/replies
```

### Example: Reset High Water Marks

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

### Test Each Engagement Type

**Mentions:**
1. Configure your Twitter handle in Partner Portal.
2. Have a test account tweet: `"Testing @YourBrand integration!"`
3. Trigger manually: `curl -X POST https://your-worker.workers.dev/trigger/mentions`

**Replies:**
1. Post a tweet from your brand account.
2. Have a test account reply to that tweet.
3. Trigger manually: `curl -X POST https://your-worker.workers.dev/trigger/replies`

**Likes (Pro tier):**
1. Post a tweet from your brand account.
2. Have a test account like that tweet.
3. Trigger manually: `curl -X POST https://your-worker.workers.dev/trigger/likes`

**Retweets (Pro tier):**
1. Post a tweet from your brand account.
2. Have a test account retweet that tweet.
3. Trigger manually: `curl -X POST https://your-worker.workers.dev/trigger/retweets`

### First Run Behavior

On first deployment (no high water mark), the bot will:
- Process only the **3 most recent engagements** of each type (to avoid mass-processing old content)
- Set high water marks for future polls
- Subsequent polls only fetch engagements newer than the high water marks

## Customization

### Change Poll Frequency

Edit `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]  # Every 5 minutes
```

> **Warning**: More frequent polling consumes Twitter API quota faster.

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
│   ├── index.js          # Single-tenant worker (all engagement types)
│   └── router.js         # Multi-tenant router (for platform deployment)
├── wrangler.toml         # Your config (gitignored)
├── wrangler.router.toml  # Multi-tenant router config
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

### "403 - Elevated API access required"
- Likes and retweets tracking requires Twitter API Pro tier ($5,000/mo)
- Alternatively, implement OAuth 2.0 User Context authentication
- Basic tier ($100/mo) supports mentions and replies only

### No rewards appearing
- Verify `BRAND_ID` matches your Partner Portal wallet
- Check that the appropriate event type is configured in Partner Portal
- View logs with `npx wrangler tail`

### High water mark issues
- Use `POST /reset` to clear all high water marks
- Next poll will be treated as first run (processes 3 most recent engagements per type)

## Security Notes

- **Never commit** `wrangler.toml` with real values (it's gitignored)
- Use `wrangler.example.toml` as a template
- Store secrets via `npx wrangler secret put`
- The `.gitignore` excludes sensitive files

## Rate Limits & Costs

| Twitter API Tier | Monthly Cost | Requests/15min | Monthly Tweets | Supported Features | Recommended Polling |
|------------------|--------------|----------------|----------------|-------------------|---------------------|
| **Free** | $0 | **1** | **100** | Mentions only | Daily (`0 12 * * *`) |
| **Basic** | $100/mo | 10 | 10,000 | Mentions, Replies | Every 15 min (`*/15 * * * *`) |
| **Pro** | $5,000/mo | 450 | 1,000,000 | All features | Every 5 min |

> **⚠️ Important**: The free tier is extremely limited. With only 1 request per 15 minutes and 100 tweets/month, use **daily polling** to avoid rate limits. For production, upgrade to Basic tier minimum.

### API Endpoint Requirements

| Endpoint | Tier Required | Notes |
|----------|---------------|-------|
| `GET /2/tweets/search/recent` | Basic | Mentions & Replies |
| `GET /2/users/by/username/:username` | Basic | User ID lookup |
| `GET /2/users/:id/tweets` | Basic | Brand's recent tweets |
| `GET /2/tweets/:id/liking_users` | Pro | Like tracking |
| `GET /2/tweets/:id/retweeted_by` | Pro | Retweet tracking |

## Architecture Options

### Single-Tenant (index.js)
- One worker per brand
- Simpler setup for individual deployments
- Uses `wrangler.toml` for configuration

### Multi-Tenant Router (router.js)
- Single worker handles ALL brands
- Uses subdomain-based routing: `{brand}.loyalteez.app`
- Credentials stored encrypted in KV
- Uses `wrangler.router.toml` for configuration

## Related Documentation

- [Loyalteez Developer Docs](https://developer.loyalteez.app)
- [Twitter API v2 Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [Twitter API Access Levels](https://developer.twitter.com/en/docs/twitter-api/getting-started/about-twitter-api)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)

## License

MIT
