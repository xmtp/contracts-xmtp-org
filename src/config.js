const path = require("path");
const fs = require("fs");

const ENVIRONMENTS = ["testnet-dev", "testnet-staging", "testnet", "mainnet"];

// Load JSON files
function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to load ${filePath}: ${err.message}`);
  }
}

// Load all environment and config files
const envFiles = {};
const configFiles = {};
for (const env of ENVIRONMENTS) {
  envFiles[env] = loadJson(
    path.join(__dirname, "..", "config", "environments", `${env}.json`),
  );
  configFiles[env] = loadJson(
    path.join(__dirname, "..", "config", "params", `${env}.json`),
  );
}

// RPC URL mapping
function getRpcUrls() {
  return {
    "testnet-dev": {
      settlement: process.env.BASE_SEPOLIA_RPC_URL,
      app: process.env.XMTP_TESTNET_RPC_URL,
    },
    "testnet-staging": {
      settlement: process.env.BASE_SEPOLIA_RPC_URL,
      app: process.env.XMTP_TESTNET_RPC_URL,
    },
    testnet: {
      settlement: process.env.BASE_SEPOLIA_RPC_URL,
      app: process.env.XMTP_TESTNET_RPC_URL,
    },
    mainnet: {
      settlement: process.env.BASE_MAINNET_RPC_URL,
      app: process.env.XMTP_MAINNET_RPC_URL,
    },
  };
}

// Block explorer URLs
const EXPLORERS = {
  "testnet-dev": {
    settlement: "https://sepolia.basescan.org",
    app: "https://xmtp-ropsten.explorer.alchemy.com",
  },
  "testnet-staging": {
    settlement: "https://sepolia.basescan.org",
    app: "https://xmtp-ropsten.explorer.alchemy.com",
  },
  testnet: {
    settlement: "https://sepolia.basescan.org",
    app: "https://xmtp-ropsten.explorer.alchemy.com",
  },
  mainnet: {
    settlement: "https://basescan.org",
    app: "https://xmtp-mainnet.explorer.alchemy.com",
  },
};

// Contract definitions: which contracts live on which chain
// and how to find their addresses in config/environment files
const SETTLEMENT_CONTRACTS = [
  {
    name: "NodeRegistry",
    configProxyKey: "nodeRegistryProxy",
    configImplKey: "nodeRegistryImplementation",
    envKey: "nodeRegistry",
    abiFile: "NodeRegistry",
  },
  {
    name: "PayerRegistry",
    configProxyKey: "payerRegistryProxy",
    configImplKey: "payerRegistryImplementation",
    envKey: "payerRegistry",
    abiFile: "PayerRegistry",
  },
  {
    name: "PayerReportManager",
    configProxyKey: "payerReportManagerProxy",
    configImplKey: "payerReportManagerImplementation",
    envKey: "payerReportManager",
    abiFile: "PayerReportManager",
  },
  {
    name: "RateRegistry",
    configProxyKey: "rateRegistryProxy",
    configImplKey: "rateRegistryImplementation",
    envKey: "rateRegistry",
    abiFile: "RateRegistry",
  },
  {
    name: "DistributionManager",
    configProxyKey: "distributionManagerProxy",
    configImplKey: "distributionManagerImplementation",
    envKey: "distributionManager",
    abiFile: "DistributionManager",
  },
  {
    name: "FeeToken",
    configProxyKey: "feeTokenProxy",
    configImplKey: "feeTokenImplementation",
    envKey: "feeToken",
    abiFile: "FeeToken",
  },
  {
    name: "SettlementChainGateway",
    // gatewayProxy is shared with AppChainGateway (same CREATE2 address on both chains)
    configProxyKey: "gatewayProxy",
    configImplKey: "settlementChainGatewayImplementation",
    envKey: "settlementChainGateway",
    abiFile: "SettlementChainGateway",
  },
  {
    name: "SettlementChainParameterRegistry",
    // parameterRegistryProxy is shared with AppChainParameterRegistry (same CREATE2 address)
    configProxyKey: "parameterRegistryProxy",
    configImplKey: "settlementChainParameterRegistryImplementation",
    envKey: "settlementChainParameterRegistry",
    abiFile: "SettlementChainParameterRegistry",
  },
  {
    name: "DepositSplitter",
    configProxyKey: "depositSplitter",
    configImplKey: null, // not proxied in the usual way
    envKey: "depositSplitter",
    abiFile: "DepositSplitter",
  },
  {
    name: "Factory",
    configProxyKey: "factory",
    configImplKey: "factoryImplementation",
    envKey: "settlementChainFactory",
    abiFile: "Factory",
  },
];

const APP_CONTRACTS = [
  {
    name: "AppChainGateway",
    configProxyKey: "gatewayProxy",
    configImplKey: "appChainGatewayImplementation",
    envKey: "appChainGateway",
    abiFile: "AppChainGateway",
  },
  {
    name: "AppChainParameterRegistry",
    configProxyKey: "parameterRegistryProxy",
    configImplKey: "appChainParameterRegistryImplementation",
    envKey: "appChainParameterRegistry",
    abiFile: "AppChainParameterRegistry",
  },
  {
    name: "GroupMessageBroadcaster",
    configProxyKey: "groupMessageBroadcasterProxy",
    configImplKey: "groupMessageBroadcasterImplementation",
    envKey: "groupMessageBroadcaster",
    abiFile: "GroupMessageBroadcaster",
  },
  {
    name: "IdentityUpdateBroadcaster",
    configProxyKey: "identityUpdateBroadcasterProxy",
    configImplKey: "identityUpdateBroadcasterImplementation",
    envKey: "identityUpdateBroadcaster",
    abiFile: "IdentityUpdateBroadcaster",
  },
];

// Load ABIs
const abis = {};
function loadAbi(name) {
  if (!abis[name]) {
    abis[name] = loadJson(path.join(__dirname, "abis", `${name}.json`));
  }
  return abis[name];
}

// Get contract address for a given environment + contract definition
function getContractAddress(env, contractDef) {
  const envFile = envFiles[env];
  return envFile[contractDef.envKey] || null;
}

// Get expected addresses from config
function getConfigAddresses(env, contractDef) {
  const config = configFiles[env];
  return {
    proxy: config[contractDef.configProxyKey] || null,
    implementation: contractDef.configImplKey
      ? config[contractDef.configImplKey] || null
      : null,
  };
}

module.exports = {
  ENVIRONMENTS,
  SETTLEMENT_CONTRACTS,
  APP_CONTRACTS,
  EXPLORERS,
  envFiles,
  configFiles,
  getRpcUrls,
  loadAbi,
  getContractAddress,
  getConfigAddresses,
};
