const { readPayerReportsBatch } = require("../../../src/contracts");
const { ENVIRONMENTS } = require("../../../src/config");

module.exports = async function handler(req, res) {
  const { env, chain } = req.query;

  if (!ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Invalid environment: ${env}` });
  }
  if (!["settlement", "app"].includes(chain)) {
    return res.status(400).json({ error: `Invalid chain: ${chain}` });
  }

  // Parse parallel arrays from query: originatorIds, indices, blockNumbers, txHashes, signingNodeIds
  // Each is a comma-separated string; signingNodeIds is a JSON-encoded array of arrays
  const { originatorIds, indices, blockNumbers, txHashes, signingNodeIds } = req.query;

  if (!originatorIds || !indices || !blockNumbers || !txHashes) {
    return res.status(400).json({ error: "Missing required query params: originatorIds, indices, blockNumbers, txHashes" });
  }

  const oIds = originatorIds.split(",").map(Number);
  const idxs = indices.split(",").map(Number);
  const blocks = blockNumbers.split(",").map(Number);
  const hashes = txHashes.split(",");
  let sNodeIds;
  try {
    sNodeIds = signingNodeIds ? JSON.parse(signingNodeIds) : oIds.map(() => []);
  } catch {
    sNodeIds = oIds.map(() => []);
  }

  if (oIds.length !== idxs.length || oIds.length !== blocks.length || oIds.length !== hashes.length) {
    return res.status(400).json({ error: "Array length mismatch in query params" });
  }

  const pairs = oIds.map((id, i) => ({
    originatorNodeId: id,
    reportIndex: idxs[i],
    blockNumber: blocks[i],
    txHash: hashes[i],
    signingNodeIds: Array.isArray(sNodeIds[i]) ? sNodeIds[i] : [],
  }));

  try {
    const reports = await readPayerReportsBatch(env, chain, pairs);
    res.json(reports);
  } catch (err) {
    console.error(`Error fetching payer reports batch for ${env}/${chain}:`, err);
    res.status(500).json({ error: err.message });
  }
};
