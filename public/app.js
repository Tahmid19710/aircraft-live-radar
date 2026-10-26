const canvas = document.getElementById("radarCanvas");
const ctx = canvas.getContext("2d");

const locationButton = document.getElementById("locationButton");
const refreshButton = document.getElementById("refreshButton");
const radiusRange = document.getElementById("radiusRange");
const radiusValue = document.getElementById("radiusValue");
const locationText = document.getElementById("locationText");
const locationHint = document.getElementById("locationHint");
const connectionLabel = document.getElementById("connectionLabel");
const statusDot = document.querySelector(".status-dot");
const radarOverlay = document.getElementById("radarOverlay");
const aircraftList = document.getElementById("aircraftList");
const targetCount = document.getElementById("targetCount");
const inRangeStat = document.getElementById("inRangeStat");
const airborneStat = document.getElementById("airborneStat");
const updatedText = document.getElementById("updatedText");
const refreshNote = document.getElementById("refreshNote");

const state = {
  lat: null,
  lon: null,
  radiusKm: Number(radiusRange.value),
  aircraft: [],
  sweepAngle: 0,
  pollMs: 300000,
  refreshTimer: null,
  requestInProgress: false,
  locationReady: false
};

function setConnectionStatus(message, active = false) {
  connectionLabel.textContent = message;
  statusDot.classList.toggle("active", active);
}

function formatNumber(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function formatAltitude(meters) {
  if (!Number.isFinite(meters)) return "Unknown";
  return `${Math.round(meters * 3.28084).toLocaleString()} ft`;
}

function formatSpeed(metersPerSecond) {
  if (!Number.isFinite(metersPerSecond)) return "—";
  return `${Math.round(metersPerSecond * 1.943844)} kt`;
}

function formatBearing(degrees) {
  if (!Number.isFinite(degrees)) return "—";
  return `${Math.round(degrees)}°`;
}

function formatTime(timestampMs) {
  if (!Number.isFinite(timestampMs)) return "Waiting for data";
  return `Updated ${new Date(timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Could not read app configuration");
    const config = await response.json();
    state.pollMs = config.refreshAfterMs || 300000;
    refreshNote.textContent = config.authenticated
      ? "Authenticated OpenSky API mode. Your location is used to query the nearby area and is not saved by this app."
      : "Anonymous OpenSky mode refreshes every 5 minutes to respect lower request limits. Your location is not saved by this app.";
  } catch {
    state.pollMs = 300000;
  }
}

function requestLocation() {
  if (!navigator.geolocation) {
    setConnectionStatus("Location unavailable");
    locationHint.textContent = "This browser does not support geolocation. Try a modern browser.";
    return;
  }

  locationButton.disabled = true;
  locationButton.textContent = "Getting location…";
  setConnectionStatus("Requesting location");

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      state.lat = position.coords.latitude;
      state.lon = position.coords.longitude;
      state.locationReady = true;
      locationText.textContent = `${state.lat.toFixed(4)}°, ${state.lon.toFixed(4)}°`;
      locationHint.textContent = "Location is being used to centre the radar.";
      locationButton.textContent = "✓ Location enabled";
      locationButton.disabled = false;
      refreshButton.disabled = false;
      radarOverlay.classList.add("hidden");
      await loadConfig();
      await refreshAircraft();
    },
    (error) => {
      locationButton.disabled = false;
      locationButton.textContent = "◎ Try location again";
      setConnectionStatus("Location denied");
      const messages = {
        1: "Location permission was denied. Allow it in your browser's site settings.",
        2: "Your device could not determine its location. Try again near a window or check device location settings.",
        3: "Location request timed out. Please try again."
      };
      locationHint.textContent = messages[error.code] || "Could not access your location.";
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function scheduleNextRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  if (!state.locationReady) return;
  state.refreshTimer = setTimeout(refreshAircraft, state.pollMs);
}

async function refreshAircraft() {
  if (!state.locationReady || state.requestInProgress) return;

  state.requestInProgress = true;
  refreshButton.disabled = true;
  setConnectionStatus("Fetching aircraft", true);
  updatedText.textContent = "Fetching live data…";

  const query = new URLSearchParams({
    lat: String(state.lat),
    lon: String(state.lon),
    radiusKm: String(state.radiusKm)
  });

  try {
    const response = await fetch(`/api/aircraft?${query.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }

    state.aircraft = payload.aircraft || [];
    state.lastFetchedAt = payload.fetchedAt || Date.now();
    drawRadar();
    renderAircraftList();
    updatedText.textContent = formatTime(state.lastFetchedAt);
    setConnectionStatus("Tracking data available", true);
  } catch (error) {
    setConnectionStatus("Data unavailable");
    updatedText.textContent = error.message;
    renderError(error.message);
  } finally {
    state.requestInProgress = false;
    refreshButton.disabled = false;
    scheduleNextRefresh();
  }
}

function renderError(message) {
  aircraftList.replaceChildren();
  const box = document.createElement("div");
  box.className = "empty-state";
  const title = document.createElement("strong");
  title.textContent = "Could not load aircraft";
  const detail = document.createElement("span");
  detail.textContent = message;
  box.append(title, detail);
  aircraftList.append(box);
}

function renderAircraftList() {
  aircraftList.replaceChildren();
  const aircraft = [...state.aircraft].sort((a, b) => a.distanceKm - b.distanceKm);
  targetCount.textContent = String(aircraft.length);
  inRangeStat.textContent = String(aircraft.length);
  airborneStat.textContent = String(aircraft.filter((a) => !a.onGround).length);

  if (!aircraft.length) {
    const box = document.createElement("div");
    box.className = "empty-state";
    const symbol = document.createElement("div");
    symbol.className = "empty-symbol";
    symbol.textContent = "⌁";
    const title = document.createElement("strong");
    title.textContent = "No aircraft in range";
    const detail = document.createElement("span");
    detail.textContent = "No aircraft positions were returned inside this range. Try increasing the radar range or refresh later.";
    box.append(symbol, title, detail);
    aircraftList.append(box);
    return;
  }

  aircraft.slice(0, 40).forEach((aircraftData) => {
    const card = document.createElement("article");
    card.className = "target-card";

    const top = document.createElement("div");
    top.className = "target-top";
    const identity = document.createElement("div");
    const callsign = document.createElement("div");
    callsign.className = "callsign";
    callsign.textContent = aircraftData.callsign || aircraftData.icao24.toUpperCase() || "Unknown aircraft";
    const country = document.createElement("div");
    country.className = "target-country";
    country.textContent = `${aircraftData.originCountry || "Unknown country"} · ${aircraftData.icao24.toUpperCase()}`;
    identity.append(callsign, country);

    const distance = document.createElement("div");
    distance.className = "target-distance";
    distance.textContent = `${aircraftData.distanceKm.toFixed(1)} km`;
    top.append(identity, distance);

    const details = document.createElement("div");
    details.className = "target-details";
    details.append(
      makeDetail("ALTITUDE", formatAltitude(aircraftData.geoAltitudeMeters ?? aircraftData.baroAltitudeMeters)),
      makeDetail("SPEED", formatSpeed(aircraftData.velocityMs)),
      makeDetail("HEADING", formatBearing(aircraftData.headingDeg)),
      makeDetail("BEARING FROM YOU", formatBearing(aircraftData.bearingDeg))
    );

    const status = document.createElement("div");
    status.className = "target-country";
    status.textContent = aircraftData.onGround ? "On ground (ADS-B status)" : "Airborne (ADS-B status)";
    status.style.marginTop = "9px";

    card.append(top, details, status);
    aircraftList.append(card);
  });
}

function makeDetail(label, value) {
  const box = document.createElement("div");
  box.className = "detail";
  const caption = document.createElement("span");
  caption.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  box.append(caption, strong);
  return box;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRadar();
}

function angleDifference(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function drawRadar() {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (!width || !height) return;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.43;

  // Dark circular radar background.
  const bg = ctx.createRadialGradient(cx, cy, 2, cx, cy, radius);
  bg.addColorStop(0, "#0c2519");
  bg.addColorStop(1, "#06120d");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // Circular range rings and cardinal guides.
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.strokeStyle = i === 4 ? "rgba(91,255,155,.34)" : "rgba(91,255,155,.16)";
    ctx.arc(cx, cy, radius * i / 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(91,255,155,.15)";
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  ctx.fillStyle = "rgba(170,220,187,.7)";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", cx, cy - radius - 9);
  ctx.fillText("S", cx, cy + radius + 15);
  ctx.textAlign = "left";
  ctx.fillText("E", cx + radius + 8, cy + 3);
  ctx.textAlign = "right";
  ctx.fillText("W", cx - radius - 8, cy + 3);

  // Animated sweep wedge. This is a visual effect, not a physical radar emission.
  const sweep = state.sweepAngle;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, "rgba(91,255,155,.18)");
  gradient.addColorStop(1, "rgba(91,255,155,.01)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, radius, sweep - 0.20, sweep);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(91,255,155,.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.sin(sweep) * radius, cy - Math.cos(sweep) * radius);
  ctx.stroke();

  // Plot aircraft using their bearing from north and distance from the user.
  for (const aircraft of state.aircraft) {
    if (!Number.isFinite(aircraft.distanceKm) || !Number.isFinite(aircraft.bearingDeg)) continue;
    const targetRadius = Math.min(1, aircraft.distanceKm / state.radiusKm) * radius;
    const bearing = aircraft.bearingDeg * Math.PI / 180;
    const x = cx + Math.sin(bearing) * targetRadius;
    const y = cy - Math.cos(bearing) * targetRadius;
    const diff = Math.abs(angleDifference(sweep, bearing));
    const hit = diff < 0.16;

    ctx.beginPath();
    ctx.fillStyle = hit ? "#e7ffef" : (aircraft.onGround ? "#a6dcb8" : "#5bff9b");
    ctx.shadowColor = "#5bff9b";
    ctx.shadowBlur = hit ? 15 : 7;
    ctx.arc(x, y, hit ? 3.7 : 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (hit) {
      ctx.strokeStyle = "rgba(91,255,155,.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Label the 30 nearest targets with callsign, falling back to ICAO24.
    // This source does not reliably provide the aircraft model (e.g. Boeing 737).
    const aircraftIndex = state.aircraft.indexOf(aircraft);
    if (aircraftIndex < 30) {
      const rawLabel = (aircraft.callsign || aircraft.icao24 || "AIRCRAFT")
        .trim()
        .replace(/\s+/g, " ");
      const label = rawLabel.length > 10 ? rawLabel.slice(0, 10) : rawLabel;

      ctx.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      const textWidth = ctx.measureText(label).width;
      const boxWidth = textWidth + 8;
      const boxHeight = 16;
      let labelX = x + 8;
      let labelY = y - 19;

      // Keep labels inside the radar circle where possible.
      if (labelX + boxWidth > cx + radius - 2) labelX = x - boxWidth - 8;
      if (labelX < cx - radius + 2) labelX = x + 8;
      if (labelY < cy - radius + 2) labelY = y + 10;
      if (labelY + boxHeight > cy + radius - 2) labelY = y - 19;

      ctx.fillStyle = "rgba(3, 14, 9, 0.88)";
      ctx.strokeStyle = "rgba(91, 255, 155, 0.48)";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.roundRect(labelX, labelY, boxWidth, boxHeight, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = hit ? "#effff4" : "#a8ffc6";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, labelX + 4, labelY + boxHeight / 2);
      ctx.textBaseline = "alphabetic";
    }
  }

  // Your location marker.
  ctx.fillStyle = "#effff4";
  ctx.shadowColor = "#effff4";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(239,255,244,.65)";
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.stroke();
}

function animate() {
  state.sweepAngle = (state.sweepAngle + 0.012) % (Math.PI * 2);
  drawRadar();
  requestAnimationFrame(animate);
}

locationButton.addEventListener("click", requestLocation);
refreshButton.addEventListener("click", refreshAircraft);

radiusRange.addEventListener("input", () => {
  state.radiusKm = Number(radiusRange.value);
  radiusValue.textContent = String(state.radiusKm);
  drawRadar();
});

radiusRange.addEventListener("change", () => {
  if (state.locationReady) refreshAircraft();
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
animate();
