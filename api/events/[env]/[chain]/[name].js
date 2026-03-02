const {
  decodeParameterValue,
  getProvider,
  getContract,
} = require("../../../../src/contracts");
const {
  ENVIRONMENTS,
  SETTLEMENT_CONTRACTS,
  APP_CONTRACTS,
  EXPLORERS,
  getContractAddress,
} = require("../../../../src/config");

async function fetchBlockTimestamps(blockNumbers, provider) {
  const unique = [...new Set(blockNumbers)];
  const results = {};
  // Process in batches to avoid rate-limiting
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    await Promise.allSettled(
      batch.map(async (n) => {
        try {
          const block = await provider.getBlock(n);
          results[n] = block ? Number(block.timestamp) : null;
        } catch {
          results[n] = null;
        }
      }),
    );
  }
  return results;
}

const PARAMETER_REGISTRY_NAMES = new Set([
  "SettlementChainParameterRegistry",
  "AppChainParameterRegistry",
]);

module.exports = async function handler(req, res) {
  const { env, chain, name } = req.query;

  // Validate inputs
  if (!ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Invalid environment: ${env}` });
  }
  if (!["settlement", "app"].includes(chain)) {
    return res.status(400).json({ error: `Invalid chain: ${chain}` });
  }
  if (!PARAMETER_REGISTRY_NAMES.has(name)) {
    return res.status(400).json({ error: "Invalid contract name" });
  }

  // Locate the contract definition
  const allContracts =
    chain === "settlement" ? SETTLEMENT_CONTRACTS : APP_CONTRACTS;
  const contractDef = allContracts.find((c) => c.name === name);
  if (!contractDef) {
    return res
      .status(400)
      .json({ error: `Contract not available on ${chain} chain` });
  }

  // Resolve the contract address
  const address = getContractAddress(env, contractDef);

  // Build explorer URL regardless of whether RPC succeeds
  const explorerBase = EXPLORERS[env]?.[chain];
  const explorerUrl =
    address && explorerBase ? `${explorerBase}/address/${address}` : null;

  if (!address) {
    return res.status(200).json({
      keys: null,
      totalEvents: 0,
      explorerUrl,
      error: `No address found for ${name} in ${env}`,
    });
  }

  try {
    const provider = getProvider(env, chain);
    const contract = getContract(address, contractDef.abiFile, provider);

    const filter = contract.filters.ParameterSet();

    // Fetch events — try all blocks first, fall back to recent 500k blocks
    let events;
    try {
      events = await contract.queryFilter(filter);
    } catch {
      let currentBlock;
      try {
        currentBlock = await provider.getBlockNumber();
      } catch (blockErr) {
        return res.status(200).json({
          keys: null,
          totalEvents: 0,
          explorerUrl,
          error: `RPC failure: ${blockErr.message}`,
        });
      }
      try {
        events = await contract.queryFilter(
          filter,
          Math.max(0, currentBlock - 500000),
        );
      } catch (fallbackErr) {
        return res.status(200).json({
          keys: null,
          totalEvents: 0,
          explorerUrl,
          error: `RPC failure fetching events: ${fallbackErr.message}`,
        });
      }
    }

    const totalEvents = events.length;

    // Collect unique block numbers and fetch timestamps in batches
    const blockTimestamps = await fetchBlockTimestamps(
      events.map((e) => e.blockNumber),
      provider,
    );

    // Group events by key (not keyHash)
    const byKey = {};
    for (const event of events) {
      const key = event.args?.key;
      if (!key) continue; // skip malformed events
      const rawValue = event.args.value;
      const blockNumber = event.blockNumber;
      const timestamp = blockTimestamps[blockNumber] ?? null;
      const txHash = event.transactionHash;

      if (!byKey[key]) {
        byKey[key] = [];
      }
      byKey[key].push({ rawValue, block: blockNumber, timestamp, txHash });
    }

    // Build the keys array — sort each group newest-first, then sort keys A→Z
    const keys = Object.keys(byKey)
      .sort()
      .map((key) => {
        const entries = byKey[key].sort((a, b) => b.block - a.block);

        const history = entries.map((entry) => ({
          decoded: decodeParameterValue(key, entry.rawValue),
          block: entry.block,
          timestamp: entry.timestamp,
          txHash: entry.txHash,
        }));

        const latest = history[0];

        return {
          key,
          currentDecoded: latest.decoded,
          lastChangedBlock: latest.block,
          lastChangedTimestamp: latest.timestamp,
          history,
        };
      });

    return res.status(200).json({
      keys,
      totalEvents,
      explorerUrl,
      error: null,
    });
  } catch (err) {
    console.error(
      `Error fetching ParameterSet events for ${name} on ${env}/${chain}:`,
      err,
    );
    return res.status(200).json({
      keys: null,
      totalEvents: 0,
      explorerUrl,
      error: err.message,
    });
  }
};
