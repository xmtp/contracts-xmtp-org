const {
  ENVIRONMENTS,
  SETTLEMENT_CONTRACTS,
  APP_CONTRACTS,
  EXPLORERS,
  envFiles,
} = require("../src/config");

module.exports = function handler(req, res) {
  try {
    const meta = {};
    for (const env of ENVIRONMENTS) {
      meta[env] = {
        settlement: {
          chainId: envFiles[env].settlementChainId,
          explorer: EXPLORERS[env].settlement,
          contracts: SETTLEMENT_CONTRACTS.map((c) => c.name),
          underlyingToken: envFiles[env].underlyingFeeToken,
          feeToken: envFiles[env].feeToken,
        },
        app: {
          chainId: envFiles[env].appChainId,
          explorer: EXPLORERS[env].app,
          contracts: APP_CONTRACTS.map((c) => c.name),
        },
      };
    }
    res.json({ environments: ENVIRONMENTS, meta });
  } catch (err) {
    console.error("Error building meta:", err);
    res.status(500).json({ error: err.message });
  }
};
