
require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const CACHE_TTL_MS = 15000;
const responseCache = new Map();

const PROVIDERS = [
  {
    name: "ADSB.fi",
    baseUrl: "https://opendata.adsb.fi/api/v3"
  },
  {
    name: "ADSB.lol",
    baseUrl: "https://api.adsb.lol/v2"
  }
];

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    source: "ADSB.fi",
    fallbackSource: "ADSB.lol",
    authenticated: false,
    refreshAfterMs: 60000,
    maxRadiusKm: 300
  });
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function distanceAndBearingKm(lat1, lon1, lat2, lon2) {
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthRadiusKm = 6371.0088;

  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) *
    Math.sin(dLon / 2) ** 2;

  const distanceKm =
    2 * earthRadiusKm *
    Math.asin(Math.sqrt(Math.min(1, a)));

  const y = Math.sin(dLon) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) -
    Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);

  const bearingDeg =
    (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  return { distanceKm, bearingDeg };
}

function toAircraftList(states, centerLat, centerLon, radiusKm) {
  if (!Array.isArray(states)) return [];

  return states
    .filter((a) =>
      a &&
      isFiniteNumber(a.lat) &&
      isFiniteNumber(a.lon)
    )
    .map((a) => {
      const { distanceKm, bearingDeg } =
        distanceAndBearingKm(
          centerLat,
          centerLon,
          a.lat,
          a.lon
        );

      return {
        icao24: String(a.hex || ""),
        callsign: String(a.flight || "").trim(),
        originCountry: a.r
          ? `Registration ${a.r}`
          : "Unknown origin",
        registration: a.r || null,
        aircraftType: a.t || null,
        timePosition: null,
        lastContact: null,
        longitude: a.lon,
        latitude: a.lat,

        baroAltitudeMeters: isFiniteNumber(a.alt_baro)
          ? a.alt_baro * 0.3048
          : null,

        geoAltitudeMeters: isFiniteNumber(a.alt_geom)
          ? a.alt_geom * 0.3048
          : null,

        onGround: a.alt_baro === "ground",

        velocityMs: isFiniteNumber(a.gs)
          ? a.gs * 0.514444
          : null,

        headingDeg: isFiniteNumber(a.track)
          ? a.track
          : isFiniteNumber(a.true_heading)
            ? a.true_heading
            : isFiniteNumber(a.calc_track)
              ? a.calc_track
              : null,

        verticalRateMs: isFiniteNumber(a.baro_rate)
          ? a.baro_rate * 0.00508
          : null,

        squawk: a.squawk == null
          ? null
          : String(a.squawk),

        distanceKm,
        bearingDeg
      };
    })
    .filter((a) => a.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

async function fetchAircraft(lat, lon, radiusKm) {
  const distanceNm = Math.ceil(radiusKm / 1.852);
  let emptyResult = null;
  const errors = [];

  for (const provider of PROVIDERS) {
    const url =
      `${provider.baseUrl}/lat/${lat}/lon/${lon}/dist/${distanceNm}`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "AircraftLiveRadar/1.0"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();

      if (!Array.isArray(payload.ac)) {
        throw new Error("Unexpected API response");
      }

      const aircraft = toAircraftList(
        payload.ac,
        lat,
        lon,
        radiusKm
      );

      if (aircraft.length > 0) {
        return {
          source: provider.name,
          dataTimestamp: payload.now || null,
          aircraft
        };
      }

      emptyResult = {
        source: provider.name,
        dataTimestamp: payload.now || null,
        aircraft: []
      };
    } catch (error) {
      errors.push(`${provider.name}: ${error.message}`);
      console.error(`${provider.name} error:`, error.message);
    }
  }

  if (emptyResult) return emptyResult;

  throw new Error(
    errors.join("; ") || "All aircraft providers failed"
  );
}

app.get("/api/aircraft", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  const rawRadius = req.query.radiusKm;
  const radiusKm =
    rawRadius === undefined || rawRadius === ""
      ? 150
      : Number(rawRadius);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 || lat > 90 ||
    lon < -180 || lon > 180
  ) {
    return res.status(400).json({
      error: "Valid latitude and longitude are required."
    });
  }

  if (
    !Number.isFinite(radiusKm) ||
    radiusKm < 1 ||
    radiusKm > 300
  ) {
    return res.status(400).json({
      error: "radiusKm must be between 1 and 300."
    });
  }

  const cacheKey =
    `${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}`;

  const cached = responseCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.savedAt < CACHE_TTL_MS
  ) {
    return res.json({
      ...cached.payload,
      cached: true
    });
  }

  try {
    const result = await fetchAircraft(lat, lon, radiusKm);

    const output = {
      source: result.source,
      center: { lat, lon },
      radiusKm,
      dataTimestamp: result.dataTimestamp,
      fetchedAt: Date.now(),
      aircraft: result.aircraft,
      cached: false
    };

    responseCache.set(cacheKey, {
      savedAt: Date.now(),
      payload: output
    });

    return res.json(output);
  } catch (error) {
    console.error("Aircraft API error:", error.message);

    return res.status(502).json({
      error: "Both aircraft data providers are unavailable. Please retry shortly."
    });
  }
});

// Serve the website for normal page requests.
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Aircraft Radar server listening on port ${PORT}`);
  console.log("Primary source: ADSB.fi");
  console.log("Fallback source: ADSB.lol");
});
