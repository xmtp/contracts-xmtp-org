# XMTP Contract Status Dashboard

Read-only dashboard for monitoring XMTP smart contracts across all environments.

## Architecture

Static frontend + serverless API deployed on Vercel.

**Frontend** (`index.html`) — Single-page dashboard built with Vite. Calls the API endpoints to fetch and display data.

**API** (`api/`) — Vercel serverless functions that query on-chain contract state via RPC. API keys stay server-side.

**Config** (`src/config.js`, `config/`) — Environment definitions, contract addresses, ABIs, and RPC URL configuration.

**Contracts** (`src/contracts.js`) — All on-chain read logic: version lookups, paused status, contract state inspection, balances.

## API Endpoints

| Endpoint                                    | Description                                     |
| ------------------------------------------- | ----------------------------------------------- |
| `GET /api/meta`                             | Environment metadata, chain IDs, contract names |
| `GET /api/versions`                         | Contract versions across all environments       |
| `GET /api/paused`                           | Paused status across all environments           |
| `GET /api/balances`                         | Wallet and Fireblocks balances per environment  |
| `GET /api/contract/:env/:chain/:name`       | Full contract state for a specific contract     |

## Dashboard Tabs

- **Contract Status** — Matrix of contract versions and paused status across environments, highlights mismatches
- **Contract Inspector** — Deep dive into a single contract: version, addresses, implementation, storage state, node registry, parameter values
- **Balances** — ETH and token balances for wallet and Fireblocks addresses across environments

## Local Development

```
yarn install
```

Create a `.env` file with your RPC URLs (see `src/config.js` for required variables).

```
vercel dev
```

Runs the full stack locally at `http://localhost:3000` — both the Vite frontend and the serverless API functions. This is the recommended way to develop locally.

Alternatively, `yarn dev` runs only the Vite frontend at `http://localhost:5173` and proxies `/api/*` calls to `http://localhost:3000`, so you'd need `vercel dev` running in a separate terminal for the API.

## Deployment

Deployed automatically via Vercel on push to `main`. Environment variables (RPC URLs, etc.) are configured in the Vercel project settings.
