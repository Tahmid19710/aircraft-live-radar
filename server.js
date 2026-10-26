require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const OPENSKY_API = "https://opensky-network.org/api/states/all";
const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

const hasCredentials =
  Boolean(process.env.OPENSKY_CLIENT_ID) &&
  Boolean(process.env.OPENSKY_CLIENT_SECRET);

// OpenSky's anonymous quota is much lower, so use a longer cache/refresh interval.
const REFRESH_AFTER_MS = hasCredentials ? 60_000 : 300_000;
const CACHE_TTL_MS = REFRESH_AFTER_MS;
const responseCache = new Map();

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    source: "OpenSky Network",
    authenticated: hasCredentials,
    refreshAfterMs: REFRESH_AFTER_MS,
    maxRadiusKm: 300
  });
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function getBounds(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.max(0.15, Math.abs(Math.cos((lat * Math.PI) / 180)));
  const lonDelta = radiusKm / (111.32 * cosLat);

  return {
    lamin: Math.max(-90, lat - latDelta),
    lamax: Math.min(90, lat + latDelta),
    lomin: Math.max(-180, lon - lonDelta),
    lomax: Math.min(180, lon + lonDelta)
  };
}

function distanceAndBearingKm(lat1, lon1, lat2, lon2) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371.0088;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  const distanceKm = 2 * earthRadiusKm * Math.asin(Math.sqrt(Math.min(1, a)));

  const y = Math.sin(dLon) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) -
    Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  return { distanceKm, bearingDeg };
}

async function getAccessToken() {
  if (
    tokenCache.accessToken &&
    Date.now() < tokenCache.expiresAt - 60_000
  ) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.OPENSKY_CLIENT_ID,
    client_secret: process.env.OPENSKY_CLIENT_SECRET
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenSky token request failed (${response.status}): ${details.slice(0, 180)}`);
  }

  const data = await response.json();
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 1800) * 1000)
  };

  return tokenCache.accessToken;
}

function toAircraftList(states, centerLat, centerLon, radiusKm) {
  if (!Array.isArray(states)) return [];

  return states
    .filter((s) => Array.isArray(s) && isFiniteNumber(s[5]) && isFiniteNumber(s[6]))
    .map((s) => {
      const { distanceKm, bearingDeg } = distanceAndBearingKm(
        centerLat,
        centerLon,
        s[6],
        s[5]
      );

      return {
        icao24: String(s[0] || ""),
        callsign: String(s[1] || "").trim(),
        originCountry: String(s[2] || "Unknown"),
        timePosition: s[3] ?? null,
        lastContact: s[4] ?? null,
        longitude: s[5],
        latitude: s[6],
        baroAltitudeMeters: isFiniteNumber(s[7]) ? s[7] : null,
        onGround: Boolean(s[8]),
        velocityMs: isFiniteNumber(s[9]) ? s[9] : null,
        headingDeg: isFiniteNumber(s[10]) ? s[10] : null,
        verticalRateMs: isFiniteNumber(s[11]) ? s[11] : null,
        geoAltitudeMeters: isFiniteNumber(s[13]) ? s[13] : null,
        squawk: s[14] == null ? null : String(s[14]),
        distanceKm,
        bearingDeg
      };
    })
    .filter((aircraft) => aircraft.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

app.get("/api/aircraft", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusKm = Number(req.query.radiusKm || 150);

  if (
    !isFiniteNumber(lat) ||
    !isFiniteNumber(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return res.status(400).json({ error: "Valid lat and lon query parameters are required." });
  }

  if (!Number.isFinite(radiusKm) || radiusKm < 10 || radiusKm > 300) {
    return res.status(400).json({ error: "radiusKm must be between 10 and 300." });
  }

  const cacheKey = `${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}`;
  const cached = responseCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }

  try {
    const bounds = getBounds(lat, lon, radiusKm);
    const params = new URLSearchParams({
      lamin: String(bounds.lamin),
      lomin: String(bounds.lomin),
      lamax: String(bounds.lamax),
      lomax: String(bounds.lomax)
    });

    const headers = { Accept: "application/json" };
    if (hasCredentials) {
      headers.Authorization = `Bearer ${await getAccessToken()}`;
    }

    const apiResponse = await fetch(`${OPENSKY_API}?${params.toString()}`, {
      headers,
      signal: AbortSignal.timeout(20_000)
    });

    if (!apiResponse.ok) {
      const details = await apiResponse.text();
      const status = apiResponse.status === 429 ? 429 : 502;
      return res.status(status).json({
        error:
          apiResponse.status === 429
            ? "OpenSky rate limit reached. Wait before refreshing."
            : `OpenSky API request failed (${apiResponse.status}).`,
        details: details.slice(0, 180)
      });
    }

    const payload = await apiResponse.json();
    const aircraft = toAircraftList(payload.states, lat, lon, radiusKm);
    const result = {
      source: "OpenSky Network",
      center: { lat, lon },
      radiusKm,
      dataTimestamp: payload.time || null,
      fetchedAt: Date.now(),
      aircraft,
      cached: false
    };

    responseCache.set(cacheKey, { savedAt: Date.now(), payload: result });
    return res.json(result);
  } catch (error) {
    console.error("Aircraft API error:", error.message);
    return res.status(502).json({
      error: "Could not retrieve aircraft data. Check your internet connection and OpenSky API access."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Aircraft Radar is running at http://localhost:${PORT}`);
  console.log(`OpenSky mode: ${hasCredentials ? "authenticated" : "anonymous (lower request limits)"}`);
});
