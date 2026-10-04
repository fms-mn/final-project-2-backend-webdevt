/**
 * Backend smoke test for "STEP 1 — Verify the Project Foundation (Backend)".
 *
 * Run from the repository root after setting up server/.env and starting MongoDB:
 *   npm run smoke
 *
 * What it does:
 *   - runs the seed script twice (second run must add nothing)
 *   - starts the API on a spare port (default 5099) so it never clashes with `npm run dev`
 *   - exercises every route and prints PASS/FAIL grouped by Trello card
 *   - removes the movies, users and bookings it created
 *
 * It only creates data prefixed with "smoke-" / "[SMOKE]" and never drops collections.
 */
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(SERVER_DIR, '.env') });

const PORT = process.env.SMOKE_PORT || '5099';
const BASE = `http://127.0.0.1:${PORT}/api`;
const RUN_ID = Date.now();
const PASSWORD = 'smoke-pass-123';
const USER_A = { name: 'Smoke A', email: `smoke-a-${RUN_ID}@test.local`, password: PASSWORD };
const USER_B = { name: 'Smoke B', email: `smoke-b-${RUN_ID}@test.local`, password: PASSWORD };
const ADMIN = { email: 'admin@cinemax.com', password: 'admin123' };

const results = [];
let currentCard = '';
const card = (name) => { currentCard = name; };

async function check(name, fn) {
  try {
    await fn();
    results.push({ card: currentCard, name, ok: true });
  } catch (error) {
    const lines = String(error.message).split('\n');
    const detail = lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n...' : '');
    results.push({ card: currentCard, name, ok: false, detail });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(method, route, { token, body } = {}) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { /* empty body */ }
  return { status: response.status, data };
}

function expectStatus(res, status, label = '') {
  assert(res.status === status, `${label} expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.data)}`.trim());
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: SERVER_DIR, timeout: 60000, ...options });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

const testMovie = (suffix) => ({
  title: `[SMOKE] ${suffix} ${RUN_ID}`,
  description: 'Temporary movie created by the smoke test.',
  genre: ['Test'],
  duration: 100,
  rating: 'PG',
  posterUrl: 'https://example.com/poster.jpg',
  releaseDate: '2030-01-01',
  status: 'now_showing',
  price: 500,
});

async function main() {
  // ---- Card: .env variables load correctly -------------------------------------------------
  card('`.env` variables load correctly');
  await check('server/.env defines MONGODB_URI and JWT_SECRET', async () => {
    assert(process.env.MONGODB_URI, 'MONGODB_URI missing — copy server/.env.example to server/.env');
    assert(process.env.JWT_SECRET, 'JWT_SECRET missing — copy server/.env.example to server/.env');
  });
  await check('server refuses to start when required variables are missing', async () => {
    const run = runNode([path.join(SERVER_DIR, 'index.js')], { cwd: os.tmpdir(), env: { PATH: process.env.PATH }, input: '' });
    assert(run.status === 1, `expected exit code 1, got ${run.status}`);
    assert(/Missing required environment variable/.test(run.stderr), 'no helpful error message printed');
  });
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) return;

  // ---- Card: Database seed script works ----------------------------------------------------
  card('Database seed script works');
  await check('seed script exits cleanly and reports success', async () => {
    const run = runNode([path.join(SERVER_DIR, 'seed.js')]);
    assert(run.status === 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
    assert(/seeded successfully/i.test(run.stdout), 'success message not printed');
  });
  await check('running the seed again adds nothing (no duplicates, no wipe)', async () => {
    const run = runNode([path.join(SERVER_DIR, 'seed.js')]);
    assert(run.status === 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
    assert(/Added 0 missing sample movies/.test(run.stdout), `second run output: ${run.stdout}`);
    assert(/Added 0 missing sample users/.test(run.stdout), `second run output: ${run.stdout}`);
  });

  // ---- Card: Express server starts / MongoDB connects --------------------------------------
  const serverLog = [];
  const server = spawn(process.execPath, [path.join(SERVER_DIR, 'index.js')], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT },
  });
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
  const stopServer = () => new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    server.kill();
  });

  try {
    card('Express server starts successfully');
    let health = null;
    await check(`API starts and GET /api/health answers on port ${PORT}`, async () => {
      health = await waitForHealth(20000);
      assert(health, `server did not come up. Log:\n${serverLog.join('')}`);
      assert(health.status === 'ok', `unexpected health payload ${JSON.stringify(health)}`);
    });
    if (!health) return;

    card('MongoDB connects correctly');
    await check('server logged "Connected to MongoDB"', async () => {
      assert(/Connected to MongoDB/.test(serverLog.join('')), `log was:\n${serverLog.join('')}`);
    });
    await check('GET /api/movies returns an array from the database', async () => {
      const res = await api('GET', '/movies');
      expectStatus(res, 200);
      assert(Array.isArray(res.data), 'response is not an array');
      assert(res.data.length > 0, 'no movies found — did the seed run against this MONGODB_URI?');
    });

    // ---- Card: Authentication routes work / User model works -------------------------------
    card('User model works');
    let tokenA = null;
    let tokenB = null;
    await check('register creates a user (role user, no password in response)', async () => {
      const res = await api('POST', '/auth/register', { body: USER_A });
      expectStatus(res, 201);
      assert(res.data.token, 'no token returned');
      assert(res.data.user.role === 'user', `role was ${res.data.user.role}`);
      assert(!JSON.stringify(res.data).includes(PASSWORD), 'plain password leaked in response');
      assert(!('password' in res.data.user), 'password field present in response');
      tokenA = res.data.token;
    });
    await check('email is normalised to lowercase', async () => {
      const res = await api('POST', '/auth/register', {
        body: { ...USER_B, email: USER_B.email.toUpperCase() },
      });
      expectStatus(res, 201);
      assert(res.data.user.email === USER_B.email, `stored as ${res.data.user.email}`);
      tokenB = res.data.token;
    });
    await check('duplicate email is rejected', async () => {
      const res = await api('POST', '/auth/register', { body: USER_A });
      assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    });
    await check('public registration cannot create an admin', async () => {
      const res = await api('POST', '/auth/register', {
        body: { name: 'Sneaky', email: `smoke-c-${RUN_ID}@test.local`, password: PASSWORD, role: 'admin' },
      });
      expectStatus(res, 201);
      assert(res.data.user.role === 'user', `role was ${res.data.user.role}`);
    });

    card('Authentication routes work');
    let adminToken = null;
    await check('login with correct credentials returns token + user', async () => {
      const res = await api('POST', '/auth/login', { body: { email: USER_A.email, password: PASSWORD } });
      expectStatus(res, 200);
      assert(res.data.token && res.data.user.email === USER_A.email, 'bad login payload');
    });
    await check('login with wrong password is rejected', async () => {
      const res = await api('POST', '/auth/login', { body: { email: USER_A.email, password: 'wrong-password' } });
      assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    });
    await check('login with unknown email is rejected', async () => {
      const res = await api('POST', '/auth/login', { body: { email: 'nobody@test.local', password: PASSWORD } });
      assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    });
    await check('GET /auth/me returns the logged-in user', async () => {
      const res = await api('GET', '/auth/me', { token: tokenA });
      expectStatus(res, 200);
      assert(res.data.user.email === USER_A.email, 'wrong user returned');
      assert(!('password' in res.data.user), 'password field present');
    });
    await check('seeded admin can log in', async () => {
      const res = await api('POST', '/auth/login', { body: ADMIN });
      expectStatus(res, 200);
      assert(res.data.user.role === 'admin', `role was ${res.data.user.role}`);
      adminToken = res.data.token;
    });

    // ---- Card: JWT middleware protects private routes --------------------------------------
    card('JWT middleware protects private routes');
    await check('no token -> 401 on /auth/me, /bookings, /bookings/my', async () => {
      expectStatus(await api('GET', '/auth/me'), 401, '/auth/me');
      expectStatus(await api('POST', '/bookings', { body: {} }), 401, 'POST /bookings');
      expectStatus(await api('GET', '/bookings/my'), 401, '/bookings/my');
    });
    await check('invalid token -> 401', async () => {
      expectStatus(await api('GET', '/auth/me', { token: 'not.a.token' }), 401);
    });
    await check('normal user -> 403 on admin movie routes', async () => {
      expectStatus(await api('POST', '/movies', { token: tokenA, body: testMovie('forbidden') }), 403, 'POST');
      expectStatus(await api('PUT', '/movies/000000000000000000000000', { token: tokenA, body: {} }), 403, 'PUT');
      expectStatus(await api('DELETE', '/movies/000000000000000000000000', { token: tokenA }), 403, 'DELETE');
    });
    await check('no token -> 401 on admin movie routes', async () => {
      expectStatus(await api('POST', '/movies', { body: testMovie('anon') }), 401);
    });

    // ---- Card: Movie model works / Movie routes work ---------------------------------------
    card('Movie model works');
    await check('creating a movie without required fields is rejected', async () => {
      const res = await api('POST', '/movies', { token: adminToken, body: { title: 'Incomplete' } });
      assert(res.status >= 400, `invalid movie was accepted (HTTP ${res.status})`);
    });
    await check('defaults are applied (director "", cast [])', async () => {
      const res = await api('POST', '/movies', { token: adminToken, body: testMovie('defaults') });
      expectStatus(res, 201);
      assert(res.data.director === '' && Array.isArray(res.data.cast), 'defaults missing');
      await api('DELETE', `/movies/${res.data._id}`, { token: adminToken });
    });

    card('Movie routes work');
    let movie = null;
    await check('admin can create a movie', async () => {
      const res = await api('POST', '/movies', { token: adminToken, body: testMovie('crud') });
      expectStatus(res, 201);
      movie = res.data;
      assert(movie._id && movie.price === 500, 'unexpected movie payload');
    });
    if (!movie) return;
    await check('GET /movies lists it; ?status= and ?search= filter', async () => {
      const all = await api('GET', '/movies');
      assert(all.data.some((m) => m._id === movie._id), 'new movie missing from list');
      // plain-text term: the API treats ?search= as a regular expression, so avoid [ ] ( ) etc.
      const searched = await api('GET', `/movies?search=${encodeURIComponent(`crud ${RUN_ID}`)}`);
      expectStatus(searched, 200, 'search');
      assert(searched.data.some((m) => m._id === movie._id), 'search did not find the new movie');
      assert(searched.data.every((m) => /crud/i.test(m.title)), 'search returned unrelated movies');
      const coming = await api('GET', '/movies?status=coming_soon');
      assert(coming.data.every((m) => m.status === 'coming_soon'), 'status filter wrong');
    });
    await check('GET /movies/:id returns the movie; unknown id -> 404', async () => {
      const found = await api('GET', `/movies/${movie._id}`);
      expectStatus(found, 200);
      assert(found.data.title === movie.title, 'wrong movie returned');
      expectStatus(await api('GET', '/movies/000000000000000000000000'), 404);
    });
    await check('admin can update a movie (PUT)', async () => {
      const res = await api('PUT', `/movies/${movie._id}`, { token: adminToken, body: { price: 650 } });
      expectStatus(res, 200);
      assert(res.data.price === 650, 'price not updated');
    });

    // ---- Card: Booking model works / Booking routes work -----------------------------------
    card('Booking model works');
    const show = { movieId: movie._id, showDate: '2030-01-01', showTime: '10:00' };
    let booking = null;
    await check('booking stores seats, show date/time and server-calculated total', async () => {
      const res = await api('POST', '/bookings', {
        token: tokenA,
        body: { ...show, seats: ['S1', 'S2'], totalPrice: 1 }, // client-sent total must be ignored
      });
      expectStatus(res, 201);
      booking = res.data;
      assert(booking.status === 'confirmed', `status was ${booking.status}`);
      assert(booking.totalPrice === 2 * 650, `totalPrice was ${booking.totalPrice}, expected ${2 * 650}`);
      assert(booking.seats.join() === 'S1,S2', 'seats not stored');
    });

    card('Booking routes work');
    await check('same seat for same show cannot be booked twice', async () => {
      const res = await api('POST', '/bookings', { token: tokenB, body: { ...show, seats: ['S2', 'S3'] } });
      assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
      assert(/S2/.test(JSON.stringify(res.data)), 'conflicting seat not named in message');
    });
    await check('unknown movie -> 404', async () => {
      const res = await api('POST', '/bookings', {
        token: tokenA,
        body: { ...show, movieId: '000000000000000000000000', seats: ['Z1'] },
      });
      expectStatus(res, 404);
    });
    await check('GET /bookings/seats/:movieId shows the taken seats', async () => {
      const res = await api('GET', `/bookings/seats/${movie._id}?showDate=${show.showDate}&showTime=${show.showTime}`);
      expectStatus(res, 200);
      assert(['S1', 'S2'].every((s) => res.data.bookedSeats.includes(s)), JSON.stringify(res.data));
    });
    await check('GET /bookings/my lists only the caller\'s bookings', async () => {
      const mine = await api('GET', '/bookings/my', { token: tokenA });
      expectStatus(mine, 200);
      assert(mine.data.some((b) => b._id === booking._id), 'booking missing from /my');
      const theirs = await api('GET', '/bookings/my', { token: tokenB });
      assert(!theirs.data.some((b) => b._id === booking._id), 'other user can see the booking');
    });
    await check('another user cannot cancel it', async () => {
      const res = await api('PATCH', `/bookings/${booking._id}/cancel`, { token: tokenB });
      assert(res.status === 404 || res.status === 403, `expected 404/403, got ${res.status}`);
    });
    await check('owner can cancel; seats are released; cancelling twice is rejected', async () => {
      const cancelled = await api('PATCH', `/bookings/${booking._id}/cancel`, { token: tokenA });
      expectStatus(cancelled, 200);
      assert(cancelled.data.booking.status === 'cancelled', 'status not cancelled');
      const seats = await api('GET', `/bookings/seats/${movie._id}?showDate=${show.showDate}&showTime=${show.showTime}`);
      assert(seats.data.bookedSeats.length === 0, `seats still held: ${seats.data.bookedSeats}`);
      const again = await api('PATCH', `/bookings/${booking._id}/cancel`, { token: tokenA });
      assert(again.status >= 400 && again.status < 500, `expected a 4xx, got ${again.status}`);
      const rebook = await api('POST', '/bookings', { token: tokenB, body: { ...show, seats: ['S1', 'S2'] } });
      expectStatus(rebook, 201, 'rebooking released seats');
    });

    // ---- finish Movie routes: delete ---------------------------------------------------------
    card('Movie routes work');
    await check('admin can delete a movie; it is gone afterwards', async () => {
      expectStatus(await api('DELETE', `/movies/${movie._id}`, { token: adminToken }), 200);
      expectStatus(await api('GET', `/movies/${movie._id}`), 404);
    });
  } finally {
    await stopServer();
    await cleanup();
  }
}

// Remove everything this run created, directly in MongoDB.
async function cleanup() {
  const mongoose = require('mongoose');
  const User = require('../models/User');
  const Booking = require('../models/Booking');
  const Movie = require('../models/Movie');
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const users = await User.find({ email: new RegExp(`^smoke-[abc]-${RUN_ID}@test\\.local$`) }, '_id');
    const ids = users.map((u) => u._id);
    await Booking.deleteMany({ user: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await Movie.deleteMany({ title: new RegExp(`^\\[SMOKE\\] .* ${RUN_ID}$`) });
  } catch (error) {
    console.warn(`\n(cleanup skipped: ${error.message})`);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main()
  .catch((error) => {
    results.push({ card: 'Smoke test runner', name: 'unexpected error', ok: false, detail: error.stack });
  })
  .finally(() => {
    const byCard = new Map();
    for (const r of results) byCard.set(r.card, [...(byCard.get(r.card) || []), r]);
    for (const [cardName, rows] of byCard) {
      console.log(`\n${cardName}`);
      for (const r of rows) {
        console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${String(r.detail).replace(/\n/g, '\n        ')}`}`);
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
    process.exit(failed ? 1 : 0);
  });
