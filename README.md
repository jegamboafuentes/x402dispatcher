# x402dispatcher

Local **x402 Bazaar Aggregator** for AI agents: discover paid APIs from the Coinbase x402 Bazaar, wrap them as Model Context Protocol (MCP) tools, settle micropayments from a CDP treasury wallet, and return the upstream data to the agent.

This repo is currently at **V8** (operator console). V7 cashflow ledger and V6 inbound paywall are live; use `X402_ENV` for Sepolia vs Base mainnet.

---

## Why this exists

AI agents are good at reasoning and tool use, but bad at paying for APIs. The [x402](https://x402.org) protocol turns HTTP `402 Payment Required` into a programmable stablecoin micropayment rail (typically USDC).

**x402dispatcher** sits in the middle as a solo-operator friendly aggregator:

| Idea | What it means |
|---|---|
| Discovery | Query the public Coinbase x402 Bazaar catalog |
| MCP integration | Expose discovered APIs as MCP tools for Cursor / agents |
| Dispatch | Sign and settle payment from a treasury wallet via `@coinbase/cdp-sdk` |
| Monetization | Apply a micro-markup on top of upstream cost and retain the spread |

Funds move on-chain (wallet → seller / Merchant). The platform does not custody buyer card data. Until V6, the **operator Treasury** funds outbound calls; after V6, **calling agents** pay inbound first.

---

## Roadmap

| Version | Status | Goal |
|---|---|---|
| **V1** | Done | Manually wrap one paid-style flow (MBTA demo + $0.01 USDC testnet settle) |
| **V2** | Done | Auto-discover Base Sepolia Bazaar APIs and wrap many as MCP tools with real x402 payment |
| **V3** | Done | Smart arbitrage: search, compare prices, pick cheapest API for a task (with failover) |
| **V4** | Done | Track success/latency; economy vs verified routing tiers |
| **V5** | Done | Cloud Run + `agent.json` + HTTP MCP; `X402_ENV` for Sepolia vs Base mainnet |
| **V6** | Done | **Inbound paywall** — calling agents pay Merchant before upstream proxy |
| **V7** | Done | Cashflow ledger (money in / out / markup) via API + MCP |
| **V8** | **Current (8.1)** | Operator monitoring UI (Linux console at `/`) + branding/SEO |
| **V9** | Planned | Custom domain for public MCP / Cloud Run (GCP + DNS) |
| **V10** | Planned | Registries, auth/rate limits, durable stats (beyond `/tmp`) |

You do **not** need a UI for agents — MCP + `agent.json` is the product surface. The UI at `/` is for **you** (operator monitoring).

---

## What V8 does

V8 adds a **Linux console–style operator dashboard** at `/`:

| Panel | Source |
|---|---|
| Wallets | `GET /v1/wallets` — Treasury + Merchant USDC/ETH on-chain balances |
| PnL | `GET /v1/pnl` — revenue / cogs / markup / gross profit |
| Recent settlements | `GET /v1/cashflow` — latest ledger rows |

Auto-refreshes every 5s. Credits in the footer: run by [metaverseprofessional.tech](https://metaverseprofessional.tech/), developed by [enriquegamboa.info](https://enriquegamboa.info/).

```bash
npm run test:v8
```

Open locally: `http://127.0.0.1:8080/` (with `npm run start:http`).

---

## What V7 does

V7 persists a **cashflow ledger** so you can audit solo-business money movement:

| Direction | Meaning |
|---|---|
| `in` | Calling agent → Merchant (inbound x402) |
| `out` | Treasury → upstream seller |
| `markup` | Treasury → Merchant (spread transfer) |

Tools (free / operator): `get_cashflow`, `get_pnl`. HTTP: `GET /v1/cashflow`, `GET /v1/pnl`.

Stored under `DATA_DIR/cashflow.json` (local `data/`, Cloud Run `/tmp/...` unless you mount durable storage).

```bash
npm run test:v7
```

---

## What V6 does

Calling agents must pay **you** (Merchant) before the proxy spends Treasury:

| Tool | Free / Paid |
|---|---|
| `quote_route`, `search_bazaar`, `list_*`, `get_api_stats`, `get_paywall_status` | Free |
| `route_and_call`, `call_x402_api`, `get_mbta_predictions`, dynamic Bazaar tools | **Paid inbound** |

Flow:

1. Agent calls a paid tool
2. Server challenges with x402 (price = `INBOUND_PRICE_USD`, default `MAX_PRICE_USD`)
3. Agent settles USDC → **Merchant**
4. Proxy pays upstream from **Treasury** and returns data

Env:

```env
INBOUND_PAYWALL=true          # set false to disable (operator-only treasury spend)
INBOUND_PRICE_USD=0.01        # flat inbound fee (clamped to MAX_PRICE_USD)
X402_ENV=development|production
# X402_PAY_TO=0x...           # optional Merchant override
```

### Test V6 locally (Sepolia)

```bash
# terminal 1
$env:X402_ENV='development'; $env:INBOUND_PAYWALL='true'; npm run start:http

# terminal 2 — first run prints Buyer address; fund with Sepolia USDC
$env:X402_ENV='development'; $env:PUBLIC_BASE_URL='http://127.0.0.1:8080'; npm run test:v6
```

### Test V6 on production (real USDC)

```bash
$env:X402_ENV='production'; $env:PUBLIC_BASE_URL='https://YOUR-SERVICE.run.app'; npm run test:v6
```

Fund the printed **Buyer** CDP account with Base mainnet USDC. Expect: free `quote_route` OK, then paid `route_and_call` with inbound settlement + upstream weather.

---

## What V5 does

V5 exposes the same dispatcher over the public internet:

| Surface | Path |
|---|---|
| Operator console | `GET /` |
| Health | `GET /health` |
| Agent discovery | `GET /.well-known/agent.json` |
| MCP (Streamable HTTP) | `ALL /mcp` |
| Local stdio (Cursor) | `npm start` |

Deploy target: **GCP Cloud Run** project `experiment-jegf-personal`.

```bash
npm run start:http          # local HTTP on :8080
npm run deploy:gcp          # build + deploy to Cloud Run
$env:PUBLIC_BASE_URL='https://...run.app'; npm run test:v5
```

---

## What V4 does

On top of V3 routing, V4 records every paid call’s success and latency in `data/api-stats.json`, then offers two tiers:

| Tier | Behavior |
|---|---|
| `economy` | Cheapest first (V3 behavior) |
| `verified` | Only APIs with enough successful history; ranked by reliability/latency/price score |

Thresholds (env): `VERIFIED_MIN_SAMPLES` (default `2`), `VERIFIED_MIN_SUCCESS_RATE` (default `0.8`).

New tools: `get_api_stats`, `list_verified_apis`. `quote_route` / `route_and_call` accept optional `tier`.

---

## What V3 does

On top of V2 discovery + payment, V3 adds a router:

1. **`quote_route`** — search Bazaar for a natural-language task, rank candidates by **total price** (upstream + markup), return the plan **without paying**
2. **`route_and_call`** — same ranking, pay and call the cheapest; on failure, try the next-cheapest (up to `max_attempts`)

All spends remain gated by `MAX_PRICE_USD`.

---

## What V2 does

On startup the MCP server:

1. Loads credentials from `.env`
2. Resolves a CDP **Treasury** payer wallet
3. Searches / lists the Coinbase Bazaar for **Base Sepolia** (`eip155:84532`) HTTP resources priced at or below `MAX_PRICE_USD`
4. Registers each match as an MCP tool
5. Also registers helper tools: `search_bazaar`, `list_discovered_apis`, `call_x402_api`
6. Keeps the V1 demo tool `get_mbta_predictions`

When an agent calls a discovered tool (or `call_x402_api`):

1. Enforce `MAX_PRICE_USD` on **upstream price + markup**
2. Pay the real x402 endpoint with `CdpX402Client` + `wrapFetchWithPayment` from `@x402/fetch`
3. Collect the markup spread (Treasury → Merchant USDC transfer when possible)
4. Return `{ payment, data }` to the agent

V1 `get_mbta_predictions` still proves a fixed $0.01 USDC Base Sepolia transfer, then fetches free public MBTA prediction data.

---

## Architecture

```
Agent / Cursor
    │  MCP (stdio)
    ▼
x402dispatcher MCP server (src/index.ts)
    │
    ├─ Discovery  → listX402DiscoveryResources / searchX402Resources (@coinbase/cdp-sdk)
    ├─ Payment    → CdpX402Client + wrapFetchWithPayment (@coinbase/cdp-sdk/x402, @x402/fetch)
    ├─ Routing    → economy (price) / verified (stats score) with failover
    ├─ Stats      → data/api-stats.json success + latency history
    ├─ Guardrails → MAX_PRICE_USD (+ SDK spend controls)
    └─ Markup     → MARKUP_BPS applied; optional USDC transfer to Merchant account
    │
    ▼
Upstream x402 HTTP API (Bazaar listing)
```

### Key packages

- `@coinbase/cdp-sdk` — wallets, Bazaar discovery, `CdpX402Client`
- `@x402/fetch` / `@x402/core` / `@x402/evm` — HTTP 402 payment loop
- `@modelcontextprotocol/sdk` — MCP server + tools
- `dotenv`, `zod`, `viem`

---

## Requirements

- **Node.js 19+** (CDP SDK requirement; **22 LTS recommended**)
- Coinbase Developer Platform credentials:
  - `CDP_API_KEY_ID`
  - `CDP_API_KEY_SECRET`
  - `CDP_WALLET_SECRET` (Wallet Secret from CDP Portal → Non-custodial Wallet → Security — **not** a MetaMask private key)
- Base **mainnet** USDC on the Treasury address for production (`X402_ENV=production`), or Base Sepolia test USDC for development (default)

---

## Production (real USDC on Base)

1. Fund your CDP **`Treasury`** wallet with **USDC on Base mainnet** (not Sepolia).
2. Set in `.env` (local) or Cloud Run env:

```env
X402_ENV=production
MAX_PRICE_USD=0.01
```

3. Redeploy (Cloud Run defaults to production):

```bash
npm run deploy:gcp
```

4. Confirm `/health` shows `"x402_env": "production"` and `"network": "eip155:8453"`.

To stay on testnet locally, omit `X402_ENV` or set `X402_ENV=development`.

---

## Setup

```bash
git clone https://github.com/jegamboafuentes/x402dispatcher.git
cd x402dispatcher
npm install
cp .env.example .env
# edit .env with your CDP credentials
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `CDP_API_KEY_ID` | Yes | CDP API key ID |
| `CDP_API_KEY_SECRET` | Yes | CDP API key secret |
| `CDP_WALLET_SECRET` | Yes | CDP Wallet Secret (base64 P-256 key from Portal) |
| `MAX_PRICE_USD` | Recommended | Hard cap before any automated spend (e.g. `0.01`) |
| `MARKUP_BPS` | Optional | Markup in basis points (default `1000` = 10%) |
| `DISCOVERY_LIMIT` | Optional | Max Bazaar tools to register at startup (default `40`, max `100`) |
| `VERIFIED_MIN_SAMPLES` | Optional | Min successful-history calls for Verified (default `2`) |
| `VERIFIED_MIN_SUCCESS_RATE` | Optional | Min success rate 0–1 for Verified (default `0.8`) |
| `X402_ENV` | Optional | `development` (Base Sepolia, default) or `production` (Base mainnet, real USDC) |
| `INBOUND_PAYWALL` | Optional | V6: `true` (default) to charge callers; `false` for treasury-only operator mode |
| `INBOUND_PRICE_USD` | Optional | V6 flat inbound fee (default = `MAX_PRICE_USD`) |
| `X402_PAY_TO` | Optional | Override Merchant receive address for inbound payments |
| `CDP_PRIVATE_KEY` | Optional | Only if you import a specific EOA into CDP (not used by default V2+ payer path) |

Never commit `.env`. Only `.env.example` is tracked.

### Fund the treasury

```bash
npx tsx -e "import 'dotenv/config'; import { CdpX402Client } from '@coinbase/cdp-sdk/x402'; const c = new CdpX402Client({ environment: 'development', walletConfig: { type: 'eoa', accountName: 'Treasury' } }); console.log(await c.getAddresses());"
```

Send Base Sepolia **USDC** (and a little **ETH**) to the printed `evmAddress`.

---

## Run

### Local MCP (stdio — Cursor)

```bash
npm start
```

### Local HTTP MCP (V5)

```bash
npm run start:http
```

Then open `http://127.0.0.1:8080/health` and `http://127.0.0.1:8080/.well-known/agent.json`.

### Deploy to GCP Cloud Run

```bash
npm run deploy:gcp
```

Uses project `experiment-jegf-personal`, region `us-central1`, service `x402dispatcher`. Secrets are read from local `.env` on first create (`CDP_*`, `MAX_PRICE_USD`).

### Cursor MCP config

Project file: `.cursor/mcp.json` (already included). Cursor should spawn:

```json
{
  "mcpServers": {
    "x402dispatcher": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

Reload MCP in Cursor after clone/install. If `${workspaceFolder}` is not expanded on your Cursor build, set `cwd` to the absolute path of this repo and optionally point `command` at your Node 22 binary.

---

## MCP tools

### Core

| Tool | Purpose |
|---|---|
| `quote_route` | Rank matching APIs; `tier=economy\|verified`; no payment |
| `route_and_call` | Pay/call best match for tier; failover; records stats |
| `get_api_stats` | **V4** — local success/latency history |
| `list_verified_apis` | **V4** — APIs that currently qualify as Verified |
| `search_bazaar` | Semantic/text search of Base Sepolia Bazaar APIs under `MAX_PRICE_USD` |
| `list_discovered_apis` | List APIs currently cached/registered |
| `call_x402_api` | Pay + call by `tool_name` or full resource URL |
| `get_mbta_predictions` | V1 demo: $0.01 USDC settle + live MBTA predictions |

### Dynamic tools

At startup, x402dispatcher also registers one MCP tool per discovered Bazaar resource (names like `x402_<host>_<path>_<n>`). Each accepts optional `query` / `body` and pays the upstream URL.

---

## Testing

### V5 HTTP (cloud or local)

With `npm run start:http` running locally (or after deploy):

```bash
npm run test:v5
# or against Cloud Run:
$env:PUBLIC_BASE_URL='https://YOUR-SERVICE-uc.a.run.app'; npm run test:v5
```

Expect: `V5 HTTP SMOKE TEST PASSED`

### V4 end-to-end

Seeds two economy weather calls, promotes the winner into Verified, then quotes/routes with `tier=verified`:

```bash
npm run test:v4
```

Expect: `V4 SMOKE TEST PASSED`

### Earlier versions

```bash
npm run test:v3
npm run test:v2
```

### Manual checks in Cursor

1. Reload the `x402dispatcher` MCP server
2. Ask for weather with economy routing a couple of times (builds stats)
3. Ask: “List verified APIs” / “Get API stats”
4. Ask: “Use the verified tier to get weather for Boston”
5. Confirm `chosen.verified` is true and `data/api-stats.json` grew

### Guardrail check

Set `MAX_PRICE_USD` below a listing’s total and confirm quote/route refuse or return zero candidates.

---

## Project layout

```
x402dispatcher/
├── src/
│   ├── index.ts       # MCP server, tool registration
│   ├── discovery.ts   # Bazaar list/search → DiscoveredApi
│   ├── payment.ts     # CdpX402Client, markup, MBTA settle
│   ├── routing.ts     # quote + economy/verified route + failover
│   ├── stats.ts       # V4 local success/latency store
│   └── config.ts      # MAX_PRICE_USD, MARKUP_BPS, verified thresholds
├── scripts/
│   ├── v4-smoke-test.ts
│   ├── v3-smoke-test.ts
│   ├── v2-smoke-test.ts
│   ├── mcp-test.ts
│   └── smoke-test.ts
├── data/              # local api-stats.json (gitignored)
├── .cursor/
│   ├── mcp.json
│   └── rules/         # security + x402-stack agent rules
├── AGENTS.md          # product / roadmap context for agents
├── .env.example
└── package.json
```

---

## Security notes

- Wallet credentials load **only** from `.env` — never hardcode secrets.
- Every automated spend is gated by **`MAX_PRICE_USD`** before signing.
- V2 also configures CDP x402 **spend controls** (`maxAmountPerPayment` + Base Sepolia network allowlist).
- Treat the Bazaar as a catalog, not an endorsement. Prefer small caps on testnet first.
- `CDP_WALLET_SECRET` must be the Portal Wallet Secret (long base64), not a MetaMask hex key.

---

## Stack references

- [Coinbase CDP docs](https://docs.cdp.coinbase.com/)
- [Discover x402 services (Bazaar)](https://docs.cdp.coinbase.com/x402/buyer/discover-services)
- [x402 buyer quickstart](https://docs.cdp.coinbase.com/x402/buyer/quickstart)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

## License

ISC
