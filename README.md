# EcoMerp Edge - Data Collection Service

Edge data collection service for the EcoMerp ERP system. Collects data from Amazon SP-API and Advertising API, then pushes it to the Core ERP database in real-time.

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Amazon SP-API     │────▶│                      │────▶│                 │
│   (Orders, Finance, │     │   Edge Host Service   │     │   Core ERP      │
│    Inventory, etc.) │     │                      │     │   (PostgreSQL)  │
├─────────────────────┤     │  - Rate Limiter      │     │                 │
│   Amazon Ads API    │────▶│  - Token Bucket      │────▶│  - Raw Data     │
│   (Campaigns, SP,   │     │  - Retry w/ Backoff  │     │  - Sync Monitor │
│    SB, SD Reports)  │     │  - Heartbeat         │     │  - Alerts       │
└─────────────────────┘     └──────────────────────┘     └─────────────────┘
```

## Quick Start

### 1. Register Edge Host in Core ERP

Go to Core ERP > Settings > Edge Hosts and register a new edge host. Copy the `Edge Host ID` and `API Key`.

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Install & Run

```bash
pnpm install
pnpm dev      # Development mode with hot reload
pnpm build    # Build for production
pnpm start    # Run production build
```

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `CORE_API_URL` | Core ERP API endpoint | Yes |
| `EDGE_HOST_ID` | Edge host ID from Core ERP | Yes |
| `EDGE_API_KEY` | Edge API key from Core ERP | Yes |
| `SP_API_CLIENT_ID` | Amazon SP-API LWA Client ID | For SP-API |
| `SP_API_CLIENT_SECRET` | Amazon SP-API LWA Client Secret | For SP-API |
| `SP_API_REFRESH_TOKEN` | Amazon SP-API LWA Refresh Token | For SP-API |
| `ADS_API_CLIENT_ID` | Amazon Ads API Client ID | For Ads API |
| `ADS_API_CLIENT_SECRET` | Amazon Ads API Client Secret | For Ads API |
| `ADS_API_REFRESH_TOKEN` | Amazon Ads API Refresh Token | For Ads API |
| `ADS_API_PROFILE_ID` | Amazon Ads API Profile ID | For Ads API |
| `SYNC_MODE` | `realtime` / `scheduled` / `manual` | No (default: scheduled) |
| `SYNC_CRON` | Cron expression for scheduled mode | No (default: `0 */6 * * *`) |

## Rate Limiting

The service implements token bucket rate limiting that respects Amazon's published limits:

### SP-API Rate Limits
| API | Rate (req/s) | Burst |
|-----|-------------|-------|
| Orders | 0.0167 | 20 |
| Finances | 0.5 | 30 |
| FBA Inventory | 2.0 | 30 |
| Catalog Items | 5.0 | 40 |
| Product Pricing | 0.5 | 1 |
| Sales | 0.5 | 15 |
| Reports | 0.0222 | 10 |

### Advertising API Rate Limits
| API | Rate (req/s) | Burst |
|-----|-------------|-------|
| Campaigns/AdGroups/Keywords/Targets | ~10 | 20 |
| Reporting | ~5 | 10 |

The service uses **50% of published limits** as conservative defaults and dynamically adjusts based on `x-amzn-RateLimit-Limit` response headers.

## Sync Modes

- **realtime**: Collects data every 30 minutes and pushes immediately
- **scheduled**: Runs on a cron schedule (default: every 6 hours)
- **manual**: Waits for trigger from Core ERP

## Data Flow

1. Edge service authenticates with Amazon APIs using LWA OAuth
2. Collectors fetch data with rate limiting and retry logic
3. Data is batched (100 records per push) and sent to Core ERP
4. Core ERP stores raw data in PostgreSQL with timestamps
5. Sync events are logged for monitoring

## Development

```bash
pnpm test     # Run tests
pnpm lint     # Type check
```

## Security

- All API credentials are stored in `.env` (never committed)
- Edge-to-Core communication uses API key authentication
- No secrets are hardcoded in source code
