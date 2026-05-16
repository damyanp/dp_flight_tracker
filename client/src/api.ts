export interface Airport {
  iata?: string;
  icao: string;
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

export interface FlightInfo {
  number: string;
  airline?: string;
  aircraftType?: string;
  origin: Airport;
  destination: Airport;
  departureUtc?: string;
  arrivalUtc?: string;
  status?: string;
  route: FiledRoute | null;
}

export interface TrackResponse {
  points: TrackPoint[];
}

export interface ApiError {
  error: string;
  code: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as Partial<ApiError> & Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

export function fetchFlight(number: string): Promise<FlightInfo> {
  return getJson<FlightInfo>(`/api/flight/${encodeURIComponent(number)}`);
}

export function fetchTrack(number: string): Promise<TrackResponse> {
  return getJson<TrackResponse>(`/api/flight/${encodeURIComponent(number)}/track`);
}
