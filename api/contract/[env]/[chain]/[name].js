const { readContractDetails } = require("../../../../src/contracts");
const {
  ENVIRONMENTS,
  SETTLEMENT_CONTRACTS,
  APP_CONTRACTS,
} = require("../../../../src/config");

const VALID_CONTRACT_NAMES = new Set([
  ...SETTLEMENT_CONTRACTS.map((c) => c.name),
  ...APP_CONTRACTS.map((c) => c.name),
]);

module.exports = async function handler(req, res) {
  const { env, chain, name } = req.query;

  if (!ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Invalid environment: ${env}` });
  }
  if (!["settlement", "app"].includes(chain)) {
    return res.status(400).json({ error: `Invalid chain: ${chain}` });
  }
  if (!VALID_CONTRACT_NAMES.has(name)) {
    return res.status(400).json({ error: "Invalid contract name" });
  }

  try {
    const details = await readContractDetails(env, chain, name);
    res.json(details);
  } catch (err) {
    console.error(`Error reading ${name} on ${env}/${chain}:`, err);
    res.status(500).json({ error: err.message });
  }
};
