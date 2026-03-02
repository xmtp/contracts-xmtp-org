# Parameter History Tile Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the "Known Parameter Values" tile on both parameter registry inspector pages with an async "Parameter History" tile that shows all `ParameterSet` events grouped by key, with full value history and external block explorer links.

**Architecture:** New Vercel serverless endpoint `api/events/[env]/[chain]/[name].js` fetches and decodes `ParameterSet` events; the frontend renders a spinner-only tile immediately, then populates it asynchronously once the events endpoint responds. All other tiles render at full speed — only this tile is deferred.

**Tech Stack:** Node.js + ethers.js (already a dependency), Vercel file-system routing, vanilla JS/HTML inline in `index.html`.

---

## Reference

- Design doc: `docs/plans/2026-03-02-parameter-history-tile-design.md`
- ABIs: `src/abis/SettlementChainParameterRegistry.json`, `src/abis/AppChainParameterRegistry.json` — both have `ParameterSet(keyHash string indexed, key string, value bytes32)`
- Existing helpers in `src/contracts.js`: `queryEventsWithFallback`, `decodeParameterValue`, `isAddressKey`, `isBoolKey`, `getProvider`, `getContract`
- Existing config in `src/config.js`: `ENVIRONMENTS`, `SETTLEMENT_CONTRACTS`, `APP_CONTRACTS`, `EXPLORERS`, `getContractAddress`
- Frontend: all JS lives inline in `index.html`; the existing "Known Parameter Values" tile is rendered inside `renderContractDetails()` at approximately line 1138–1166

---

### Task 1: Create the events API endpoint

**Files:**
- Create: `api/events/[env]/[chain]/[name].js`

No tests for this project (no test framework present). Verify manually via `curl` after local dev server start.

**Step 1: Create the directory**

```bash
mkdir -p "api/events/[env]/[chain]"
```

**Step 2: Write the handler**

Create `api/events/[env]/[chain]/[name].js` with this content:

```js
const { ethers } = require("ethers");
const {
  ENVIRONMENTS,
  SETTLEMENT_CONTRACTS,
  APP_CONTRACTS,
  EXPLORERS,
  getRpcUrls,
  loadAbi,
  getContractAddress,
} = require("../../../../src/config");
const {
  decodeParameterValue,
} = require("../../../../src/contracts");

const PARAMETER_REGISTRY_NAMES = new Set([
  "SettlementChainParameterRegistry",
  "AppChainParameterRegistry",
]);

function getProvider(env, chain) {
  const rpcs = getRpcUrls();
  const url = rpcs[env]?.[chain];
  if (!url) throw new Error(`No RPC URL for ${env}/${chain}`);
  return new ethers.JsonRpcProvider(url);
}

async function queryParameterSetEvents(contract, provider) {
  const filter = contract.filters.ParameterSet();
  try {
    return await contract.queryFilter(filter);
  } catch {
    const currentBlock = await provider.getBlockNumber();
    return await contract.queryFilter(
      filter,
      Math.max(0, currentBlock - 500000),
    );
  }
}

async function fetchBlockTimestamps(blockNumbers, provider) {
  const unique = [...new Set(blockNumbers)];
  const results = {};
  await Promise.allSettled(
    unique.map(async (n) => {
      try {
        const block = await provider.getBlock(n);
        results[n] = block ? Number(block.timestamp) : null;
      } catch {
        results[n] = null;
      }
    }),
  );
  return results;
}

module.exports = async function handler(req, res) {
  const { env, chain, name } = req.query;

  if (!ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Invalid environment: ${env}` });
  }
  if (!["settlement", "app"].includes(chain)) {
    return res.status(400).json({ error: `Invalid chain: ${chain}` });
  }
  if (!PARAMETER_REGISTRY_NAMES.has(name)) {
    return res
      .status(400)
      .json({ error: `${name} does not have parameter history` });
  }

  const allContracts =
    chain === "settlement" ? SETTLEMENT_CONTRACTS : APP_CONTRACTS;
  const contractDef = allContracts.find((c) => c.name === name);
  const address = contractDef ? getContractAddress(env, contractDef) : null;
  const explorerBase = EXPLORERS[env]?.[chain] || null;
  const explorerUrl = address && explorerBase
    ? `${explorerBase}/address/${address}`
    : null;

  if (!address) {
    return res
      .status(404)
      .json({ keys: null, error: `Contract not found in ${env}`, explorerUrl });
  }

  try {
    const provider = getProvider(env, chain);
    const abi = loadAbi(
      chain === "settlement"
        ? "SettlementChainParameterRegistry"
        : "AppChainParameterRegistry",
    );
    const contract = new ethers.Contract(address, abi, provider);

    let events;
    try {
      events = await queryParameterSetEvents(contract, provider);
    } catch (err) {
      return res.status(200).json({
        keys: null,
        error: err.message || "Failed to retrieve events from RPC",
        explorerUrl,
      });
    }

    // Group events by key, preserving chronological order within each group
    const byKey = {};
    for (const ev of events) {
      const key = ev.args.key;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push({
        block: ev.blockNumber,
        txHash: ev.transactionHash,
        rawValue: ev.args.value,
      });
    }

    // Fetch timestamps for all unique block numbers
    const allBlocks = events.map((ev) => ev.blockNumber);
    const timestamps = await fetchBlockTimestamps(allBlocks, provider);

    // Build key summaries; history is newest-first within each key
    const keys = Object.entries(byKey).map(([key, entries]) => {
      const sorted = [...entries].sort((a, b) => b.block - a.block);
      const history = sorted.map((e) => ({
        decoded: decodeParameterValue(key, e.rawValue),
        block: e.block,
        timestamp: timestamps[e.block] ?? null,
        txHash: e.txHash,
      }));
      return {
        key,
        currentDecoded: history[0].decoded,
        lastChangedBlock: history[0].block,
        lastChangedTimestamp: history[0].timestamp,
        history,
      };
    });

    // Default sort: A→Z by key name
    keys.sort((a, b) => a.key.localeCompare(b.key));

    return res.status(200).json({
      keys,
      totalEvents: events.length,
      explorerUrl,
      error: null,
    });
  } catch (err) {
    console.error(`Error fetching parameter events for ${name}:`, err);
    return res.status(200).json({
      keys: null,
      error: err.message || "Unexpected error",
      explorerUrl,
    });
  }
};
```

**Step 3: Verify `decodeParameterValue` is exported from `src/contracts.js`**

Check the `module.exports` at the bottom of `src/contracts.js`. If `decodeParameterValue` is not currently exported, add it to the exports object.

**Step 4: Commit**

```bash
git add "api/events/[env]/[chain]/[name].js" src/contracts.js
git commit -m "feat: add parameter history events API endpoint"
```

---

### Task 2: Add the Parameter History tile CSS styles

**Files:**
- Modify: `index.html` (styles section, roughly lines 8–530)

These styles need to be added inside the `<style>` block.

**Step 1: Find a good insertion point**

Search for `/* Brand Header */` in `index.html` — add the new styles just before that comment, or find the end of the `<style>` block. Look for the closing `</style>` tag.

**Step 2: Add styles just before `</style>`**

```css
      /* Parameter History tile */
      .param-history-key {
        padding: 10px 18px 4px;
        border-top: 1px solid var(--border);
      }
      .param-history-key:first-child {
        border-top: none;
      }
      .param-history-key-name {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--text-dim);
        margin-bottom: 4px;
        word-break: break-all;
      }
      .param-history-current {
        font-family: var(--mono);
        font-size: 14px;
        color: var(--text-bright);
        font-weight: 600;
        padding: 4px 0 4px 10px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .param-history-prior {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--text-dim);
        padding: 2px 0 2px 10px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .param-history-meta {
        font-size: 10px;
        color: var(--text-dim);
        opacity: 0.6;
      }
      .param-history-link {
        color: var(--text-dim);
        opacity: 0.5;
        text-decoration: none;
        font-size: 11px;
        flex-shrink: 0;
      }
      .param-history-link:hover {
        opacity: 1;
        color: var(--accent);
      }
      .param-sort-toggle {
        display: flex;
        gap: 2px;
        margin-left: auto;
        font-size: 11px;
        font-weight: 400;
      }
      .param-sort-btn {
        padding: 2px 8px;
        border-radius: 3px;
        cursor: pointer;
        color: var(--text-dim);
        background: transparent;
        border: 1px solid transparent;
        font-size: 11px;
        font-family: inherit;
      }
      .param-sort-btn.active {
        color: var(--accent);
        border-color: var(--accent);
        background: rgba(88,166,255,0.08);
      }
      .param-sort-btn:hover:not(.active) {
        color: var(--text);
        border-color: var(--border);
      }
```

**Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add parameter history tile CSS styles"
```

---

### Task 3: Add the JS helper functions for the Parameter History tile

**Files:**
- Modify: `index.html` (JS section, inside the `<script>` block)

**Step 1: Locate a good insertion point**

Find the `toggleUnsetParams` function (around line 547). Add the new functions immediately after `toggleUnsetParams` closes (after its `}` on roughly line 555).

**Step 2: Add helper functions**

Insert the following block after `toggleUnsetParams`:

```js
      // ---- Parameter History tile helpers ----

      function formatParamValue(decoded) {
        if (decoded === null || decoded === undefined) {
          return '<span style="color:var(--text-dim)">zero / unset</span>';
        }
        if (typeof decoded === "boolean") {
          return decoded
            ? '<span style="color:var(--green)">true</span>'
            : '<span style="color:var(--red)">false</span>';
        }
        const s = String(decoded);
        if (s.startsWith("0x") && s.length === 42) {
          return renderAddress(decoded, "");
        }
        return `<span style="font-family:var(--mono)">${escapeHtml(s)}</span>`;
      }

      function formatParamTimestamp(ts) {
        if (!ts) return "";
        try {
          return new Date(ts * 1000).toISOString().slice(0, 10);
        } catch {
          return "";
        }
      }

      function renderParameterHistoryContent(data, tileBodyEl, explorerUrl, currentSort) {
        if (!data.keys || data.keys.length === 0) {
          tileBodyEl.innerHTML = `<div style="padding:14px 18px;color:var(--text-dim);font-size:13px">No ParameterSet events found.</div>`;
          return;
        }

        const sorted = [...data.keys];
        if (currentSort === "recent") {
          sorted.sort((a, b) => (b.lastChangedBlock || 0) - (a.lastChangedBlock || 0));
        } else {
          sorted.sort((a, b) => a.key.localeCompare(b.key));
        }

        let html = "";
        for (const entry of sorted) {
          const lastDate = formatParamTimestamp(entry.lastChangedTimestamp);
          html += `<div class="param-history-key">`;
          html += `<div class="param-history-key-name">${escapeHtml(entry.key)}</div>`;

          // Current value row (most recent event)
          const currentTxLink = entry.history[0]?.txHash && explorerUrl
            ? `<a href="${explorerUrl.replace(/\/address\/.*/, "")}/tx/${entry.history[0].txHash}" target="_blank" rel="noopener" class="param-history-link" title="View transaction">&#8599;</a>`
            : "";
          const dateHtml = lastDate
            ? `<span class="param-history-meta">${lastDate}</span>`
            : "";
          html += `<div class="param-history-current">${formatParamValue(entry.currentDecoded)}${dateHtml}${currentTxLink}</div>`;

          // Prior values (skip index 0, that's current)
          for (let i = 1; i < entry.history.length; i++) {
            const h = entry.history[i];
            const txLink = h.txHash && explorerUrl
              ? `<a href="${explorerUrl.replace(/\/address\/.*/, "")}/tx/${h.txHash}" target="_blank" rel="noopener" class="param-history-link" title="View transaction">&#8599;</a>`
              : "";
            const hDate = formatParamTimestamp(h.timestamp);
            const blockStr = `block ${h.block}`;
            html += `<div class="param-history-prior">${formatParamValue(h.decoded)}<span class="param-history-meta">${escapeHtml(blockStr)}${hDate ? " · " + hDate : ""}</span>${txLink}</div>`;
          }

          html += `</div>`;
        }

        tileBodyEl.innerHTML = html;
      }

      function sortParameterHistory(tileEl, mode) {
        // Update button states
        tileEl.querySelectorAll(".param-sort-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.sort === mode);
        });
        // Re-render body
        const cachedData = tileEl._paramHistoryData;
        const explorerUrl = tileEl._paramHistoryExplorerUrl;
        if (cachedData) {
          renderParameterHistoryContent(
            cachedData,
            tileEl.querySelector(".detail-card-body"),
            explorerUrl,
            mode,
          );
        }
      }

      async function loadParameterHistory(data, container) {
        const tileEl = container.querySelector("#param-history-tile");
        if (!tileEl) return;

        const env = document.getElementById("inspector-env").value;
        const contractVal = document.getElementById("inspector-contract").value;
        const [chain, name] = contractVal.split(":");

        try {
          const result = await fetch(`/api/events/${env}/${chain}/${name}`).then(
            (r) => r.json(),
          );

          // Cache on the element for re-sorting
          tileEl._paramHistoryData = result;
          tileEl._paramHistoryExplorerUrl = result.explorerUrl || data.explorer || "";

          // Update header count
          const countEl = tileEl.querySelector(".param-history-count");
          if (countEl) {
            countEl.textContent =
              result.keys
                ? `${result.keys.length} key${result.keys.length !== 1 ? "s" : ""}, ${result.totalEvents} event${result.totalEvents !== 1 ? "s" : ""}`
                : "";
          }

          const bodyEl = tileEl.querySelector(".detail-card-body");

          if (result.error && !result.keys) {
            const link = result.explorerUrl
              ? ` <a href="${result.explorerUrl}" target="_blank" rel="noopener" style="color:var(--accent)">View on explorer &#8599;</a>`
              : "";
            bodyEl.innerHTML = `<div style="padding:14px 18px;font-size:13px;color:var(--amber)">&#9888; Cannot retrieve events: ${escapeHtml(result.error)}.${link}</div>`;
            return;
          }

          renderParameterHistoryContent(
            result,
            bodyEl,
            tileEl._paramHistoryExplorerUrl,
            "alpha",
          );
        } catch (err) {
          const bodyEl = tileEl.querySelector(".detail-card-body");
          const explorerUrl = data.explorer
            ? `${data.explorer}/address/${data.address}`
            : null;
          const link = explorerUrl
            ? ` <a href="${explorerUrl}" target="_blank" rel="noopener" style="color:var(--accent)">View on explorer &#8599;</a>`
            : "";
          bodyEl.innerHTML = `<div style="padding:14px 18px;font-size:13px;color:var(--amber)">&#9888; Cannot retrieve events: ${escapeHtml(err.message)}.${link}</div>`;
        }
      }
```

**Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add parameter history JS helper functions"
```

---

### Task 4: Wire up the tile in renderContractDetails

**Files:**
- Modify: `index.html` (inside `renderContractDetails`, around lines 1138–1170)

**Step 1: Find the "Known parameter values" block**

Search for the comment `// Known parameter values` (around line 1138). The block runs from there to `html += '</div></div>';` at approximately line 1166.

**Step 2: Replace the entire `if (knownParameters)` block**

Remove:
```js
          // Known parameter values
          if (knownParameters) {
            const paramEntries = Object.entries(knownParameters);
            const setCount = paramEntries.filter(
              ([, val]) => val !== null,
            ).length;
            const paramCardId = `param-card-${Date.now()}`;
            html += `<div class="detail-card">
      <div class="detail-card-header">Known Parameter Values <span style="color:var(--text-dim);font-weight:400;font-size:12px">${setCount} of ${paramEntries.length} set</span>
        <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:400;color:var(--text-dim);cursor:pointer;user-select:none">
          <input type="checkbox" id="${paramCardId}-filter" onchange="toggleUnsetParams(this)" style="cursor:pointer;accent-color:var(--accent)">
          Only show keys with values
        </label>
      </div>
      <div class="detail-card-body" id="${paramCardId}-body">
        <div style="padding:10px 18px;border-bottom:1px solid var(--border);font-size:12px;color:var(--amber);background:rgba(210,153,34,0.06)">
          &#9888; These are known parameter keys from code &mdash; not guaranteed to be ALL values in the registry.
        </div>`;

            for (const [key, val] of paramEntries) {
              const rendered =
                val === null
                  ? '<span style="color:var(--text-dim)">not set</span>'
                  : formatBigValue(val);
              const unsetAttr = val === null ? ' data-param-unset="true"' : "";
              html += `<div class="detail-row"${unsetAttr}><div class="detail-key" style="width:380px;min-width:380px;font-family:var(--mono);font-size:11px">${escapeHtml(key)}</div><div class="detail-val">${rendered}</div></div>`;
            }

            html += `</div></div>`;
          }
```

Replace with:
```js
          // Parameter history tile (async — replaces "Known Parameter Values")
          if (knownParameters !== undefined) {
            html += `<div class="detail-card" id="param-history-tile">
      <div class="detail-card-header">
        Parameter History
        <span class="param-history-count" style="color:var(--text-dim);font-weight:400;font-size:12px;margin-left:6px"></span>
        <div class="param-sort-toggle">
          <button class="param-sort-btn active" data-sort="alpha" onclick="sortParameterHistory(this.closest('#param-history-tile'),'alpha')">Key A→Z</button>
          <button class="param-sort-btn" data-sort="recent" onclick="sortParameterHistory(this.closest('#param-history-tile'),'recent')">Recently Changed</button>
        </div>
      </div>
      <div class="detail-card-body">
        <div class="loading" style="padding:20px 18px"><div class="spinner"></div>Loading parameter history…</div>
      </div>
    </div>`;
          }
```

**Step 3: Find where `container.innerHTML = html;` is set (around line 1170)**

Immediately after that line, add the async kickoff:

```js
        // Kick off async parameter history load if applicable
        if (knownParameters !== undefined) {
          loadParameterHistory(data, container);
        }
```

The final block near line 1170 should look like:

```js
        container.innerHTML = html;

        // Kick off async parameter history load if applicable
        if (knownParameters !== undefined) {
          loadParameterHistory(data, container);
        }
      }
```

**Step 4: Verify the destructuring at the top of `renderContractDetails` still includes `knownParameters`**

Look for the destructuring block around line 884–899 that extracts `knownParameters` from `data.state`. It should already be there; confirm it is.

**Step 5: Commit**

```bash
git add index.html
git commit -m "feat: wire parameter history tile into renderContractDetails"
```

---

### Task 5: Manual verification

**Step 1: Start the dev server**

```bash
# Requires .env with RPC URLs — check .env.example or README for expected variable names
# Typical start command for Vercel-based projects:
npx vercel dev
# or if a dev script exists:
npm run dev
```

**Step 2: Open the inspector tab**

Navigate to `http://localhost:3000` (or the port shown), select an environment (e.g. `testnet`), select `settlement : SettlementChainParameterRegistry`. Verify:
- [ ] All other tiles (Storage State, header) render immediately
- [ ] "Parameter History" tile shows spinner while loading
- [ ] After load: keys appear grouped, current value prominent
- [ ] A→Z sort is active by default
- [ ] Clicking "Recently Changed" reorders without a network request
- [ ] Each event row has a `↗` link that opens the correct explorer tx URL in a new tab
- [ ] Repeat with `app : AppChainParameterRegistry`

**Step 3: Test error path**

Temporarily break the events endpoint (e.g. rename it) and reload — verify the tile shows the amber "Cannot retrieve events" message with an explorer link, and all other tiles are unaffected.

**Step 4: Restore any temporary changes made in step 3**

**Step 5: Final commit (if any fixups were needed)**

```bash
git add -p
git commit -m "fix: parameter history tile adjustments from manual verification"
```

---

### Task 6: Push branch and open PR

**Step 1: Push branch**

```bash
git push -u origin feature/parameter-history-tile
```

**Step 2: Open PR**

```bash
gh pr create \
  --title "feat: parameter history tile for parameter registries" \
  --body "Replaces the 'Known Parameter Values' tile with an async 'Parameter History' tile that queries all ParameterSet events and displays full value history grouped by key. The tile loads independently so the rest of the page renders immediately."
```
