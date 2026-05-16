import { fetchFlight, fetchTrack, type FlightInfo } from './api.js';
import { createGlobe, focusOn } from './globe.js';
import {
  clearRoutes,
  drawAircraft,
  drawGreatCircle,
  drawMarker,
  drawTrack,
  setLayerVisible,
} from './routes.js';

const canvas = document.getElementById('globe') as HTMLCanvasElement;
const form = document.getElementById('flight-form') as HTMLFormElement;
const input = document.getElementById('flight-input') as HTMLInputElement;
const status = document.getElementById('status') as HTMLDivElement;
const info = document.getElementById('info') as HTMLDivElement;
const layers = document.getElementById('layers') as HTMLFieldSetElement;
const submitBtn = form.querySelector('button') as HTMLButtonElement;
const routePanel = document.getElementById('route-text-panel') as HTMLDetailsElement;
const routeTextEl = document.getElementById('route-text') as HTMLPreElement;

const LAYER_COLORS = {
  'great-circle': 0x6aa9ff,
  filed: 0xffffff,
  track: 0xff4d4d,
  waypoints: 0xffffff,
  aircraft: 0xffe066,
} as const;

// Capture the default checked state of each layer from the HTML markup so
// `setLayerCount` can restore it whenever a layer goes from "no data" to
// "has data".
const LAYER_DEFAULTS: Record<string, boolean> = {};
for (const cb of layers.querySelectorAll<HTMLInputElement>('input[data-layer]')) {
  LAYER_DEFAULTS[cb.dataset.layer!] = cb.checked;
}

const globe = createGlobe(canvas);

function setStatus(message: string, kind: 'info' | 'ok' | 'error' = 'info') {
  status.textContent = message;
  status.className = kind === 'info' ? '' : kind;
}

function renderInfo(flight: FlightInfo) {
  const rows: Array<[string, string]> = [
    ['Flight', `${flight.number}${flight.airline ? ' · ' + flight.airline : ''}`],
    [
      'From',
      `${flight.origin.iata ?? flight.origin.icao} ${flight.origin.name}${
        flight.origin.city ? ' (' + flight.origin.city + ')' : ''
      }`.trim(),
    ],
    [
      'To',
      `${flight.destination.iata ?? flight.destination.icao} ${flight.destination.name}${
        flight.destination.city ? ' (' + flight.destination.city + ')' : ''
      }`.trim(),
    ],
  ];
  if (flight.aircraftType) rows.push(['Aircraft', flight.aircraftType]);
  if (flight.status) rows.push(['Status', flight.status]);
  if (flight.departureUtc) rows.push(['Departs', flight.departureUtc]);
  if (flight.arrivalUtc) rows.push(['Arrives', flight.arrivalUtc]);
  info.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="row"><span class="label">${k}</span><span>${escapeHtml(v)}</span></div>`,
    )
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function setLayerCount(layer: keyof typeof LAYER_COLORS, n: number) {
  const el = layers.querySelector<HTMLElement>(`[data-count="${layer}"]`);
  if (el) {
    if (layer === 'filed') el.textContent = n > 0 ? `${n} waypoints` : 'none';
    else if (layer === 'waypoints') el.textContent = n > 0 ? `${n}` : 'none';
    else el.textContent = n > 0 ? `${n} pts` : 'none';
  }
  const checkbox = layers.querySelector<HTMLInputElement>(`input[data-layer="${layer}"]`);
  if (checkbox) {
    const wasDisabled = checkbox.disabled;
    checkbox.disabled = n === 0;
    if (n === 0) {
      checkbox.checked = false;
    } else if (wasDisabled) {
      // Restore the layer's default checked state (set in HTML) now that
      // we actually have data for it.
      checkbox.checked = LAYER_DEFAULTS[layer] ?? false;
    }
  }
}

function syncVisibility() {
  for (const cb of layers.querySelectorAll<HTMLInputElement>('input[data-layer]')) {
    setLayerVisible(globe, cb.dataset.layer!, cb.checked);
  }
}

layers.addEventListener('change', syncVisibility);

async function loadFlight(numberRaw: string) {
  const number = numberRaw.trim().toUpperCase();
  if (!number) return;
  submitBtn.disabled = true;
  setStatus(`Looking up ${number}…`);
  info.innerHTML = '';
  routePanel.hidden = true;
  routeTextEl.textContent = '';
  clearRoutes(globe);
  layers.hidden = false;
  setLayerCount('filed', 0);
  setLayerCount('track', 0);
  setLayerCount('waypoints', 0);

  let flight: FlightInfo;
  try {
    flight = await fetchFlight(number);
  } catch (err) {
    const e = err as Error;
    setStatus(e.message || 'Failed to load flight.', 'error');
    submitBtn.disabled = false;
    return;
  }

  const mid = drawGreatCircle(globe, flight.origin, flight.destination, LAYER_COLORS['great-circle']);
  drawMarker(globe, flight.origin, 0x8fe28f);
  drawMarker(globe, flight.destination, 0xffcc66);
  focusOn(globe, mid);
  renderInfo(flight);

  if (flight.route && flight.route.points.length >= 2) {
    drawTrack(globe, flight.route.points, LAYER_COLORS.filed, 'filed', 0.002);
    setLayerCount('filed', flight.route.waypoints.length);
    // Drop a small marker at every filed waypoint so it's obvious where
    // each one landed; helps spot misplaced fixes at a glance. Lives in
    // its own layer so the user can toggle them independently.
    let waypointCount = 0;
    for (const w of flight.route.waypoints) {
      if (w.source === 'airport') continue;
      drawMarker(globe, w, LAYER_COLORS.waypoints, 'waypoints', 0.006, 0.013);
      waypointCount++;
    }
    setLayerCount('waypoints', waypointCount);
  }
  if (flight.route?.routeText) {
    routePanel.hidden = false;
    const sections: string[] = [];
    sections.push(`Raw route:\n${flight.route.routeText}`);
    if (flight.route.waypoints.length) {
      const lines = flight.route.waypoints.map(
        (w, i) =>
          `${String(i).padStart(2, ' ')}. ${w.ident.padEnd(10, ' ')} ${w.lat.toFixed(3).padStart(8, ' ')}, ${w.lon.toFixed(3).padStart(9, ' ')}  [${w.source}]`,
      );
      sections.push(`Plotted (${flight.route.waypoints.length}):\n${lines.join('\n')}`);
    }
    if (flight.route.rejected?.length) {
      sections.push(`Rejected:\n  ${flight.route.rejected.join('\n  ')}`);
    }
    routeTextEl.textContent = sections.join('\n\n');
  }

  setStatus(`Route loaded for ${flight.number}. Fetching actual track…`, 'ok');
  syncVisibility();

  try {
    const track = await fetchTrack(number);
    if (track.points.length >= 2) {
      drawTrack(globe, track.points, LAYER_COLORS.track, 'track', 0.009);
      drawAircraft(globe, track.points, LAYER_COLORS.aircraft);
      setLayerCount('track', track.points.length);
    }
    const filedPart = flight.route
      ? `Filed: ${flight.route.waypoints.length} waypoints`
      : 'No filed route available';
    const trackPart =
      track.points.length >= 2 ? `Track: ${track.points.length} pts` : 'No track yet';
    setStatus(`${flight.number}. ${filedPart} · ${trackPart}`, 'ok');
    syncVisibility();
  } catch (e) {
    console.warn('Track fetch failed:', e);
    setStatus(`Route loaded for ${flight.number}, but track lookup failed.`, 'ok');
  } finally {
    submitBtn.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void loadFlight(input.value);
});

input.focus();
