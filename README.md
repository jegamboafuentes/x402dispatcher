# Proxy402

Local **x402 Bazaar Aggregator** for AI agents: discover paid APIs from the Coinbase x402 Bazaar, wrap them as Model Context Protocol (MCP) tools, settle micropayments from a CDP treasury wallet, and return the upstream data to the agent.

This repo is currently at **V2**.

---

## Why this exists

AI agents are good at reasoning and tool use, but bad at paying for APIs. The [x402](https://x402.org) protocol turns HTTP `402 Payment Required` into a programmable stablecoin micropayment rail (typically USDC).

**Proxy402** sits in the middle as a solo-operator friendly aggregator:

| Idea | What it means |
|---|---|
| Discovery | Query the public Coinbase x402 Bazaar catalog |
| MCP integration | Expose discovered APIs as MCP tools for Cursor / agents |
| Proxy execution | Sign and settle payment from a treasury wallet via `@coinbase/cdp-sdk` |
| Monetization | Apply a micro-markup on top of upstream cost and retain the spread |

Funds move wallet → merchant. The platform does not custody buyer funds.

---

## Roadmap

| Version | Status | Goal |
|---|---|---|
| **V1** | Done | Manually wrap one paid-style flow (MBTA demo + $0.01 USDC testnet settle) |
| **V2** | **Current** | Auto-discover Base Sepolia Bazaar APIs and wrap many as MCP tools with real x402 payment |
| **V3** | Planned | Smart arbitrage: search, compare prices, pick cheapest API for a task |
| **V4** | Planned | Track success/latency; curated “Verified” routing tier |
| **V5** | Planned | Cloud host, public registries, `agent.json` for crawlers |

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
Proxy402 MCP server (src/index.ts)
    │
    ├─ Discovery  → listX402DiscoveryResources / searchX402Resources (@coinbase/cdp-sdk)
    ├─ Payment    → CdpX402Client + wrapFetchWithPayment (@coinbase/cdp-sdk/x402, @x402/fetch)
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
- Base Sepolia USDC (+ a little ETH for gas) on the Treasury address

---

## Setup

```bash
git clone https://github.com/<your-user>/Proxy402.git
cd Proxy402
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
| `CDP_PRIVATE_KEY` | Optional | Only if you import a specific EOA into CDP (not used by default V2 payer path) |

Never commit `.env`. Only `.env.example` is tracked.

### Fund the treasury

```bash
npx tsx -e "import 'dotenv/config'; import { CdpX402Client } from '@coinbase/cdp-sdk/x402'; const c = new CdpX402Client({ environment: 'development', walletConfig: { type: 'eoa', accountName: 'Treasury' } }); console.log(await c.getAddresses());"
```

Send Base Sepolia **USDC** (and a little **ETH**) to the printed `evmAddress`.

---

## Run

### MCP server (stdio)

```bash
npm start
```

### Cursor MCP config

Project file: `.cursor/mcp.json` (already included). Cursor should spawn:

```json
{
  "mcpServers": {
    "proxy402": {
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
| `search_bazaar` | Semantic/text search of Base Sepolia Bazaar APIs under `MAX_PRICE_USD` |
| `list_discovered_apis` | List APIs currently cached/registered |
| `call_x402_api` | Pay + call by `tool_name` or full resource URL |
| `get_mbta_predictions` | V1 demo: $0.01 USDC settle + live MBTA predictions |

### Dynamic tools

At startup, Proxy402 also registers one MCP tool per discovered Bazaar resource (names like `x402_<host>_<path>_<n>`). Each accepts optional `query` / `body` and pays the upstream URL.

---

## Testing

### V2 end-to-end (recommended)

Spawns the MCP server over stdio, searches for weather, pays a real Base Sepolia listing, prints payment + data:

```bash
npm run test:v2
```

Expect: `V2 SMOKE TEST PASSED`

### Manual checks in Cursor

1. Enable / reload the `proxy402` MCP server
2. Ask: “List discovered APIs” or “Search the bazaar for weather”
3. Call a cheap tool or `call_x402_api`
4. Confirm the response includes `payment` (upstream price, markup, settlement) and `data`
5. Optional: confirm Treasury USDC decreased on [Base Sepolia explorer](https://sepolia.basescan.org/)

### Guardrail check

Set `MAX_PRICE_USD` below a listing’s total (upstream + markup) and confirm the call is refused.

---

## Project layout

```
Proxy402/
├── src/
│   ├── index.ts       # MCP server, tool registration
│   ├── discovery.ts   # Bazaar list/search → DiscoveredApi
│   ├── payment.ts     # CdpX402Client, markup, MBTA settle
│   └── config.ts      # MAX_PRICE_USD, MARKUP_BPS, network constants
├── scripts/
│   ├── v2-smoke-test.ts
│   ├── mcp-test.ts
│   └── smoke-test.ts
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
