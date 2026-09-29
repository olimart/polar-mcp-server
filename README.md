# Polar MCP Server

An MCP (Model Context Protocol) server for the Polar AccessLink API. Connect your Polar fitness data to Claude AI - access workouts, sleep analysis, recovery metrics, heart rate data, and more.

This fork ([olimart/polar-mcp-server](https://github.com/olimart/polar-mcp-server)) adds AccessLink push webhooks and a durable D1 archive so new training sessions are kept after AccessLink's ~30-day window. MCP tools stay pull-based. The archive is the long-term store.

## Quick Start (Public Instance)

**No setup required!** Use our hosted instance:

1. In Claude: **Settings → Integrations → Add MCP Server**
2. Enter the URL: `https://polar-mcp-server.yafoy.workers.dev/mcp`
3. Claude will open an authorization window — log in with your Polar account
4. Start chatting about your fitness data!

## Features

### Tools

The Worker exposes 28 tools (the local stdio server exposes the original 25; archive tools need D1).

| Category | Tools | Description |
|----------|-------|-------------|
| **Exercises** | `get_exercises`, `get_exercise` | Training data with HR, speed, zones |
| **Exercise Export** | `get_exercise_fit`, `get_exercise_tcx`, `get_exercise_gpx` | Export in FIT, TCX, GPX formats |
| **Sleep** | `get_sleep`, `get_sleep_range` | Sleep stages, score, duration |
| **Recovery** | `get_nightly_recharge`, `get_nightly_recharge_range` | ANS charge, HRV, breathing rate |
| **Activity** | `get_daily_activity`, `get_daily_activity_range`, `get_activity_samples`, `get_activity_samples_range` | Steps, calories, activity zones |
| **Heart Rate** | `get_continuous_heart_rate`, `get_continuous_heart_rate_range` | 24/7 heart rate monitoring |
| **Training Load** | `get_cardio_load`, `get_cardio_load_range`, `get_cardio_load_history` | TRIMP, acute/chronic load |
| **SleepWise** | `get_sleepwise_alertness`, `get_sleepwise_circadian_bedtime` | Alertness predictions, optimal bedtime |
| **Biosensing** | `get_body_temperature`, `get_skin_temperature`, `get_spo2` | Temperature, SpO2 data |
| **User** | `get_user_info`, `get_physical_info` | Profile, VO2max, resting HR |
| **Archive** | `list_archived_events`, `get_archived_event`, `get_webhook_registration` | Webhook archive and registration status (Worker only) |

### Supported Devices

- Polar Pacer / Pacer Pro
- Polar Vantage V2 / V3
- Polar Vantage M / M2
- Polar Grit X / Grit X Pro / Grit X2 Pro
- Polar Ignite / Ignite 2 / Ignite 3
- Polar Unite
- And more...

## Example Prompts

Once connected, ask Claude:

- "Show me my workouts from last week"
- "How was my sleep last night? Compare it to my weekly average"
- "Analyze my heart rate variability trends"
- "What's my current training load status?"
- "When should I go to bed tonight for optimal recovery?"
- "Export my last run as a GPX file"
- "How many steps did I take this month?"
- "List archived runs from before AccessLink's 30-day window"

## Self-Hosting

Want to run your own instance? Two deployment options available:

### Option 1: Cloudflare Workers (Recommended)

#### Prerequisites

- [Cloudflare](https://cloudflare.com) account
- [Polar AccessLink](https://admin.polaraccesslink.com/) API credentials

#### Setup

```bash
# Clone and install
git clone https://github.com/olimart/polar-mcp-server.git
cd polar-mcp-server
npm install

# Create KV namespace
npx wrangler kv namespace create OAUTH_KV
# Copy the ID to wrangler.toml

# Create the D1 archive and apply the schema
npx wrangler d1 create polar-archive
# Copy database_id into wrangler.toml (binding ARCHIVE_DB)
npm run db:migrate

# Set secrets
npx wrangler secret put POLAR_CLIENT_ID
npx wrangler secret put POLAR_CLIENT_SECRET

# Deploy before registering the webhook (Polar PINGs the URL during create)
npm run deploy
```

After deploying, add the callback URL to your Polar app:

```
https://YOUR-WORKER.workers.dev/callback
```

Then register the webhook. See [Webhook archive](#webhook-archive) below. The hosted worker uses `https://polar-mcp-server.yafoy.workers.dev`.

### Option 2: Local (Claude Desktop)

```bash
# Clone and build
git clone https://github.com/olimart/polar-mcp-server.git
cd polar-mcp-server
npm install && npm run build

# Get access token
export POLAR_CLIENT_ID="your_client_id"
export POLAR_CLIENT_SECRET="your_client_secret"
npm run auth
```

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "polar": {
      "command": "node",
      "args": ["/path/to/polar-mcp-server/dist/index.js"],
      "env": {
        "POLAR_ACCESS_TOKEN": "your_access_token"
      }
    }
  }
}
```

## Webhook archive

AccessLink only returns exercises uploaded **after** the user registered with this client, and the pull API keeps them for about 30 days. Webhooks are how new sessions are copied into D1 before that window closes. This does **not** import older history.

Polar allows **one webhook per client**. `signature_secret_key` is returned only when the webhook is created. Store it as a Worker secret. Do not commit it.

### 1. Database

```bash
npx wrangler d1 create polar-archive
```

Paste the printed `database_id` into `wrangler.toml` under `[[d1_databases]]` (`binding = "ARCHIVE_DB"`). The placeholder `00000000-0000-0000-0000-000000000000` will not deploy.

```bash
# Remote (production)
npm run db:migrate

# Local wrangler dev
npm run db:migrate:local
```

Schema lives in `migrations/0001_init_archive.sql`. Rows are keyed by Polar user, event, and entity id (exercise id, or the calendar date for daily events).

### 2. Deploy the receiver first

`POST /webhook` must answer Polar's `PING` with HTTP 200 before create will succeed. `PING` during creation happens **before** the signature secret exists, so an unsigned `PING` is accepted only while `POLAR_WEBHOOK_SIGNATURE_SECRET` is unset. Every later request, including `PING` on URL change or activate, must carry a valid `Polar-Webhook-Signature` (HMAC-SHA256 of the raw body, hex).

`POST /polar/webhook` is the same handler.

### 3. Register with Polar

`WEBHOOK_BASE_URL` defaults to `https://polar-mcp-server.yafoy.workers.dev` (also set in `wrangler.toml`). Override it when registering another worker. The registered URL is `${WEBHOOK_BASE_URL}/webhook`.

Default events are `EXERCISE` and `ACTIVITY_SUMMARY`. Other AccessLink types can be subscribed without a code change when the payload includes a `url` on `www.polaraccesslink.com`: `SLEEP`, `CONTINUOUS_HEART_RATE`, `SLEEP_WISE_ALERTNESS`, `SLEEP_WISE_CIRCADIAN_BEDTIME`, `PHYSICAL_INFORMATION`.

```bash
export POLAR_CLIENT_ID="your_client_id"
export POLAR_CLIENT_SECRET="your_client_secret"
export WEBHOOK_BASE_URL="https://polar-mcp-server.yafoy.workers.dev"   # optional

# Prints the signature secret once. Copy it into the Worker secret.
npm run webhook:register

# Or let wrangler read the secret from stdin (nothing is written to disk):
npm run webhook:register -- --set-secret

npm run webhook:status
```

Other flags: `--events EXERCISE,ACTIVITY_SUMMARY`, `--url https://.../webhook`, `--update` (PATCH the existing webhook; a URL change triggers another PING), `--activate`.

Users who connected **before** this token copy was stored need to open the MCP app once more. The callback writes `polar_token:{userId}` into `OAUTH_KV` (no TTL; Polar access tokens do not expire). Until that exists, the notification is still saved with status `missing_token` and is fetched after the next successful connect.

### What the worker does

1. Verify the signature (or accept the one-time unsigned PING).
2. Reject bad signatures (401) and rate-limit repeated failures per IP.
3. Insert the notification into D1 **before** responding, so a crash does not drop the event.
4. Respond `200` quickly.
5. Fetch the entity with the user's token. Exercises are loaded with `samples` and `zones`, plus FIT, TCX, and GPX when Polar has them. Hostile or non-AccessLink URLs are not fetched.
6. A cron every 15 minutes retries `pending` and `failed` rows for about two hours. Terminal 401/403/404 responses are not retried until the user connects again.

Large exercise samples that would blow past D1's row limit are omitted. The summary and any export that still fits are kept. `exports_json` records what was stored or skipped.

### MCP tools

These read D1 for the authenticated Polar user. They are registered on the Worker only.

| Tool | Purpose |
|------|---------|
| `list_archived_events` | Recent archived rows. `event` defaults to `EXERCISE`. |
| `get_archived_event` | One row plus JSON payload. Samples/exports are opt-in. |
| `get_webhook_registration` | Client webhook id, URL, events, and active flag. No signature secret. |

### Tests and local dry-run

CI cannot call Polar. `npm test` covers HMAC verification, payload parsing, the D1 SQL (via `node:sqlite` and `migrations/0001_init_archive.sql`), PING, bad signatures, exercise fetch + persist, missing tokens, and URL allowlisting.

Unsigned PING against a local worker (secret unset):

```bash
npm run db:migrate:local
npm run dev:worker
curl -i -X POST http://localhost:8787/webhook \
  -H 'Content-Type: application/json' \
  -H 'Polar-Webhook-Event: PING' \
  -d '{"event":"PING","timestamp":"2019-01-11T08:25:10.02Z"}'
```

Expect `HTTP/1.1 200`. After the signature secret is set, that unsigned PING returns 401. Sign the exact raw body with HMAC-SHA256, as in `test/webhook.test.ts`.

## API Reference

All tools use the [Polar AccessLink API v3](https://www.polar.com/accesslink-api/).

| Tool | Endpoint | Description |
|------|----------|-------------|
| `get_user_info` | `/users/{id}` | User profile |
| `get_physical_info` | `/users/physical-information` | VO2max, max HR, resting HR |
| `get_exercises` | `/exercises` | Last 30 days of workouts |
| `get_exercise` | `/exercises/{id}` | Single workout details |
| `get_exercise_fit/tcx/gpx` | `/exercises/{id}/fit\|tcx\|gpx` | Export formats |
| `get_sleep` | `/users/sleep` | Sleep data |
| `get_nightly_recharge` | `/users/nightly-recharge` | Recovery metrics |
| `get_daily_activity` | `/users/activities` | Daily activity |
| `get_continuous_heart_rate` | `/users/continuous-heart-rate` | 24/7 HR |
| `get_cardio_load` | `/users/cardio-load` | Training load |
| `get_sleepwise_alertness` | `/users/sleepwise/alertness` | Alertness predictions |
| `get_body_temperature` | `/users/biosensing/bodytemperature` | Body temp |
| `get_spo2` | `/users/biosensing/spo2` | Blood oxygen |

## Troubleshooting

| Error | Solution |
|-------|----------|
| "Polar API error (403)" | Re-authorize or check if data sync is complete |
| "Polar API error (404)" | Endpoint not available for your device/subscription |
| No exercise data | Sync your Polar device to Polar Flow app first. AccessLink has no workouts from before you registered with this app. |
| Webhook create fails | Deploy first. `POST /webhook` must return 200 for Polar's PING. |
| Archived `missing_token` | Connect the MCP app again so the Worker can store that user's Polar access token. |
| Webhook 401 | `POLAR_WEBHOOK_SIGNATURE_SECRET` must be the key returned when the webhook was created. |

## Privacy

- Polar passwords are never stored
- OAuth tokens are stored in `OAUTH_KV`: by the Workers OAuth provider for MCP sessions, and as `polar_token:{userId}` so webhooks can fetch new data. Tokens are not written to logs.
- The webhook signing key is a Worker secret (`POLAR_WEBHOOK_SIGNATURE_SECRET`). It is not in git.
- Archived fitness data (exercise JSON and optional FIT/TCX/GPX) is stored in the operator's D1 database `ARCHIVE_DB`. That is the point of the archive.
- Each user can only read their own archived rows through MCP
- Webhook handlers do not log tokens, signature secrets, or raw payloads

## Contributing

Contributions welcome! Please open an issue or PR.

## License

MIT

## Links

- [Polar AccessLink API](https://www.polar.com/accesslink-api/)
- [Polar Developer Portal](https://admin.polaraccesslink.com/)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Cloudflare Workers](https://workers.cloudflare.com/)
