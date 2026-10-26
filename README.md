# Aircraft Live Radar

A responsive radar-style web app that uses your browser's location and live aircraft state data from the OpenSky Network.

## What it does

- Requests location permission from your browser.
- Queries the OpenSky Network aircraft state endpoint for a nearby geographic bounding box.
- Calculates each aircraft's distance and bearing from your location.
- Shows an animated radar sweep, target dots, range slider, aircraft list, altitude, speed, heading, and country.
- Works on desktop and mobile browsers.

## Important limitations

- This is a visualization of online ADS-B tracking data, **not a physical radar**. It does not transmit radar signals.
- Aircraft visibility depends on OpenSky coverage, ADS-B availability, data latency, and API access.
- Anonymous OpenSky access has lower request limits. The app refreshes every five minutes without credentials; with configured credentials, it refreshes every minute. API limits and policies can change.
- This starter app does not persist your location in a database. Your browser sends coordinates to this local server only to request nearby aircraft data.
- The browser's location permission works on `localhost` during development and generally requires HTTPS when deployed.

## Requirements

- Node.js 18 or newer
- npm
- VS Code (recommended)

## Run locally

1. Extract the ZIP file.
2. Open the extracted `aircraft-live-radar` folder in VS Code.
3. Open **Terminal → New Terminal**.
4. Install packages:

   ```bash
   npm install
   ```

5. Optional: copy `.env.example` to `.env` and add your OpenSky API client credentials. Do not commit `.env` to GitHub.

   ```env
   OPENSKY_CLIENT_ID=your_client_id
   OPENSKY_CLIENT_SECRET=your_client_secret
   PORT=3000
   ```

   You can test without credentials, but anonymous access is more limited.

6. Start the app:

   ```bash
   npm start
   ```

7. Open `http://localhost:3000` in your browser.
8. Click **Use my location** and allow the browser location permission.

## OpenSky API credentials

Visit the OpenSky Network website, sign in, and create an API client from the account page. Use the generated client ID and secret in your server-side `.env` file. OpenSky currently uses OAuth2 client credentials; do not put the secret in browser JavaScript.

Official resources:
- API docs: https://openskynetwork.github.io/opensky-api/rest.html
- OpenSky FAQ and access policy: https://opensky-network.org/about/faq

## Deploying

Deploy the Node.js app to a host that supports a persistent Express server and HTTPS. Set `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` as server-side environment variables in the hosting provider's dashboard. The app must be served over HTTPS for reliable location permission on phones.

## Troubleshooting

- **Location button does nothing:** use `http://localhost:3000`, not a file opened directly from your folder. Allow location in browser site settings.
- **No aircraft appear:** increase the radar range, wait for the next refresh, or check the OpenSky source. No targets can mean no positions were returned for that area at that moment.
- **API limit reached:** wait for the retry period; do not repeatedly click Refresh. Anonymous usage has lower limits.
- **API credentials fail:** check that both values are correct and stored in `.env`, then restart the server.
- **Port in use:** change `PORT=3001` in `.env` and open `http://localhost:3001`.

## Data fields

OpenSky state vectors include aircraft transponder ID, callsign, country, longitude, latitude, altitude, on-ground flag, velocity and heading. Some fields can be missing. Distance and bearing are calculated by this app from the device location and reported aircraft coordinates.
