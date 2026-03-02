# Parameter History Tile — Design Doc

**Date:** 2026-03-02
**Feature:** Replace "Known Parameter Values" tile on parameter registry pages with an async "Parameter History" tile that shows all `ParameterSet` events grouped by key with full value history.

---

## Problem

The existing "Known Parameter Values" tile:
- Only shows keys hardcoded in JS (`KNOWN_PARAMETER_KEYS`)
- Shows only the *current* value — no history
- Does not surface undiscovered/novel keys

## Solution

A new **Parameter History** tile that:
- Discovers all keys ever set by querying on-chain `ParameterSet` events
- Groups events by key, shows current value prominently and historical values below
- Loads asynchronously — the rest of the page renders immediately, this tile shows a spinner independently
- Handles RPC failures gracefully with a "cannot retrieve events" message + block explorer link
- Supports two sort modes: A→Z by key (default) or most recently changed first

---

## Architecture

### Backend — new API endpoint

`api/events/[env]/[chain]/[name].js`

- Only valid for `SettlementChainParameterRegistry` and `AppChainParameterRegistry`
- Fetches all `ParameterSet` events using the existing `queryEventsWithFallback` pattern
- Decodes `bytes32` values using the existing `decodeParameterValue` logic
- Fetches block timestamps for unique block numbers in parallel (expect ~10–50 distinct blocks)
- Returns grouped-by-key JSON sorted by key name

**Success response:**
```json
{
  "keys": [
    {
      "key": "xmtp.payerRegistry.paused",
      "currentDecoded": false,
      "lastChangedBlock": 12345,
      "lastChangedTimestamp": 1740000000,
      "history": [
        { "decoded": false, "block": 12345, "timestamp": 1740000000, "txHash": "0x..." },
        { "decoded": true,  "block": 11000, "timestamp": 1738000000, "txHash": "0x..." }
      ]
    }
  ],
  "totalEvents": 42,
  "explorerUrl": "https://sepolia.basescan.org/address/0x..."
}
```

**Error response:**
```json
{
  "keys": null,
  "error": "Query range exceeded RPC limit",
  "explorerUrl": "https://sepolia.basescan.org/address/0x..."
}
```

### Frontend — async tile in `index.html`

- `renderContractDetails()`: when `data.name` is a parameter registry, render a placeholder spinner div (with known ID) instead of the old "Known Parameter Values" tile
- After setting `container.innerHTML`, call `loadParameterHistory(data, container)` if applicable
- `loadParameterHistory()`: fetch `/api/events/{env}/{chain}/{name}`, then call `renderParameterHistory(result, tileEl)` to replace spinner
- Sort toggle: two-state control in tile header, `sortParameterHistory(tileEl, mode)` re-renders key list in place

### Tile layout

```
Parameter History   [42 events]     Key A→Z  ·  Recently Changed
─────────────────────────────────────────────────────────────────
xmtp.payerRegistry.paused                   last changed: 2025-01-15
  ▸ false                                   ← current value (prominent)
    true  · block 11000  · 2024-12-03  ↗   ← prior values (dimmed, linked)
    false · block  9500  · 2024-11-10  ↗

xmtp.payerRegistry.settler                  last changed: 2025-02-01
  ▸ 0x1234...abcd                           ← current value
    [no prior values]
```

Each `↗` links to `{explorerUrl}/tx/{txHash}` in a new tab. The current value row also links to the most recent tx.

---

## Error handling

1. Try `contract.queryFilter(filter)` with no block range (all history)
2. On failure: retry with `Math.max(0, currentBlock - 500000)` to `latest`
3. On any remaining failure: return `{ keys: null, error: "...", explorerUrl }`

The frontend renders the error state inside the tile only — all other tiles are unaffected.

---

## What is removed

The old "Known Parameter Values" tile (`if (knownParameters)` block in `renderContractDetails`) is removed and replaced by the new async tile. The `knownParameters` field is still returned by the existing contract API (no backend state reader change needed) but is no longer rendered.

> Note: `knownParameters` could be removed from the state readers in a follow-up cleanup, but is out of scope here to minimise risk.
