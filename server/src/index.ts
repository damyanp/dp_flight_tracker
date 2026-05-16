import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import {
  FlightAwareError,
  getFiledRoute,
  getFlightSummary,
  getTrack,
} from './flightaware.js';

// Load .env from the server dir first, then fall back to the repo root.
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  resolve(here, '../.env'),
  resolve(here, '../../.env'),
  resolve(here, '../../../.env'),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
    console.log(`[server] loaded env from ${candidate}`);
    break;
  }
}

const app = express();
const PORT = Number(process.env.PORT ?? 5174);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/flight/:number', async (req, res, next) => {
  try {
    const [summary, route] = await Promise.all([
      getFlightSummary(req.params.number),
      getFiledRoute(req.params.number).catch((e) => {
        console.warn('[flightaware] filed route failed:', (e as Error).message);
        return null;
      }),
    ]);
    res.json({
      number: summary.ident,
      airline: summary.airline,
      aircraftType: summary.aircraftType,
      origin: summary.origin,
      destination: summary.destination,
      departureUtc: summary.departureUtc,
      arrivalUtc: summary.arrivalUtc,
      status: summary.status,
      route,
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/flight/:number/track', async (req, res, next) => {
  try {
    const points = await getTrack(req.params.number);
    res.json({ points });
  } catch (e) {
    next(e);
  }
});

// In production we also serve the built client from this same process.
// The compiled server lives at <repo>/server/dist/index.js, so the client
// build output is two directories up at <repo>/client/dist.
const clientDist = resolve(here, '../../client/dist');
if (existsSync(clientDist)) {
  console.log(`[server] serving static client from ${clientDist}`);
  app.use(express.static(clientDist, { index: 'index.html' }));
  app.get(/^\/(?!api\/|health\b).*/, (_req, res) => {
    res.sendFile(resolve(clientDist, 'index.html'));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof FlightAwareError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error', code: 'internal' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

