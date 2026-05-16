# Flight Globe

Type a flight number (e.g. `VIR155`) and see its **filed flight plan** and
**actual flown track** drawn on a 3D globe you can spin with the mouse.

Uses [FlightAware AeroAPI](https://www.flightaware.com/commercial/aeroapi/)
as the single data source.

## Setup

```sh
npm install
cp .env.example .env   # then edit .env and paste your FlightAware AeroAPI key
npm run dev
```

This starts:

- the Express proxy on `http://localhost:5174` (holds the FlightAware key)
- the Vite dev server on `http://localhost:5173` (the UI)

Open <http://localhost:5173> and enter an ident like `VIR155` or `BA286`.

## Layers

- **Great-circle** (blue) — the theoretical shortest path between origin and destination.
- **Filed route** (white) — the route FlightAware shows on its website,
  reconstructed by merging the raw textual route (oceanic lat/lon fixes) with
  the API's decoded fix list (named navaids).
- **Actual track** (red) — actual ADS-B positions, including Aireon satellite
  data over oceans.

## How the filed route is reconstructed

FlightAware's `/route` endpoint returns *decoded* fixes but is often incomplete
for transatlantic flights (missing oceanic waypoints, sometimes resolving
ambiguous names like `TNT` to the wrong navaid). To work around this we:

1. Fetch the raw textual route from the flight summary (`flight.route` field).
2. Walk the tokens in order. Each token is either:
   - An airway designator (`T418`, `UN601`) — ignored.
   - An explicit lat/lon (`620000N/0200000W`) — parsed directly; this gives us
     all the oceanic waypoints with their true coordinates.
   - A named fix (`POL`, `DURUR`) — looked up in the `/route` decode, filtered
     against a detour-budget check to drop wrong-globally-resolved navaids.
3. Bracketed with origin/destination airport coordinates from `/airports/{icao}`.

## Cost

Each flight lookup uses roughly 4 AeroAPI queries (flight summary, two airport
lookups, route, optionally track). Responses are cached in-memory in the proxy
for 1–60 minutes, so toggling layers or re-loading the same flight is free.

## Layout

```
client/   Vite + TypeScript + Three.js UI
server/   Express + TypeScript proxy
```
