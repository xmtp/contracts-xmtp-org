const { ethers } = require("ethers");
const {
  ENVIRONMENTS,
  SETTLEMENT_CONTRACTS,
  APP_CONTRACTS,
  getRpcUrls,
  loadAbi,
  getContractAddress,
  getConfigAddresses,
  envFiles,
  configFiles,
  EXPLORERS,
} = require("./config");

const MINIMAL_ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Provider cache
const providers = {};

function getProvider(env, chain) {
  const key = `${env}-${chain}`;
  if (!providers[key]) {
    const rpcs = getRpcUrls();
    const url = rpcs[env][chain];
    if (!url) throw new Error(`No RPC URL for ${env}/${chain}`);
    providers[key] = new ethers.JsonRpcProvider(url);
  }
  return providers[key];
}

function getContract(address, abiName, provider) {
  const abi = loadAbi(abiName);
  return new ethers.Contract(address, abi, provider);
}

// Safe call helper - returns null on failure
async function safeCall(contract, method, ...args) {
  try {
    return await contract[method](...args);
  } catch (err) {
    if (process.env.DEBUG) {
      console.debug(
        `safeCall failed: ${method} on ${contract.target}: ${err.message}`,
      );
    }
    return null;
  }
}

// Known parameter keys for parameter registries (from ParameterSnapshotter.sol)
const KNOWN_PARAMETER_KEYS = [
  "xmtp.appChainGateway.migrator",
  "xmtp.appChainGateway.paused",
  "xmtp.appChainParameterRegistry.migrator",
  "xmtp.distributionManager.migrator",
  "xmtp.distributionManager.paused",
  "xmtp.distributionManager.protocolFeesRecipient",
  "xmtp.factory.migrator",
  "xmtp.factory.paused",
  "xmtp.feeToken.migrator",
  "xmtp.groupMessageBroadcaster.maxPayloadSize",
  "xmtp.groupMessageBroadcaster.migrator",
  "xmtp.groupMessageBroadcaster.minPayloadSize",
  "xmtp.groupMessageBroadcaster.paused",
  "xmtp.groupMessageBroadcaster.payloadBootstrapper",
  "xmtp.identityUpdateBroadcaster.maxPayloadSize",
  "xmtp.identityUpdateBroadcaster.migrator",
  "xmtp.identityUpdateBroadcaster.minPayloadSize",
  "xmtp.identityUpdateBroadcaster.paused",
  "xmtp.identityUpdateBroadcaster.payloadBootstrapper",
  "xmtp.nodeRegistry.admin",
  "xmtp.nodeRegistry.maxCanonicalNodes",
  "xmtp.nodeRegistry.migrator",
  "xmtp.payerRegistry.feeDistributor",
  "xmtp.payerRegistry.migrator",
  "xmtp.payerRegistry.minimumDeposit",
  "xmtp.payerRegistry.paused",
  "xmtp.payerRegistry.settler",
  "xmtp.payerRegistry.withdrawLockPeriod",
  "xmtp.payerReportManager.migrator",
  "xmtp.payerReportManager.protocolFeeRate",
  "xmtp.rateRegistry.congestionFee",
  "xmtp.rateRegistry.messageFee",
  "xmtp.rateRegistry.migrator",
  "xmtp.rateRegistry.storageFee",
  "xmtp.rateRegistry.targetRatePerMinute",
  "xmtp.settlementChainGateway.migrator",
  "xmtp.settlementChainGateway.paused",
  "xmtp.settlementChainParameterRegistry.migrator",
];

const ZERO_BYTES32 = "0x" + "0".repeat(64);

function isAddressKey(key) {
  return (
    key.endsWith(".admin") ||
    key.endsWith(".settler") ||
    key.endsWith(".feeDistributor") ||
    key.endsWith(".protocolFeesRecipient") ||
    key.endsWith(".payloadBootstrapper") ||
    key.endsWith(".migrator")
  );
}

function isBoolKey(key) {
  return key.endsWith(".paused");
}

function decodeParameterValue(key, bytes32Value) {
  const hex =
    typeof bytes32Value === "string"
      ? bytes32Value
      : "0x" + bytes32Value.toString(16).padStart(64, "0");
  if (!hex || hex === ZERO_BYTES32) return null;
  if (isAddressKey(key)) {
    return ethers.getAddress("0x" + hex.slice(26));
  }
  if (isBoolKey(key)) {
    return BigInt(hex) === 1n;
  }
  return BigInt(hex).toString();
}

async function readParameterValues(contract) {
  try {
    const values = await contract["get(string[])"](KNOWN_PARAMETER_KEYS);
    const result = {};
    for (let i = 0; i < KNOWN_PARAMETER_KEYS.length; i++) {
      result[KNOWN_PARAMETER_KEYS[i]] = decodeParameterValue(
        KNOWN_PARAMETER_KEYS[i],
        values[i],
      );
    }
    return result;
  } catch {
    // Fall back to individual queries
    const result = {};
    const promises = KNOWN_PARAMETER_KEYS.map(async (key) => {
      try {
        const value = await contract["get(string)"](key);
        result[key] = decodeParameterValue(key, value);
      } catch {
        result[key] = null;
      }
    });
    await Promise.allSettled(promises);
    return result;
  }
}

// Read last payer report per originator from PayerReportSubmitted events
async function readLastPayerReports(contract, provider) {
  try {
    const filter = contract.filters.PayerReportSubmitted();
    let events;

    try {
      // Try querying all events from block 0
      events = await contract.queryFilter(filter);
    } catch {
      // Some providers limit range - fall back to recent blocks
      const currentBlock = await provider.getBlockNumber();
      events = await contract.queryFilter(
        filter,
        Math.max(0, currentBlock - 500000),
      );
    }

    if (!events || events.length === 0) return [];

    // Group by originator, keep highest payerReportIndex
    const latestByOriginator = {};
    for (const event of events) {
      const originatorNodeId = Number(event.args.originatorNodeId);
      const payerReportIndex = Number(event.args.payerReportIndex);

      if (
        !latestByOriginator[originatorNodeId] ||
        payerReportIndex > latestByOriginator[originatorNodeId]
      ) {
        latestByOriginator[originatorNodeId] = payerReportIndex;
      }
    }

    const originatorIds = Object.keys(latestByOriginator).map(Number);
    const indices = originatorIds.map((id) => latestByOriginator[id]);

    // Batch fetch actual report structs
    let reports;
    try {
      reports = await contract.getPayerReports(originatorIds, indices);
    } catch {
      // Fall back to individual calls
      reports = await Promise.all(
        originatorIds.map((id, i) =>
          safeCall(contract, "getPayerReport", id, indices[i]),
        ),
      );
    }

    return originatorIds
      .map((id, i) => {
        const r = reports[i];
        if (!r) return null;
        return {
          originatorNodeId: id,
          reportIndex: indices[i],
          startSequenceId: r.startSequenceId,
          endSequenceId: r.endSequenceId,
          endMinuteSinceEpoch: Number(r.endMinuteSinceEpoch),
          feesSettled: r.feesSettled,
          offset: Number(r.offset),
          isSettled: r.isSettled,
          protocolFeeRate: Number(r.protocolFeeRate),
          payersMerkleRoot: r.payersMerkleRoot,
          nodeIds: r.nodeIds ? Array.from(r.nodeIds).map(Number) : [],
        };
      })
      .filter(Boolean);
  } catch (err) {
    if (process.env.DEBUG) {
      console.debug(`readLastPayerReports failed: ${err.message}`);
    }
    return null;
  }
}

// Helper: query events with fallback to recent blocks on range errors
async function queryEventsWithFallback(contract, filter, provider) {
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

// Read all payers with balances, totals deposited/settled, and pending withdrawals
async function readPayers(contract, provider) {
  try {
    // Query Deposit and UsageSettled events in parallel
    const [depositEvents, settledEvents] = await Promise.all([
      queryEventsWithFallback(contract, contract.filters.Deposit(), provider),
      queryEventsWithFallback(contract, contract.filters.UsageSettled(), provider).catch(() => []),
    ]);

    if (!depositEvents || depositEvents.length === 0) return [];

    // Accumulate total deposited per payer
    const depositsByPayer = {};
    for (const event of depositEvents) {
      const payer = event.args.payer;
      depositsByPayer[payer] = (depositsByPayer[payer] ?? 0n) + event.args.amount;
    }

    // Accumulate total settled per payer
    const settledByPayer = {};
    for (const event of settledEvents || []) {
      const payer = event.args.payer;
      settledByPayer[payer] = (settledByPayer[payer] ?? 0n) + event.args.amount;
    }

    const payers = Object.keys(depositsByPayer);

    // Batch fetch balances + pending withdrawals in parallel
    let balances;
    try {
      balances = await contract.getBalances(payers);
    } catch {
      balances = await Promise.all(
        payers.map((p) => safeCall(contract, "getBalance", p)),
      );
    }

    const pendingWithdrawals = await Promise.all(
      payers.map((p) => safeCall(contract, "getPendingWithdrawal", p)),
    );

    return payers.map((address, i) => {
      const pw = pendingWithdrawals[i];
      return {
        address,
        balance: balances[i] !== null && balances[i] !== undefined ? balances[i] : null,
        totalDeposited: depositsByPayer[address] ?? null,
        totalSettled: settledByPayer[address] ?? null,
        pendingWithdrawal: pw ? pw[0] : null,
        withdrawableTimestamp: pw ? Number(pw[1]) : null,
      };
    });
  } catch (err) {
    if (process.env.DEBUG) {
      console.debug(`readPayers failed: ${err.message}`);
    }
    return null;
  }
}

// Read version from a contract
async function readVersion(env, chain, contractDef) {
  const address = getContractAddress(env, contractDef);
  if (!address) return null;
  const provider = getProvider(env, chain);
  const contract = getContract(address, contractDef.abiFile, provider);
  return safeCall(contract, "version");
}

// Get all versions across all environments
async function getAllVersions() {
  const results = {};

  const promises = [];

  for (const env of ENVIRONMENTS) {
    results[env] = { settlement: {}, app: {} };

    for (const def of SETTLEMENT_CONTRACTS) {
      promises.push(
        readVersion(env, "settlement", def).then((v) => {
          results[env].settlement[def.name] = v;
        }),
      );
    }

    for (const def of APP_CONTRACTS) {
      promises.push(
        readVersion(env, "app", def).then((v) => {
          results[env].app[def.name] = v;
        }),
      );
    }
  }

  await Promise.allSettled(promises);
  return results;
}

// Read paused status from a contract (returns true/false/null)
async function readPaused(env, chain, contractDef) {
  const address = getContractAddress(env, contractDef);
  if (!address) return null;
  const provider = getProvider(env, chain);
  const contract = getContract(address, contractDef.abiFile, provider);
  return safeCall(contract, "paused");
}

// Get paused status across all environments
async function getAllPausedStatus() {
  const results = {};
  const promises = [];

  for (const env of ENVIRONMENTS) {
    results[env] = { settlement: {}, app: {} };

    for (const def of SETTLEMENT_CONTRACTS) {
      promises.push(
        readPaused(env, "settlement", def).then((v) => {
          results[env].settlement[def.name] = v;
        }),
      );
    }

    for (const def of APP_CONTRACTS) {
      promises.push(
        readPaused(env, "app", def).then((v) => {
          results[env].app[def.name] = v;
        }),
      );
    }
  }

  await Promise.allSettled(promises);
  return results;
}

// State readers per contract type
const stateReaders = {
  NodeRegistry: async (contract) => {
    const [
      admin,
      adminParameterKey,
      maxCanonicalNodes,
      canonicalNodesCount,
      nodeCount,
      allNodes,
      canonicalNodes,
      parameterRegistry,
    ] = await Promise.all([
      safeCall(contract, "admin"),
      safeCall(contract, "adminParameterKey"),
      safeCall(contract, "maxCanonicalNodes"),
      safeCall(contract, "canonicalNodesCount"),
      safeCall(contract, "getAllNodesCount"),
      safeCall(contract, "getAllNodes"),
      safeCall(contract, "getCanonicalNodes"),
      safeCall(contract, "parameterRegistry"),
    ]);

    const nodes = allNodes
      ? Array.from(allNodes).map((n) => ({
          nodeId: Number(n.nodeId),
          signer: n.node.signer,
          isCanonical: n.node.isCanonical,
          httpAddress: n.node.httpAddress,
        }))
      : [];

    return {
      admin,
      adminParameterKey,
      maxCanonicalNodes,
      canonicalNodesCount:
        canonicalNodesCount !== null ? Number(canonicalNodesCount) : null,
      nodeCount: nodeCount !== null ? Number(nodeCount) : null,
      canonicalNodes: canonicalNodes
        ? Array.from(canonicalNodes).map(Number)
        : [],
      allNodes: nodes,
      parameterRegistry,
    };
  },

  PayerRegistry: async (contract, provider) => {
    const [
      feeToken, settler, feeDistributor, minimumDeposit, withdrawLockPeriod,
      totalDeposits, totalDebt, totalWithdrawable, excess, paused, parameterRegistry, payers,
    ] = await Promise.all([
      safeCall(contract, "feeToken"),
      safeCall(contract, "settler"),
      safeCall(contract, "feeDistributor"),
      safeCall(contract, "minimumDeposit"),
      safeCall(contract, "withdrawLockPeriod"),
      safeCall(contract, "totalDeposits"),
      safeCall(contract, "totalDebt"),
      safeCall(contract, "totalWithdrawable"),
      safeCall(contract, "excess"),
      safeCall(contract, "paused"),
      safeCall(contract, "parameterRegistry"),
      readPayers(contract, provider),
    ]);

    // Fetch decimals from the feeToken contract
    let feeTokenDecimals = null;
    if (feeToken) {
      try {
        const ftContract = new ethers.Contract(
          feeToken,
          ["function decimals() view returns (uint8)"],
          provider,
        );
        feeTokenDecimals = Number(await ftContract.decimals());
      } catch { /* leave null */ }
    }

    return {
      feeToken, settler, feeDistributor, minimumDeposit, withdrawLockPeriod,
      totalDeposits, totalDebt, totalWithdrawable, excess, paused, parameterRegistry,
      feeTokenDecimals, payers,
    };
  },

  PayerReportManager: async (contract, provider) => ({
    nodeRegistry: await safeCall(contract, "nodeRegistry"),
    payerRegistry: await safeCall(contract, "payerRegistry"),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
    protocolFeeRate: await safeCall(contract, "protocolFeeRate"),
    lastPayerReports: await readLastPayerReports(contract, provider),
  }),

  RateRegistry: async (contract) => ({
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
    ratesCount: await safeCall(contract, "getRatesCount"),
  }),

  DistributionManager: async (contract) => ({
    nodeRegistry: await safeCall(contract, "nodeRegistry"),
    payerReportManager: await safeCall(contract, "payerReportManager"),
    payerRegistry: await safeCall(contract, "payerRegistry"),
    feeToken: await safeCall(contract, "feeToken"),
    protocolFeesRecipient: await safeCall(contract, "protocolFeesRecipient"),
    owedProtocolFees: await safeCall(contract, "owedProtocolFees"),
    totalOwedFees: await safeCall(contract, "totalOwedFees"),
    paused: await safeCall(contract, "paused"),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
  }),

  FeeToken: async (contract) => ({
    name: await safeCall(contract, "name"),
    symbol: await safeCall(contract, "symbol"),
    decimals: await safeCall(contract, "decimals"),
    totalSupply: await safeCall(contract, "totalSupply"),
    underlying: await safeCall(contract, "underlying"),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
  }),

  SettlementChainGateway: async (contract) => ({
    appChainGateway: await safeCall(contract, "appChainGateway"),
    feeToken: await safeCall(contract, "feeToken"),
    paused: await safeCall(contract, "paused"),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
  }),

  SettlementChainParameterRegistry: async (contract) => ({
    knownParameters: await readParameterValues(contract),
  }),

  DepositSplitter: async (contract) => ({
    feeToken: await safeCall(contract, "feeToken"),
    payerRegistry: await safeCall(contract, "payerRegistry"),
    settlementChainGateway: await safeCall(contract, "settlementChainGateway"),
    appChainId: await safeCall(contract, "appChainId"),
  }),

  Factory: async (contract) => ({
    paused: await safeCall(contract, "paused"),
    initializableImplementation: await safeCall(
      contract,
      "initializableImplementation",
    ),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
  }),

  AppChainGateway: async (contract) => ({
    settlementChainGateway: await safeCall(contract, "settlementChainGateway"),
    settlementChainGatewayAlias: await safeCall(
      contract,
      "settlementChainGatewayAlias",
    ),
    paused: await safeCall(contract, "paused"),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
  }),

  AppChainParameterRegistry: async (contract) => ({
    knownParameters: await readParameterValues(contract),
  }),

  GroupMessageBroadcaster: async (contract) => ({
    minPayloadSize: await safeCall(contract, "minPayloadSize"),
    maxPayloadSize: await safeCall(contract, "maxPayloadSize"),
    payloadBootstrapper: await safeCall(contract, "payloadBootstrapper"),
    paused: await safeCall(contract, "paused"),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
  }),

  IdentityUpdateBroadcaster: async (contract) => ({
    minPayloadSize: await safeCall(contract, "minPayloadSize"),
    maxPayloadSize: await safeCall(contract, "maxPayloadSize"),
    payloadBootstrapper: await safeCall(contract, "payloadBootstrapper"),
    paused: await safeCall(contract, "paused"),
    parameterRegistry: await safeCall(contract, "parameterRegistry"),
  }),
};

// Format values for display
function formatValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "boolean") return val;
  if (Array.isArray(val)) return val.map(formatValue);
  if (typeof val === "object") {
    const formatted = {};
    for (const [key, v] of Object.entries(val)) {
      formatted[key] = formatValue(v);
    }
    return formatted;
  }
  return String(val);
}

function formatState(state) {
  const formatted = {};
  for (const [key, val] of Object.entries(state)) {
    formatted[key] = formatValue(val);
  }
  return formatted;
}

// Read full contract details
async function readContractDetails(env, chain, contractName) {
  const allContracts =
    chain === "settlement" ? SETTLEMENT_CONTRACTS : APP_CONTRACTS;
  const contractDef = allContracts.find((c) => c.name === contractName);
  if (!contractDef)
    throw new Error(`Unknown contract: ${contractName} on ${chain}`);

  const address = getContractAddress(env, contractDef);
  if (!address)
    return { error: `Contract ${contractName} not found in ${env}` };

  const provider = getProvider(env, chain);
  const contract = getContract(address, contractDef.abiFile, provider);

  const [version, implementation, contractNameOnChain] = await Promise.all([
    safeCall(contract, "version"),
    safeCall(contract, "implementation"),
    safeCall(contract, "contractName"),
  ]);

  const reader = stateReaders[contractName];
  const state = reader ? formatState(await reader(contract, provider)) : {};

  const envFile = envFiles[env];

  return {
    name: contractName,
    contractNameOnChain,
    version,
    address,
    implementation,
    chain,
    chainId:
      chain === "settlement"
        ? envFile.settlementChainId || null
        : envFile.appChainId || null,
    environment: env,
    explorer: EXPLORERS[env]?.[chain] || null,
    state,
  };
}

// Config drift detection
async function getConfigDrift(env) {
  const envFile = envFiles[env];
  const config = configFiles[env];
  const results = { addressComparison: [], implementationComparison: [] };

  // Part A: Config vs Environment file address comparison
  const addressMappings = [
    {
      label: "settlementChainId",
      configKey: "settlementChainId",
      envKey: "settlementChainId",
    },
    { label: "appChainId", configKey: "appChainId", envKey: "appChainId" },
    { label: "deployer", configKey: "deployer", envKey: "deployer" },
    {
      label: "underlyingFeeToken",
      configKey: "underlyingFeeToken",
      envKey: "underlyingFeeToken",
    },
  ];

  // Add contract proxy address comparisons
  for (const def of SETTLEMENT_CONTRACTS) {
    addressMappings.push({
      label: def.name,
      configKey: def.configProxyKey,
      envKey: def.envKey,
      chain: "settlement",
    });
  }
  for (const def of APP_CONTRACTS) {
    addressMappings.push({
      label: def.name,
      configKey: def.configProxyKey,
      envKey: def.envKey,
      chain: "app",
    });
  }

  for (const mapping of addressMappings) {
    const configVal = String(config[mapping.configKey] || "");
    const envVal = String(envFile[mapping.envKey] || "");
    const match = configVal.toLowerCase() === envVal.toLowerCase();
    results.addressComparison.push({
      label: mapping.label,
      chain: mapping.chain || null,
      configValue: configVal || null,
      envValue: envVal || null,
      match,
    });
  }

  // Part B: Config implementation addresses vs on-chain
  const implPromises = [];

  for (const def of SETTLEMENT_CONTRACTS) {
    if (!def.configImplKey) continue;
    const address = getContractAddress(env, def);
    if (!address) continue;

    const configImpl = config[def.configImplKey] || null;
    implPromises.push(
      (async () => {
        const provider = getProvider(env, "settlement");
        const contract = getContract(address, def.abiFile, provider);
        const onChainImpl = await safeCall(contract, "implementation");
        const match =
          configImpl && onChainImpl
            ? configImpl.toLowerCase() === onChainImpl.toLowerCase()
            : false;
        return {
          label: def.name,
          chain: "settlement",
          proxyAddress: address,
          configImplementation: configImpl,
          onChainImplementation: onChainImpl,
          match,
        };
      })(),
    );
  }

  for (const def of APP_CONTRACTS) {
    if (!def.configImplKey) continue;
    const address = getContractAddress(env, def);
    if (!address) continue;

    const configImpl = config[def.configImplKey] || null;
    implPromises.push(
      (async () => {
        const provider = getProvider(env, "app");
        const contract = getContract(address, def.abiFile, provider);
        const onChainImpl = await safeCall(contract, "implementation");
        const match =
          configImpl && onChainImpl
            ? configImpl.toLowerCase() === onChainImpl.toLowerCase()
            : false;
        return {
          label: def.name,
          chain: "app",
          proxyAddress: address,
          configImplementation: configImpl,
          onChainImplementation: onChainImpl,
          match,
        };
      })(),
    );
  }

  results.implementationComparison = await Promise.all(implPromises);
  return results;
}

async function getAllBalances() {
  // eslint-disable-next-line global-require
  const addressData = require("../config/addresses.json");

  const results = {};
  const decimalsCache = {};

  async function getDecimals(tokenAddress, provider, cacheKey) {
    if (decimalsCache[cacheKey] !== undefined) return decimalsCache[cacheKey];
    try {
      const c = new ethers.Contract(tokenAddress, MINIMAL_ERC20_ABI, provider);
      decimalsCache[cacheKey] = Number(await c.decimals());
    } catch {
      decimalsCache[cacheKey] = 6;
    }
    return decimalsCache[cacheKey];
  }

  async function getErc20Balance(tokenAddress, walletAddress, provider) {
    try {
      const c = new ethers.Contract(tokenAddress, MINIMAL_ERC20_ABI, provider);
      return (await c.balanceOf(walletAddress)).toString();
    } catch {
      return null;
    }
  }

  const promises = [];

  for (const env of ENVIRONMENTS) {
    results[env] = {};
    const envFile = envFiles[env];
    const settlementProvider = getProvider(env, "settlement");
    const appProvider = getProvider(env, "app");
    const underlyingToken = envFile.underlyingFeeToken;

    for (const [signingType, roles] of Object.entries(addressData[env] || {})) {
      results[env][signingType] = {};
      for (const [role, address] of Object.entries(roles)) {
        results[env][signingType][role] = { address };
        const entry = results[env][signingType][role];

        promises.push(
          Promise.allSettled([
            settlementProvider
              .getBalance(address)
              .then((v) => v.toString())
              .catch(() => null),
            getErc20Balance(underlyingToken, address, settlementProvider),
            // xUSD is the native gas token on the app chain — use getBalance, not ERC20
            appProvider
              .getBalance(address)
              .then((v) => v.toString())
              .catch(() => null),
            getDecimals(
              underlyingToken,
              settlementProvider,
              `${env}:underlying`,
            ),
            // App chain native token uses 18 decimals
            Promise.resolve(18),
          ]).then(([eth, underlying, feeToken, underlyingDec, feeTokenDec]) => {
            entry.ethBalance = eth.value ?? null;
            entry.underlyingBalance = underlying.value ?? null;
            entry.underlyingDecimals = underlyingDec.value ?? 6;
            entry.feeTokenBalance = feeToken.value ?? null;
            entry.feeTokenDecimals = feeTokenDec.value ?? 18;
          }),
        );
      }
    }
  }

  await Promise.allSettled(promises);
  return results;
}

module.exports = {
  getAllVersions,
  getAllPausedStatus,
  readContractDetails,
  getConfigDrift,
  getAllBalances,
};
