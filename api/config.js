
module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  return res.status(200).json({
    source: "ADSB.fi",
    fallbackSource: "ADSB.lol",
    authenticated: false,
    refreshAfterMs: 60000,
    maxRadiusKm: 300
  });
};
