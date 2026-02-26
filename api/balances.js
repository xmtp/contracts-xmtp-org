const { getAllBalances } = require("../src/contracts");

module.exports = async function handler(req, res) {
  try {
    const balances = await getAllBalances();
    res.json(balances);
  } catch (err) {
    console.error("Error fetching balances:", err);
    res.status(500).json({ error: err.message });
  }
};
