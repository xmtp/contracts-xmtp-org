const { readRatesBatch } = require("../../../src/contracts");
const { ENVIRONMENTS } = require("../../../src/config");

module.exports = async function handler(req, res) {
  const { env, chain } = req.query;

  if (!ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Invalid environment: ${env}` });
  }
  if (!["settlement", "app"].includes(chain)) {
    return res.status(400).json({ error: `Invalid chain: ${chain}` });
  }

  const fromIndex = parseInt(req.query.fromIndex);
  const count = Math.min(parseInt(req.query.count) || 50, 50);

  if (isNaN(fromIndex) || fromIndex < 0) {
    return res.status(400).json({ error: "Missing or invalid fromIndex" });
  }
  if (count <= 0) {
    return res.status(400).json({ error: "count must be > 0" });
  }

  try {
    const rates = await readRatesBatch(env, chain, fromIndex, count);
    res.json({ rates, ratesOffset: fromIndex });
  } catch (err) {
    console.error(`Error fetching rates batch for ${env}/${chain}:`, err);
    res.status(500).json({ error: err.message });
  }
};
