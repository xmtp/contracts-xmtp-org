const { getAllVersions } = require("../src/contracts");

module.exports = async function handler(req, res) {
  try {
    const versions = await getAllVersions();
    res.json(versions);
  } catch (err) {
    console.error("Error fetching versions:", err);
    res.status(500).json({ error: err.message });
  }
};
