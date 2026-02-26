const { getAllPausedStatus } = require("../src/contracts");

module.exports = async function handler(req, res) {
  try {
    const paused = await getAllPausedStatus();
    res.json(paused);
  } catch (err) {
    console.error("Error fetching paused status:", err);
    res.status(500).json({ error: err.message });
  }
};
