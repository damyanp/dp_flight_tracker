import { TTLCache } from './cache.js';

/**
 * FlightAware AeroAPI v4 client.
 *
 * Setup: get an API key at https://www.flightaware.com/commercial/aeroapi/
 * (pay-per-query; ~$5/mo minimum). Put it in .env as FLIGHTAWARE_API_KEY.
 *
 * What we fetch per flight lookup:
 *   GET /flights/{ident}            list of matching flights (we pick one)
 *   GET /airports/{icao}            origin + destination details (cached)
 *   GET /flights/{faId}/route       decoded fixes (lat/lon for named navaids)
 *   GET /flights/{faId}/track       actual flown positions
 *
 * The decoded /route is sometimes incomplete *and* sometimes contains
 * wrong-globally-resolved navaids (e.g. "TNT" → Miami instead of UK).
 * To get the *true* route, we also parse the raw textual route from the
 * flight summary itself (`flight.route` field). Explicit lat/lon fixes
 * like `620000N/0200000W` are parsed and used verbatim; named fixes use
 * the /route coordinates but only if they pass a detour-budget filter.
 */

const BASE = 'https://aeroapi.flightaware.com/aeroapi';

const flightCache = new TTLCache<FlightSummary | null>(5 * 60_000);
const airportCache = new TTLCache<Airport | null>(60 * 60_000);
const routeCache = new TTLCache<FiledRoute | null>(10 * 60_000);
const trackCache = new TTLCache<TrackPoint[]>(60_000);

export class FlightAwareError extends Error {
  constructor(message: string, public status = 502, public code = 'flightaware_error') {
    super(message);
  }
}

export interface Airport {
  icao: string;
  iata?: string;
  name: string;
  city?: string;
  countryCode?: string;
  lat: number;
  lon: number;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  altFt?: number;
  ts?: string;
}

export interface Waypoint {
  ident: string;
  type?: string;
  lat: number;
  lon: number;
  source: 'airport' | 'text-coord' | 'decoded';
}

export interface FiledRoute {
  waypoints: Waypoint[];
  points: TrackPoint[];
  routeText?: string;
  filedAltitude?: number;
  rejected?: string[];
}

export interface FlightSummary {
  faFlightId: string;
  ident: string;
  airline?: string;
  aircraftType?: string;
  origin: Airport;
  destination: Airport;
  departureUtc?: string;
  arrivalUtc?: string;
  status?: string;
  routeText?: string;
}

function ensureKey(): string {
  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) {
    throw new FlightAwareError(
      'FLIGHTAWARE_API_KEY is not set in .env. Get one at flightaware.com/commercial/aeroapi/.',
      500,
      'misconfigured',
    );
  }
  return key;
}

async function fa(path: string): Promise<unknown> {
  const key = ensureKey();
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-apikey': key, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new FlightAwareError(
      `FlightAware ${res.status}: check that FLIGHTAWARE_API_KEY is valid and billing is enabled.`,
      res.status,
      'unauthorized',
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FlightAwareError(
      `FlightAware ${res.status}: ${text.slice(0, 200)}`,
      502,
    );
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Airports

interface FaAirport {
  code?: string;
  code_icao?: string;
  code_iata?: string;
  name?: string;
  city?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
}

export async function getAirport(icao: string): Promise<Airport | null> {
  const key = icao.toUpperCase();
  const cached = airportCache.get(key);
  if (cached !== undefined) return cached;
  const raw = (await fa(`/airports/${encodeURIComponent(key)}`)) as FaAirport | null;
  if (!raw || typeof raw.latitude !== 'number' || typeof raw.longitude !== 'number') {
    airportCache.set(key, null);
    return null;
  }
  const airport: Airport = {
    icao: raw.code_icao ?? key,
    iata: raw.code_iata,
    name: raw.name ?? key,
    city: raw.city,
    countryCode: raw.country_code,
    lat: raw.latitude,
    lon: raw.longitude,
  };
  airportCache.set(key, airport);
  return airport;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flight summary

interface FaFlight {
  fa_flight_id: string;
  ident?: string;
  ident_icao?: string;
  ident_iata?: string;
  operator?: string;
  operator_icao?: string;
  operator_iata?: string;
  origin?: { code_icao?: string; code_iata?: string };
  destination?: { code_icao?: string; code_iata?: string };
  scheduled_off?: string;
  scheduled_in?: string;
  actual_off?: string | null;
  actual_on?: string | null;
  aircraft_type?: string;
  route?: string;
  status?: string;
}

interface FaFlightsResponse {
  flights?: FaFlight[];
}

/** Pick a single flight from /flights/{ident}. Prefer in-air, then today's,
 * then most recent. */
function pickFlight(flights: FaFlight[]): FaFlight | undefined {
  if (flights.length === 0) return undefined;
  const inAir = flights.find((f) =>
    (f.status ?? '').toLowerCase().includes('en route'),
  );
  if (inAir) return inAir;
  const today = new Date().toISOString().slice(0, 10);
  const todays = flights.filter((f) => (f.scheduled_off ?? '').startsWith(today));
  if (todays.length) return todays[todays.length - 1];
  return flights[flights.length - 1];
}

export async function getFlightSummary(identRaw: string): Promise<FlightSummary> {
  const ident = identRaw.trim().toUpperCase();
  const cached = flightCache.get(ident);
  if (cached) return cached;
  if (cached === null) throw new FlightAwareError(`No flight ${ident} found.`, 404, 'not_found');

  const raw = (await fa(`/flights/${encodeURIComponent(ident)}`)) as FaFlightsResponse | null;
  const flights = raw?.flights ?? [];
  const pick = pickFlight(flights);
  if (!pick) {
    flightCache.set(ident, null);
    throw new FlightAwareError(`No flight ${ident} found.`, 404, 'not_found');
  }
  const originIcao = pick.origin?.code_icao;
  const destIcao = pick.destination?.code_icao;
  if (!originIcao || !destIcao) {
    throw new FlightAwareError(
      `Flight ${ident} has no origin/destination in its FlightAware record.`,
      502,
      'incomplete_data',
    );
  }
  const [originAirport, destAirport] = await Promise.all([
    getAirport(originIcao),
    getAirport(destIcao),
  ]);
  if (!originAirport || !destAirport) {
    throw new FlightAwareError(
      `Could not resolve airports ${originIcao}/${destIcao}.`,
      502,
      'airport_not_found',
    );
  }
  const summary: FlightSummary = {
    faFlightId: pick.fa_flight_id,
    ident: pick.ident ?? ident,
    airline: pick.operator,
    aircraftType: pick.aircraft_type,
    origin: originAirport,
    destination: destAirport,
    departureUtc: pick.actual_off ?? pick.scheduled_off,
    arrivalUtc: pick.actual_on ?? pick.scheduled_in,
    status: pick.status,
    routeText: pick.route?.trim() || undefined,
  };
  flightCache.set(ident, summary);
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filed route — combines text route + decoded /route fixes

interface FaRouteFix {
  name?: string;
  type?: string;
  latitude?: number;
  longitude?: number;
  distance_from_origin?: number;
}
interface FaRouteResponse {
  route_distance?: string;
  filed_altitude?: number;
  fixes?: FaRouteFix[];
}

const NM_PER_RAD = 3440.065;
function haversineNm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * NM_PER_RAD * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Parse an ICAO/oceanic lat/lon waypoint token. Supports:
 *   55N100W       2-digit degrees lat, 3-digit degrees lon
 *   5530N01000W   ddmm lat, dddmm lon (degrees-minutes)
 *   620000N0200000W  ddmmss lat, dddmmss lon (degrees-min-sec)
 * Slashes are optional: 5530N/01000W also works.
 * Returns null if the token doesn't look like a coordinate fix.
 */
export function parseCoordFix(token: string): { lat: number; lon: number } | null {
  const m = /^(\d{2,6})([NS])\/?(\d{3,7})([EW])$/.exec(token);
  if (!m) return null;
  const [, latDigits, latSign, lonDigits, lonSign] = m;
  const lat = parseDMS(latDigits, 2);
  const lon = parseDMS(lonDigits, 3);
  if (lat === null || lon === null) return null;
  return {
    lat: latSign === 'S' ? -lat : lat,
    lon: lonSign === 'W' ? -lon : lon,
  };
}

function parseDMS(digits: string, degDigits: 2 | 3): number | null {
  if (digits.length === degDigits) {
    return Number(digits);
  }
  if (digits.length === degDigits + 2) {
    const deg = Number(digits.slice(0, degDigits));
    const min = Number(digits.slice(degDigits));
    return deg + min / 60;
  }
  if (digits.length === degDigits + 4) {
    const deg = Number(digits.slice(0, degDigits));
    const min = Number(digits.slice(degDigits, degDigits + 2));
    const sec = Number(digits.slice(degDigits + 2));
    return deg + min / 60 + sec / 3600;
  }
  return null;
}

// Tokens that should never be treated as waypoints.
const AIRWAY_RE = /^[A-Z]{1,2}\d{1,4}[A-Z]?$/; // e.g. T418, UN57, UN601, J100
const SID_STAR_RE = /^[A-Z]{3,5}\d[A-Z]?$/; // e.g. CHOWW4, MARLO1A, DCT-style departures
const SPEED_ALT_RE = /\d{2,3}\/[FN]\d{3}$/; // climb constraint markers

function isAirwayOrProcedure(token: string): boolean {
  return AIRWAY_RE.test(token) || SPEED_ALT_RE.test(token);
}

/** Build a final ordered waypoint list by walking the text route. */
function mergeRoute(
  summary: FlightSummary,
  decodedFixes: FaRouteFix[],
): { waypoints: Waypoint[]; rejected: string[] } {
  const text = summary.routeText ?? '';
  const tokens = text
    .split(/\s+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  // Decoded fixes by name. We do NOT pre-filter these — every fix gets
  // re-validated against its position in the route below using anchors
  // from the text route.
  const decodedByName = new Map<string, FaRouteFix>();
  for (const f of decodedFixes) {
    if (typeof f.latitude !== 'number' || typeof f.longitude !== 'number') continue;
    if (f.latitude === 0 && f.longitude === 0) continue;
    if (!f.name) continue;
    decodedByName.set(f.name.toUpperCase(), f);
  }

  // Pre-resolve every token in the text route into one of:
  //   { kind: 'skip' }       airway, procedure, origin/dest dup
  //   { kind: 'coord', ... } a text-coord (trusted anchor)
  //   { kind: 'named', ... } a named fix we have decoded coords for
  //   { kind: 'unknown' }    a named fix not in the decoded list
  type Slot =
    | { kind: 'skip' }
    | { kind: 'coord'; ident: string; lat: number; lon: number }
    | { kind: 'named'; ident: string; lat: number; lon: number; type?: string }
    | { kind: 'unknown'; ident: string };
  const slots: Slot[] = tokens.map((token) => {
    if (isAirwayOrProcedure(token)) return { kind: 'skip' };
    if (token === summary.origin.icao || token === summary.destination.icao)
      return { kind: 'skip' };
    if (token === summary.origin.iata || token === summary.destination.iata)
      return { kind: 'skip' };
    const coord = parseCoordFix(token);
    if (coord) return { kind: 'coord', ident: token, lat: coord.lat, lon: coord.lon };
    const decoded = decodedByName.get(token);
    if (decoded && typeof decoded.latitude === 'number' && typeof decoded.longitude === 'number') {
      return {
        kind: 'named',
        ident: token,
        lat: decoded.latitude,
        lon: decoded.longitude,
        type: decoded.type,
      };
    }
    return { kind: 'unknown', ident: token };
  });

  // For each slot, find the index of the next anchor (text-coord). If none
  // exists, use length (meaning "use destination").
  const nextAnchorIdx = new Array<number>(slots.length).fill(slots.length);
  let nextAnchor = slots.length;
  for (let i = slots.length - 1; i >= 0; i--) {
    nextAnchorIdx[i] = nextAnchor;
    if (slots[i].kind === 'coord') nextAnchor = i;
  }
  const anchorAt = (idx: number): { lat: number; lon: number; ident?: string } => {
    if (idx >= slots.length) return { ...summary.destination, ident: summary.destination.icao };
    const s = slots[idx];
    if (s.kind === 'coord') return s;
    return { ...summary.destination, ident: summary.destination.icao };
  };

  const waypoints: Waypoint[] = [];
  const seen = new Set<string>();
  const rejected: string[] = [];
  let skippedNamed = 0;

  const pushWaypoint = (w: Waypoint) => {
    const sig = `${w.lat.toFixed(4)},${w.lon.toFixed(4)}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    waypoints.push(w);
  };

  pushWaypoint({
    ident: summary.origin.icao,
    type: 'origin',
    lat: summary.origin.lat,
    lon: summary.origin.lon,
    source: 'airport',
  });

  // Walk the slots. Text-coord anchors are always accepted; named fixes
  // are validated against the path from the previous accepted waypoint to
  // the next anchor (or destination).
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.kind === 'skip') continue;
    if (slot.kind === 'unknown') {
      if (!SID_STAR_RE.test(slot.ident)) skippedNamed++;
      continue;
    }
    if (slot.kind === 'coord') {
      pushWaypoint({
        ident: slot.ident,
        type: 'oceanic',
        lat: slot.lat,
        lon: slot.lon,
        source: 'text-coord',
      });
      continue;
    }
    // Named fix — validate via look-ahead to next anchor.
    const prev = waypoints[waypoints.length - 1];
    const anchor = anchorAt(nextAnchorIdx[i]);
    const directNm = haversineNm(prev, anchor);
    const viaNm = haversineNm(prev, slot) + haversineNm(slot, anchor);
    // Allow 40% detour + 100nm absolute slack. Tight enough to catch
    // wrong-globally-resolved fixes (which detour by 2× or more), loose
    // enough to accept legitimate route deviations.
    const budgetNm = directNm * 1.4 + 100;
    if (viaNm > budgetNm) {
      rejected.push(
        `${slot.ident}@${slot.lat.toFixed(2)},${slot.lon.toFixed(2)} ` +
          `(detour via ${anchor.ident ?? 'dest'}: ${viaNm.toFixed(0)}nm vs direct ${directNm.toFixed(0)}nm)`,
      );
      continue;
    }
    pushWaypoint({
      ident: slot.ident,
      type: slot.type,
      lat: slot.lat,
      lon: slot.lon,
      source: 'decoded',
    });
  }

  pushWaypoint({
    ident: summary.destination.icao,
    type: 'destination',
    lat: summary.destination.lat,
    lon: summary.destination.lon,
    source: 'airport',
  });

  if (skippedNamed > 0) {
    console.warn(
      `[flightaware] route ${summary.ident}: skipped ${skippedNamed} named fix(es) not in /route decode`,
    );
  }
  if (rejected.length) {
    console.warn(
      `[flightaware] route ${summary.ident}: rejected ${rejected.length} suspicious fix(es):\n  ${rejected.join('\n  ')}`,
    );
  }
  return { waypoints, rejected };
}

export async function getFiledRoute(identRaw: string): Promise<FiledRoute> {
  const ident = identRaw.trim().toUpperCase();
  const cached = routeCache.get(ident);
  if (cached) return cached;

  const summary = await getFlightSummary(ident);

  const raw = (await fa(`/flights/${encodeURIComponent(summary.faFlightId)}/route`)) as
    | FaRouteResponse
    | null;
  const decodedFixes = raw?.fixes ?? [];

  let waypoints: Waypoint[];
  let rejected: string[] = [];
  if (summary.routeText) {
    const merged = mergeRoute(summary, decodedFixes);
    waypoints = merged.waypoints;
    rejected = merged.rejected;
  } else {
    // No textual route - fall back to /route fixes only.
    waypoints = [
      {
        ident: summary.origin.icao,
        type: 'origin',
        lat: summary.origin.lat,
        lon: summary.origin.lon,
        source: 'airport',
      },
      ...decodedFixes
        .filter(
          (f): f is Required<Pick<FaRouteFix, 'latitude' | 'longitude'>> & FaRouteFix =>
            typeof f.latitude === 'number' &&
            typeof f.longitude === 'number' &&
            !(f.latitude === 0 && f.longitude === 0),
        )
        .map((f) => ({
          ident: f.name ?? '',
          type: f.type,
          lat: f.latitude,
          lon: f.longitude,
          source: 'decoded' as const,
        })),
      {
        ident: summary.destination.icao,
        type: 'destination',
        lat: summary.destination.lat,
        lon: summary.destination.lon,
        source: 'airport',
      },
    ];
  }

  const result: FiledRoute = {
    waypoints,
    points: waypoints.map((w) => ({ lat: w.lat, lon: w.lon, ts: w.ident })),
    routeText: summary.routeText,
    filedAltitude: raw?.filed_altitude,
    rejected: rejected.length ? rejected : undefined,
  };
  routeCache.set(ident, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track

interface FaTrackPosition {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  groundspeed?: number;
  heading?: number;
  timestamp?: string;
}
interface FaTrackResponse {
  positions?: FaTrackPosition[];
}

export async function getTrack(identRaw: string): Promise<TrackPoint[]> {
  const ident = identRaw.trim().toUpperCase();
  const cached = trackCache.get(ident);
  if (cached) return cached;

  const summary = await getFlightSummary(ident);
  const raw = (await fa(`/flights/${encodeURIComponent(summary.faFlightId)}/track`)) as
    | FaTrackResponse
    | null;
  const points: TrackPoint[] = (raw?.positions ?? [])
    .filter(
      (p): p is Required<Pick<FaTrackPosition, 'latitude' | 'longitude'>> & FaTrackPosition =>
        typeof p.latitude === 'number' && typeof p.longitude === 'number',
    )
    .map((p) => ({
      lat: p.latitude,
      lon: p.longitude,
      altFt: typeof p.altitude === 'number' ? p.altitude * 100 : undefined,
      ts: p.timestamp,
    }));
  trackCache.set(ident, points);
  return points;
}
