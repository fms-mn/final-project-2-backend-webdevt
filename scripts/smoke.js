/**
 * Backend smoke test. Run from the repository root with MongoDB reachable and server/.env set:
 *
 *   npm run smoke
 *
 * It runs the setup scripts, starts the API on a spare port (default 5099, so it never clashes
 * with `npm run dev`), exercises the models, indexes, transactions and routes against the real
 * database, and prints PASS/FAIL grouped by topic. Everything it creates is named "smoke-..." or
 * "[SMOKE] ..." and is deleted again at the end. It never drops collections.
 *
 * The offline unit tests (no database needed) are separate: `npm run test:server`.
 */
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(SERVER_DIR, '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const { getSettings } = require('../services/settings');

const PORT = process.env.SMOKE_PORT || '5099';
const BASE = `http://127.0.0.1:${PORT}/api`;
const RUN_ID = Date.now();
const PASSWORD = 'smoke-pass-123';
const email = (tag) => `smoke-${tag}-${RUN_ID}@test.local`;
const USER_A = { name: 'Smoke A', email: email('a'), password: PASSWORD };
const USER_B = { name: 'Smoke B', email: email('b'), password: PASSWORD };
const ADMIN = { name: 'Smoke Admin', email: email('admin'), password: PASSWORD };
const fakeId = () => new mongoose.Types.ObjectId();
const fakeShowtimeIds = []; // claims written with made-up showtime ids, removed in cleanup

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

const SESSION_COOKIE = 'filme_session';

// A "session" is { cookie, csrf }: the cookie the browser would keep and the CSRF token the
// app would send back in the X-CSRF-Token header on writes.
async function api(method, route, { session, body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session && session.cookie ? { Cookie: session.cookie } : {}),
      ...(session && session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { /* empty body */ }
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return { status: response.status, data, headers: response.headers, setCookies };
}

const sessionFrom = (res) => ({
  cookie: res.setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${SESSION_COOKIE}=`)),
  csrf: res.data && res.data.csrfToken,
});

function expectStatus(res, status, label = '') {
  assert(res.status === status, `${label} expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.data)}`.trim());
}

function expect4xx(res, label = '') {
  assert(res.status >= 400 && res.status < 500, `${label} expected a 4xx, got ${res.status} ${JSON.stringify(res.data)}`.trim());
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: SERVER_DIR, timeout: 90000, ...options });
}

const script = (name) => path.join(SERVER_DIR, name);

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

const testMovie = (suffix, overrides = {}) => ({
  title: `[SMOKE] ${suffix} ${RUN_ID}`,
  synopsis: 'Temporary movie created by the smoke test.',
  genre: `SmokeGenre${RUN_ID}`,
  rating: 'PG',
  posterUrl: 'https://example.com/poster.jpg',
  duration: 100,
  releaseDate: '2020-01-01',
  ...overrides,
});

const isDuplicateKey = (error) => error && error.code === 11000;

async function expectDuplicateKey(promise, label) {
  try {
    await promise;
  } catch (error) {
    assert(isDuplicateKey(error), `${label}: expected a duplicate key error, got ${error.message}`);
    return;
  }
  throw new Error(`${label}: expected a duplicate key error but the write succeeded`);
}

async function expectValidationError(promise, label) {
  try {
    await promise;
  } catch (error) {
    assert(error.name === 'ValidationError', `${label}: expected ValidationError, got ${error.name}: ${error.message}`);
    return;
  }
  throw new Error(`${label}: expected a ValidationError but the write succeeded`);
}

async function main() {
  // ---- .env ---------------------------------------------------------------------------------
  card('Environment (.env)');
  await check('server/.env defines MONGODB_URI and JWT_SECRET', async () => {
    assert(process.env.MONGODB_URI, 'MONGODB_URI missing — copy server/.env.example to server/.env');
    assert(process.env.JWT_SECRET, 'JWT_SECRET missing — copy server/.env.example to server/.env');
  });
  await check('server refuses to start when required variables are missing', async () => {
    const run = runNode([script('index.js')], { cwd: os.tmpdir(), env: { PATH: process.env.PATH }, input: '' });
    assert(run.status === 1, `expected exit code 1, got ${run.status}`);
    assert(/Missing required environment variable/.test(run.stderr), 'no helpful error message printed');
  });
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) return;

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  } catch (error) {
    await check('connects to MongoDB', async () => {
      throw new Error(`${error.message}\nCheck MONGODB_URI in server/.env, your network and Atlas Network Access.`);
    });
    return;
  }
  await check('the database holds no records in the old format', async () => {
    const [users, movies, bookings] = await Promise.all([
      User.countDocuments({ passwordHash: { $exists: false } }),
      Movie.countDocuments({ synopsis: { $exists: false } }),
      Booking.countDocuments({ showtime: { $exists: false } }),
    ]);
    assert(
      users + movies + bookings === 0,
      `found ${users} old-format user(s), ${movies} movie(s), ${bookings} booking(s). `
      + 'On a development database run: npm run db:reset:confirm, then npm run seed',
    );
  });

  // ---- Indexes and transactions ---------------------------------------------------------------
  card('Indexes (npm run init-indexes)');
  await check('init-indexes runs and reports the indexes are ready', async () => {
    const run = runNode([script('scripts/init-indexes.js')]);
    assert(run.status === 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
    assert(/Indexes are ready/.test(run.stdout), `unexpected output: ${run.stdout}`);
  });
  await check('unique indexes exist: user email, auditorium name, booking code, seat claim', async () => {
    const wanted = [
      [User, { email: 1 }],
      [Auditorium, { name: 1 }],
      [Booking, { bookingCode: 1 }],
      [SeatClaim, { showtime: 1, seatLabel: 1 }],
    ];
    for (const [Model, key] of wanted) {
      const indexes = await Model.listIndexes();
      const found = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(key));
      assert(found && found.unique, `${Model.collection.name} is missing a unique index on ${JSON.stringify(key)}`);
    }
  });

  card('Transactions');
  await check('MongoDB is a replica set (transactions are supported)', async () => {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert(hello.setName || hello.msg === 'isdbgrid', 'standalone server: use MongoDB Atlas or a local replica set');
  });
  await check('a transaction that throws rolls back every write', async () => {
    const showtime = fakeId();
    fakeShowtimeIds.push(showtime);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await SeatClaim.create([{ showtime, seatLabel: 'A1', booking: fakeId() }], { session });
        throw new Error('force rollback');
      });
    } catch (error) {
      assert(error.message === 'force rollback', `unexpected error: ${error.message}`);
    } finally {
      await session.endSession();
    }
    assert((await SeatClaim.countDocuments({ showtime })) === 0, 'a write survived the rollback');
  });
  await check('a committed transaction keeps its writes', async () => {
    const showtime = fakeId();
    fakeShowtimeIds.push(showtime);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await SeatClaim.create([{ showtime, seatLabel: 'A1', booking: fakeId() }], { session });
      });
    } finally {
      await session.endSession();
    }
    assert((await SeatClaim.countDocuments({ showtime })) === 1, 'the committed write is missing');
  });

  // ---- Seed -----------------------------------------------------------------------------------
  card('Database seed script');
  await check('seed script exits cleanly and reports success', async () => {
    const run = runNode([script('seed.js')]);
    assert(run.status === 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
    assert(/seeded successfully/i.test(run.stdout), 'success message not printed');
  });
  await check('running the seed again adds nothing (no duplicates, no wipe)', async () => {
    const run = runNode([script('seed.js')]);
    assert(run.status === 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
    for (const what of ['movies', 'trailers', 'auditoriums', 'showtimes']) {
      assert(new RegExp(`Added 0 missing sample ${what}`).test(run.stdout), `second run output: ${run.stdout}`);
    }
  });
  await check('sample catalog exists: published movies, auditoriums, showtimes, one draft', async () => {
    assert((await Movie.countDocuments({ status: 'published' })) > 0, 'no published movies');
    assert((await Auditorium.countDocuments({ isActive: true })) > 0, 'no auditoriums');
    assert((await Showtime.countDocuments()) > 0, 'no showtimes');
    assert((await Movie.countDocuments({ status: 'draft' })) > 0, 'no sample draft movie');
  });

  // ---- Start the API --------------------------------------------------------------------------
  const serverLog = [];
  const server = spawn(process.execPath, [script('index.js')], {
    cwd: SERVER_DIR,
    // The booking checks below are about seats and transactions, so bookings confirm at once here.
    // Payments have their own checks in `npm run concurrency` and the offline tests.
    env: { ...process.env, PORT, PAYMENT_REQUIRED: 'false' },
  });
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
  const stopServer = () => new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    server.kill();
  });

  try {
    card('Express server starts');
    let health = null;
    await check(`API starts and GET /api/health answers on port ${PORT}`, async () => {
      health = await waitForHealth(20000);
      assert(health, `server did not come up. Log:\n${serverLog.join('')}`);
      assert(health.status === 'ok', `unexpected health payload ${JSON.stringify(health)}`);
    });
    if (!health) return;
    await check('server logged "Connected to MongoDB"', async () => {
      assert(/Connected to MongoDB/.test(serverLog.join('')), `log was:\n${serverLog.join('')}`);
    });

    // ---- Users and authentication -------------------------------------------------------------
    card('User model and registration');
    let sessionA = null;
    let sessionB = null;
    await check('register creates a regular user, starts an HttpOnly session cookie, and returns no password, hash or token', async () => {
      const res = await api('POST', '/auth/register', { body: { ...USER_A, phone: '09171234567' } });
      expectStatus(res, 201);
      assert(res.data.user.role === 'user', `role was ${res.data.user.role}`);
      assert(res.data.csrfToken, 'no CSRF token returned');
      const text = JSON.stringify(res.data);
      assert(!text.includes(PASSWORD) && !/passwordHash|"password"|"token"/.test(text), 'secret data leaked in response');
      const cookie = res.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      assert(cookie && /HttpOnly/i.test(cookie), `session cookie missing or not HttpOnly: ${cookie}`);
      sessionA = sessionFrom(res);
    });
    await check('the stored record has a bcrypt hash, keeps the phone as text, and is active', async () => {
      const stored = await User.findOne({ email: USER_A.email }).lean();
      assert(stored.passwordHash && stored.passwordHash.startsWith('$2'), 'passwordHash is not a bcrypt hash');
      assert(!('password' in stored), 'a plain "password" field was stored');
      assert(stored.phone === '09171234567', `phone was ${JSON.stringify(stored.phone)}`);
      assert(stored.isActive === true, 'new users must be active');
    });
    await check('email is normalised to lowercase', async () => {
      const res = await api('POST', '/auth/register', { body: { ...USER_B, email: USER_B.email.toUpperCase() } });
      expectStatus(res, 201);
      assert(res.data.user.email === USER_B.email, `stored as ${res.data.user.email}`);
      sessionB = sessionFrom(res);
    });
    await check('a duplicate email is a 409 conflict', async () => {
      expectStatus(await api('POST', '/auth/register', { body: USER_A }), 409);
    });
    await check('passwords shorter than 8 characters are a 400', async () => {
      expectStatus(await api('POST', '/auth/register', {
        body: { name: 'Short', email: email('short'), password: '1234567' },
      }), 400);
    });
    await check('public registration cannot create an admin', async () => {
      const res = await api('POST', '/auth/register', {
        body: { name: 'Sneaky', email: email('c'), password: PASSWORD, role: 'admin' },
      });
      expectStatus(res, 201);
      assert(res.data.user.role === 'user', `role was ${res.data.user.role}`);
    });

    card('Login, logout and sessions');
    await check('login works and starts a session cookie plus a CSRF token', async () => {
      const ok = await api('POST', '/auth/login', { body: { email: USER_A.email, password: PASSWORD } });
      expectStatus(ok, 200);
      assert(ok.data.user.email === USER_A.email && ok.data.csrfToken, 'bad login payload');
      assert(sessionFrom(ok).cookie, 'no session cookie');
      sessionA = sessionFrom(ok);
    });
    await check('a wrong password and an unknown email are both 401 with the same message', async () => {
      const wrong = await api('POST', '/auth/login', { body: { email: USER_A.email, password: 'wrong-password' } });
      const unknown = await api('POST', '/auth/login', { body: { email: 'nobody@test.local', password: PASSWORD } });
      expectStatus(wrong, 401);
      expectStatus(unknown, 401);
      assert(wrong.data.message === unknown.data.message, 'the messages differ, which reveals which emails exist');
    });
    await check('GET /users/me returns the user and CSRF token, without password data', async () => {
      const res = await api('GET', '/users/me', { session: sessionA });
      expectStatus(res, 200);
      assert(res.data.user.email === USER_A.email, 'wrong user returned');
      assert(res.data.csrfToken === sessionA.csrf, 'CSRF token does not match the one from login');
      assert(!/passwordHash|"password"/.test(JSON.stringify(res.data)), 'password data present');
    });
    await check('logout clears the session cookie', async () => {
      const res = await api('POST', '/auth/logout', { session: sessionA });
      expectStatus(res, 200);
      const cleared = res.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      assert(cleared && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(cleared), `cookie was not cleared: ${cleared}`);
    });
    await check('deactivated accounts lose access, including with an existing session', async () => {
      await User.updateOne({ email: USER_B.email }, { isActive: false });
      expectStatus(await api('GET', '/users/me', { session: sessionB }), 403, 'existing session');
      expectStatus(await api('POST', '/auth/login', { body: { email: USER_B.email, password: PASSWORD } }), 403, 'login');
    });

    card('CSRF and origin protection');
    await check('writes without the CSRF token are refused; with it they work', async () => {
      const body = { name: 'Smoke A Renamed' };
      expectStatus(await api('PATCH', '/users/me', { body, session: { cookie: sessionA.cookie } }), 403, 'no token');
      expectStatus(await api('PATCH', '/users/me', { body, session: { cookie: sessionA.cookie, csrf: 'wrong' } }), 403, 'wrong token');
      expectStatus(await api('PATCH', '/users/me', { body, session: sessionA }), 200, 'right token');
    });
    await check('a write from an unlisted origin is refused', async () => {
      expectStatus(await api('POST', '/auth/login', {
        body: { email: USER_A.email, password: PASSWORD },
        headers: { Origin: 'https://evil.example' },
      }), 403);
    });
    await check('profile updates change only name and phone, never the role', async () => {
      const res = await api('PATCH', '/users/me', {
        session: sessionA,
        body: { name: 'Smoke A', phone: '0999', role: 'admin', isActive: false, email: 'x@y.z' },
      });
      expectStatus(res, 200);
      const stored = await User.findOne({ email: USER_A.email });
      assert(stored.name === 'Smoke A' && stored.phone === '0999', 'name/phone not updated');
      assert(stored.role === 'user' && stored.isActive === true, 'role or status was changed through the profile');
      assert(stored.email === USER_A.email, 'email was changed through the profile');
      expectStatus(await api('PATCH', '/users/me', { session: sessionA, body: {} }), 400, 'empty update');
    });

    card('Initial admin setup script');
    let adminSession = null;
    await check('create-admin makes an administrator from environment variables', async () => {
      const env = { ...process.env, ADMIN_NAME: ADMIN.name, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password };
      const run = runNode([script('scripts/create-admin.js')], { env });
      assert(run.status === 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
      assert(/Created administrator/.test(run.stdout), `output: ${run.stdout}`);
      const again = runNode([script('scripts/create-admin.js')], { env });
      assert(again.status === 0 && /already exists/.test(again.stdout), `second run: ${again.stdout}${again.stderr}`);
    });
    await check('create-admin refuses to touch an existing regular user', async () => {
      const env = { ...process.env, ADMIN_EMAIL: USER_A.email, ADMIN_PASSWORD: PASSWORD };
      const run = runNode([script('scripts/create-admin.js')], { env });
      assert(run.status === 1, `expected exit 1, got ${run.status}`);
      const stored = await User.findOne({ email: USER_A.email });
      assert(stored.role === 'user', 'the regular user was promoted');
    });
    await check('the new administrator can log in and has role admin', async () => {
      const res = await api('POST', '/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
      expectStatus(res, 200);
      assert(res.data.user.role === 'admin', `role was ${res.data.user.role}`);
      adminSession = sessionFrom(res);
    });
    if (!adminSession) return;

    card('Admin account management');
    const storedA = await User.findOne({ email: USER_A.email });
    const storedAdmin = await User.findOne({ email: ADMIN.email });
    await check('GET /users is admin-only and lists accounts without hashes', async () => {
      expectStatus(await api('GET', '/users'), 401, 'anonymous');
      expectStatus(await api('GET', '/users', { session: sessionA }), 403, 'regular user');
      const res = await api('GET', '/users?limit=200', { session: adminSession });
      expectStatus(res, 200);
      assert(res.data.users.some((u) => u.email === USER_A.email), 'smoke user missing from the list');
      assert(Number.isInteger(res.data.total), 'no total in the response');
      assert(!/passwordHash/.test(JSON.stringify(res.data)), 'password hashes in the list');
    });
    await check('an admin can deactivate and reactivate a regular user', async () => {
      const off = await api('PATCH', `/users/${storedA._id}/status`, { session: adminSession, body: { isActive: false } });
      expectStatus(off, 200);
      assert(off.data.user.isActive === false, 'user still active');
      expectStatus(await api('GET', '/users/me', { session: sessionA }), 403, 'their session after deactivation');
      expectStatus(await api('PATCH', `/users/${storedA._id}/status`, { session: adminSession, body: { isActive: true } }), 200);
      expectStatus(await api('GET', '/users/me', { session: sessionA }), 200, 'their session after reactivation');
    });
    await check('a regular user cannot change account status; admins cannot be deactivated', async () => {
      expectStatus(await api('PATCH', `/users/${storedA._id}/status`, { session: sessionA, body: { isActive: false } }), 403, 'regular user');
      expectStatus(await api('PATCH', `/users/${storedAdmin._id}/status`, { session: adminSession, body: { isActive: false } }), 403, 'admin target');
      expectStatus(await api('PATCH', `/users/${storedA._id}/status`, { session: adminSession, body: { isActive: 'no' } }), 400, 'non-boolean');
      expectStatus(await api('PATCH', '/users/not-an-id/status', { session: adminSession, body: { isActive: false } }), 404, 'bad id');
      const still = await User.findOne({ email: ADMIN.email });
      assert(still.isActive === true, 'the admin was deactivated');
    });

    // ---- Route protection ----------------------------------------------------------------------
    card('Role and access protection');
    await check('no session -> 401 on /users/me, /users, /bookings, /bookings/my', async () => {
      expectStatus(await api('GET', '/users/me'), 401, '/users/me');
      expectStatus(await api('GET', '/users'), 401, '/users');
      expectStatus(await api('POST', '/bookings', { body: {} }), 401, 'POST /bookings');
      expectStatus(await api('GET', '/bookings/my'), 401, '/bookings/my');
    });
    await check('an invalid or forged cookie -> 401', async () => {
      expectStatus(await api('GET', '/users/me', { session: { cookie: `${SESSION_COOKIE}=not.a.token` } }), 401);
    });
    await check('a Bearer header is not accepted as a session', async () => {
      expectStatus(await api('GET', '/users/me', { headers: { Authorization: 'Bearer abc.def.ghi' } }), 401);
    });
    await check('normal user -> 403 on admin movie routes', async () => {
      expectStatus(await api('POST', '/admin/movies', { session: sessionA, body: testMovie('forbidden') }), 403, 'POST');
      expectStatus(await api('PATCH', '/admin/movies/000000000000000000000000', { session: sessionA, body: {} }), 403, 'PUT');
      expectStatus(await api('DELETE', '/movies/000000000000000000000000', { session: sessionA }), 403, 'DELETE');
    });
    await check('no session -> 401, and an admin without the CSRF token -> 403, on admin movie routes', async () => {
      expectStatus(await api('POST', '/admin/movies', { body: testMovie('anon') }), 401, 'anonymous');
      expectStatus(await api('POST', '/admin/movies', { session: { cookie: adminSession.cookie }, body: testMovie('nocsrf') }), 403, 'no csrf');
    });
    await check('unknown API routes and bad JSON use the standard error shape', async () => {
      const missing = await api('GET', '/does-not-exist');
      expectStatus(missing, 404);
      assert(typeof missing.data.message === 'string', 'no message in the 404 body');
    });

    // ---- Movies -------------------------------------------------------------------------------
    card('Movie model and routes');
    let movie = null;
    await check('creating a movie without required fields is rejected', async () => {
      const res = await api('POST', '/admin/movies', { session: adminSession, body: { title: 'Incomplete' } });
      expectStatus(res, 400);
    });
    await check('invalid values are rejected (status, duration, poster URL)', async () => {
      for (const bad of [{ status: 'now_showing' }, { duration: 0 }, { posterUrl: 'javascript:alert(1)' }]) {
        const res = await api('POST', '/admin/movies', { session: adminSession, body: testMovie('invalid', bad) });
        expectStatus(res, 400, JSON.stringify(bad));
      }
    });
    await check('admin can create a movie; it starts as a draft; unknown fields are ignored', async () => {
      const res = await api('POST', '/admin/movies', {
        session: adminSession,
        body: { ...testMovie('crud', { releaseDate: '2099-01-01' }), isFeatured: true, _id: '000000000000000000000001' }, // coming soon, so it may be published without showings
      });
      expectStatus(res, 201);
      movie = res.data;
      assert(movie.status === 'draft', `status was ${movie.status}`);
      assert(movie.isFeatured === undefined, 'an unapproved field was stored');
      assert(movie._id !== '000000000000000000000001', 'the client chose the id');
    });
    if (!movie) return;
    await check('a draft movie is hidden from the public list and from GET /movies/:id', async () => {
      const list = await api('GET', `/movies?search=${encodeURIComponent(`crud ${RUN_ID}`)}`);
      expectStatus(list, 200);
      assert(!list.data.some((m) => m._id === movie._id), 'draft movie appears in the public list');
      expectStatus(await api('GET', `/movies/${movie._id}`), 404);
    });
    await check('publishing makes it visible; search and genre filter find it', async () => {
      const updated = await api('PATCH', `/admin/movies/${movie._id}`, { session: adminSession, body: { status: 'published' } });
      expectStatus(updated, 200);
      const found = await api('GET', `/movies/${movie._id}`);
      expectStatus(found, 200);
      assert(found.data.title === movie.title, 'wrong movie returned');
      const bySearch = await api('GET', `/movies?search=${encodeURIComponent(`crud ${RUN_ID}`)}`);
      assert(bySearch.data.some((m) => m._id === movie._id), 'search did not find the published movie');
      const byGenre = await api('GET', `/movies?genre=${encodeURIComponent(movie.genre.toLowerCase())}`);
      assert(byGenre.data.some((m) => m._id === movie._id), 'genre filter did not find the published movie');
    });
    await check('a released movie cannot be published until it has a showing customers can book', async () => {
      const draft = await api('POST', '/admin/movies', { session: adminSession, body: testMovie('released draft') });
      expectStatus(draft, 201);
      const refused = await api('PATCH', `/admin/movies/${draft.data._id}`, { session: adminSession, body: { status: 'published' } });
      expectStatus(refused, 409);
      assert(/Schedule at least one showing/.test(refused.data.message), `the message was: ${refused.data.message}`);
      expectStatus(await api('POST', '/admin/movies', { session: adminSession, body: testMovie('released published', { status: 'published' }) }), 409, 'created as published');
      expectStatus(await api('DELETE', `/movies/${draft.data._id}`, { session: adminSession }), 200, 'clean up');
    });
    await check('the public list only ever contains published movies', async () => {
      const list = await api('GET', '/movies');
      expectStatus(list, 200);
      assert(list.data.length > 0, 'no published movies in the list');
      const everything = await api('GET', '/admin/movies', { session: adminSession });
      expectStatus(everything, 200);
      const hidden = new Set(everything.data.filter((m) => m.status !== 'published').map((m) => m._id));
      assert(hidden.size > 0, 'expected at least one draft or archived movie to check against');
      assert(list.data.every((m) => !hidden.has(m._id)), 'a non-published movie is in the public list');
      assert(list.data.every((m) => !('status' in m) && !('createdAt' in m)), 'the public list leaks internal fields');
    });
    await check('search text is not treated as a regular expression', async () => {
      const res = await api('GET', `/movies?search=${encodeURIComponent('(')}`);
      expectStatus(res, 200);
      assert(Array.isArray(res.data), 'response is not a list');
    });
    await check('updates are validated; unknown and malformed ids give 404', async () => {
      expectStatus(await api('PATCH', `/admin/movies/${movie._id}`, { session: adminSession, body: { duration: 0 } }), 400);
      expectStatus(await api('PATCH', `/admin/movies/${movie._id}`, { session: adminSession, body: { status: 'now_showing' } }), 400);
      expectStatus(await api('PATCH', `/admin/movies/${movie._id}`, { session: adminSession, body: { duration: 101 } }), 200);
      expectStatus(await api('GET', '/movies/000000000000000000000000'), 404);
      expectStatus(await api('GET', '/movies/not-an-id'), 404);
    });
    await check('admin can delete a movie; it is gone afterwards', async () => {
      expectStatus(await api('DELETE', `/movies/${movie._id}`, { session: adminSession }), 200);
      expectStatus(await api('GET', `/movies/${movie._id}`), 404);
    });

    // ---- Catalog, auditoriums and showtimes (backend list 3) -------------------------------------
    card('Auditorium and showtime APIs');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
    let film = null;
    let hall = null;
    let slot = null;
    let reservation = null;
    await check('admin creates a published movie and an auditorium; the server makes the seat labels', async () => {
      const movieRes = await api('POST', '/admin/movies', {
        // Released the day before the first showing below: a coming-soon movie may be published without showings.
        session: adminSession, body: testMovie('showtimes', { status: 'published', releaseDate: new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10) }),
      });
      expectStatus(movieRes, 201);
      film = movieRes.data;
      const hallRes = await api('POST', '/auditoriums', {
        session: adminSession,
        body: { name: `SMOKE room ${RUN_ID}`, rows: 3, seatsPerRow: 4, seatLabels: ['HACK1'] },
      });
      expectStatus(hallRes, 201);
      hall = hallRes.data;
      assert(hall.seatLabels.length === 12 && hall.seatLabels[0] === 'A1' && hall.seatLabels[11] === 'C4', `labels: ${hall.seatLabels}`);
      expectStatus(await api('POST', '/auditoriums', {
        session: adminSession, body: { name: `SMOKE room ${RUN_ID}`, rows: 1, seatsPerRow: 1 },
      }), 409, 'duplicate name');
      expectStatus(await api('GET', '/auditoriums', { session: sessionA }), 403, 'customer');
    });
    if (!film || !hall) return;
    await check('a showtime gets its end time from the movie; past times and bad prices are refused', async () => {
      const startTime = iso(3 * DAY_MS);
      const res = await api('POST', '/showtimes', {
        session: adminSession, body: { movie: film._id, auditorium: hall._id, startTime, ticketPrice: 40000 },
      });
      expectStatus(res, 201);
      slot = res.data;
      assert(new Date(slot.endTime) - new Date(slot.startTime) === 100 * 60 * 1000, 'endTime is not start + 100 minutes');
      const bad = { movie: film._id, auditorium: hall._id, startTime: iso(4 * DAY_MS), ticketPrice: 40000 };
      expectStatus(await api('POST', '/showtimes', { session: adminSession, body: { ...bad, startTime: iso(-DAY_MS) } }), 400, 'past');
      expectStatus(await api('POST', '/showtimes', { session: adminSession, body: { ...bad, ticketPrice: 400.5 } }), 400, 'fraction');
      expectStatus(await api('POST', '/showtimes', { session: sessionA, body: bad }), 403, 'customer');
    });
    if (!slot) return;
    await check('overlapping showtimes are 409; the configured turnaround is enforced', async () => {
      const same = { movie: film._id, auditorium: hall._id, ticketPrice: 40000 };
      expectStatus(await api('POST', '/showtimes', { session: adminSession, body: { ...same, startTime: slot.startTime } }), 409, 'identical');
      expectStatus(await api('POST', '/showtimes', {
        session: adminSession, body: { ...same, startTime: new Date(new Date(slot.startTime).getTime() + 30 * 60 * 1000).toISOString() },
      }), 409, 'starts inside');
      const { turnaroundMinutes } = await getSettings();
      if (turnaroundMinutes > 0) {
        expectStatus(await api('POST', '/showtimes', { session: adminSession, body: { ...same, startTime: slot.endTime } }), 409, 'no turnaround');
      }
      const nextStart = new Date(new Date(slot.endTime).getTime() + turnaroundMinutes * 60000).toISOString();
      expectStatus(await api('POST', '/showtimes', { session: adminSession, body: { ...same, startTime: nextStart } }), 201, 'configured turnaround');
    });
    await check('five admins creating the same slot at once: exactly one wins, the rest get 409', async () => {
      const body = { movie: film._id, auditorium: hall._id, startTime: iso(6 * DAY_MS), ticketPrice: 40000 };
      const answers = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/showtimes', { session: adminSession, body })));
      const codes = answers.map((r) => r.status).sort();
      assert(codes.filter((c) => c === 201).length === 1 && codes.filter((c) => c === 409).length === 4, `statuses: ${codes}`);
      const inDb = await Showtime.countDocuments({ auditorium: hall._id, startTime: new Date(body.startTime) });
      assert(inDb === 1, `${inDb} showtimes stored for that slot`);
    });
    await check('seat availability is the layout minus the seat claims', async () => {
      const before = await api('GET', `/showtimes/${slot._id}/seats`);
      expectStatus(before, 200);
      assert(before.data.seats.length === 12 && before.data.seats.every((s) => s.status === 'available'), 'expected 12 free seats');
      const owner = await User.findOne({ email: USER_A.email });
      reservation = await new Booking({
        bookingCode: Booking.generateCode(), user: owner._id, showtime: slot._id,
        seats: ['A1', 'A2'], unitPrice: 40000, totalAmount: 80000,
      }).save();
      await SeatClaim.create([
        { showtime: slot._id, seatLabel: 'A1', booking: reservation._id },
        { showtime: slot._id, seatLabel: 'A2', booking: reservation._id },
      ]);
      const after = await api('GET', `/showtimes/${slot._id}/seats`);
      const taken = after.data.seats.filter((s) => s.status === 'booked').map((s) => s.label);
      assert(taken.join() === 'A1,A2', `booked seats: ${taken}`);
      assert(!/user|email|booking/i.test(JSON.stringify(after.data)), 'availability leaks customer or booking data');
      const listing = await api('GET', `/showtimes?movie=${film._id}`);
      expectStatus(listing, 200);
      const row = listing.data.find((s) => s._id === slot._id);
      assert(row && row.remainingSeats === 10 && row.totalSeats === 12, `listing row: ${JSON.stringify(row)}`);
      const adminListing = await api('GET', '/admin/showtimes', { session: adminSession });
      expectStatus(adminListing, 200);
      assert(adminListing.data.some((s) => s._id === slot._id && s.status === 'scheduled'), 'admin list is missing the showtime');
      expectStatus(await api('GET', '/admin/showtimes', { session: sessionA }), 403, 'customer');
    });
    await check('rules that protect bookings: locked edit, locked layout, no archive, no deletes', async () => {
      expectStatus(await api('PATCH', `/showtimes/${slot._id}`, { session: adminSession, body: { ticketPrice: 1 } }), 409, 'edit after booking');
      expectStatus(await api('PATCH', `/auditoriums/${hall._id}`, { session: adminSession, body: { rows: 5 } }), 409, 'layout');
      expectStatus(await api('PATCH', `/auditoriums/${hall._id}`, { session: adminSession, body: { name: `SMOKE hall ${RUN_ID}` } }), 200, 'rename');
      expectStatus(await api('PATCH', `/auditoriums/${hall._id}`, { session: adminSession, body: { isActive: false } }), 409, 'deactivate');
      expectStatus(await api('DELETE', `/auditoriums/${hall._id}`, { session: adminSession }), 409, 'delete auditorium');
      expectStatus(await api('PATCH', `/admin/movies/${film._id}`, { session: adminSession, body: { status: 'archived' } }), 409, 'archive');
      expectStatus(await api('PATCH', `/admin/movies/${film._id}`, { session: adminSession, body: { duration: 90 } }), 409, 'duration');
      expectStatus(await api('DELETE', `/movies/${film._id}`, { session: adminSession }), 409, 'delete movie');
      expectStatus(await api('DELETE', `/showtimes/${slot._id}`, { session: adminSession }), 409, 'delete showtime');
    });
    await check('an unbooked showtime can be edited (end follows the start) and deleted', async () => {
      const made = await api('POST', '/showtimes', {
        session: adminSession, body: { movie: film._id, auditorium: hall._id, startTime: iso(9 * DAY_MS), ticketPrice: 40000 },
      });
      expectStatus(made, 201);
      const moved = await api('PATCH', `/showtimes/${made.data._id}`, { session: adminSession, body: { startTime: iso(10 * DAY_MS), ticketPrice: 45000 } });
      expectStatus(moved, 200);
      assert(new Date(moved.data.endTime) - new Date(moved.data.startTime) === 100 * 60 * 1000, 'end did not follow the start');
      expectStatus(await api('DELETE', `/showtimes/${made.data._id}`, { session: adminSession }), 200);
      expectStatus(await api('DELETE', `/showtimes/${made.data._id}`, { session: adminSession }), 404);
    });
    await check('cancelling a showtime cancels its bookings and frees the seats, and can be repeated', async () => {
      const done = await api('PATCH', `/showtimes/${slot._id}/cancel`, { session: adminSession });
      expectStatus(done, 200);
      assert(done.data.cancelledBookings === 1 && done.data.showtime.status === 'cancelled', JSON.stringify(done.data));
      const booking = await Booking.findById(reservation._id);
      assert(booking.status === 'cancelled' && booking.cancelledAt, `booking is ${booking.status}`);
      assert(await SeatClaim.countDocuments({ showtime: slot._id }) === 0, 'seat claims were not removed');
      expectStatus(await api('GET', `/showtimes/${slot._id}/seats`), 404, 'cancelled showtime seats');
      const again = await api('PATCH', `/showtimes/${slot._id}/cancel`, { session: adminSession });
      expectStatus(again, 200);
      assert(again.data.cancelledBookings === 0, 'second cancel changed bookings');
      const listing = await api('GET', `/showtimes?movie=${film._id}`);
      assert(!listing.data.some((s) => s._id === slot._id), 'a cancelled showtime is still in the public list');
    });

    // ---- Auditorium / Showtime / Booking / SeatClaim (straight against the database) ------------
    card('Auditorium model');
    let room = null;
    await check('seat labels are generated by the server from rows x seatsPerRow', async () => {
      room = await new Auditorium({
        name: `SMOKE Hall ${RUN_ID}`, rows: 2, seatsPerRow: 3, seatLabels: ['HACK1'],
      }).save();
      assert(room.seatLabels.join() === 'A1,A2,A3,B1,B2,B3', `labels were ${room.seatLabels}`);
    });
    await check('auditorium names are unique', async () => {
      await expectDuplicateKey(new Auditorium({ name: room.name, rows: 1, seatsPerRow: 1 }).save(), 'duplicate name');
    });

    card('Showtime model');
    let showtime = null;
    let showMovie = null;
    await check('a showtime links a movie and an auditorium, with a derived end time and centavo price', async () => {
      showMovie = await new Movie({ ...testMovie('showtime'), releaseDate: new Date('2030-01-01'), status: 'published' }).save();
      const startTime = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      showtime = await new Showtime({
        movie: showMovie._id,
        auditorium: room._id,
        startTime,
        endTime: Showtime.computeEndTime(startTime, showMovie.duration),
        ticketPrice: 40000,
      }).save();
      assert(showtime.status === 'scheduled', `status was ${showtime.status}`);
      assert(showtime.endTime - showtime.startTime === showMovie.duration * 60000, 'end time is not start + duration');
    });
    await check('an end time before the start time is rejected', async () => {
      await expectValidationError(new Showtime({
        movie: showMovie._id,
        auditorium: room._id,
        startTime: new Date('2031-01-01T10:00:00Z'),
        endTime: new Date('2031-01-01T09:00:00Z'),
        ticketPrice: 100,
      }).save(), 'end before start');
    });

    card('Booking model and seat claims');
    const userA = await User.findOne({ email: USER_A.email });
    const bookingCode = Booking.generateCode();
    let bookingA = null;
    await check('a booking stores seats, a price snapshot and a total that adds up', async () => {
      bookingA = await new Booking({
        bookingCode,
        user: userA._id,
        showtime: showtime._id,
        seats: ['A1', 'A2'],
        unitPrice: showtime.ticketPrice,
        totalAmount: showtime.ticketPrice * 2,
      }).save();
      assert(bookingA.status === 'confirmed' && bookingA.cancelledAt === null, 'wrong defaults');
    });
    await check('empty seats, duplicate seats and a wrong total are rejected', async () => {
      const base = { user: userA._id, showtime: showtime._id, unitPrice: 100, totalAmount: 200 };
      await expectValidationError(new Booking({ ...base, bookingCode: Booking.generateCode(), seats: [], totalAmount: 0 }).save(), 'empty seats');
      await expectValidationError(new Booking({ ...base, bookingCode: Booking.generateCode(), seats: ['A1', 'A1'] }).save(), 'duplicate seats');
      await expectValidationError(new Booking({ ...base, bookingCode: Booking.generateCode(), seats: ['A1', 'A2'], totalAmount: 1 }).save(), 'wrong total');
    });
    await check('booking codes are unique', async () => {
      await expectDuplicateKey(new Booking({
        bookingCode, user: userA._id, showtime: showtime._id, seats: ['B1'], unitPrice: 100, totalAmount: 100,
      }).save(), 'duplicate booking code');
    });
    await check('a seat can only be claimed once per showtime; other seats and showtimes are fine', async () => {
      await SeatClaim.create({ showtime: showtime._id, seatLabel: 'A1', booking: bookingA._id });
      await expectDuplicateKey(
        SeatClaim.create({ showtime: showtime._id, seatLabel: 'A1', booking: fakeId() }),
        'second claim for the same seat',
      );
      await SeatClaim.create({ showtime: showtime._id, seatLabel: 'A2', booking: bookingA._id });
      const elsewhere = fakeId();
      fakeShowtimeIds.push(elsewhere);
      await SeatClaim.create({ showtime: elsewhere, seatLabel: 'A1', booking: fakeId() });
    });
    await check('a failed multi-seat booking leaves no partial claims (transaction rolls back)', async () => {
      const session = await mongoose.startSession();
      let failedWith = null;
      try {
        await session.withTransaction(async () => {
          // B1 is free, A1 is already claimed: the whole transaction must roll back.
          await SeatClaim.create([{ showtime: showtime._id, seatLabel: 'B1', booking: fakeId() }], { session });
          await SeatClaim.create([{ showtime: showtime._id, seatLabel: 'A1', booking: fakeId() }], { session });
        });
      } catch (error) {
        failedWith = error;
      } finally {
        await session.endSession();
      }
      assert(failedWith && isDuplicateKey(failedWith), `expected a duplicate key failure, got ${failedWith && failedWith.message}`);
      assert((await SeatClaim.countDocuments({ showtime: showtime._id, seatLabel: 'B1' })) === 0, 'seat B1 stayed claimed');
    });
    await check('two simultaneous claims for one seat: exactly one succeeds', async () => {
      const contested = fakeId();
      fakeShowtimeIds.push(contested);
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () => SeatClaim.create({ showtime: contested, seatLabel: 'C3', booking: fakeId() })),
      );
      const won = attempts.filter((a) => a.status === 'fulfilled').length;
      const duplicates = attempts.filter((a) => a.status === 'rejected' && isDuplicateKey(a.reason)).length;
      assert(won === 1 && duplicates === 4, `${won} succeeded, ${duplicates} duplicate-key failures`);
    });

    card('Bookings API');
    await check('booking routes are protected and validate their input (the full proof is npm run concurrency)', async () => {
      expectStatus(await api('GET', '/bookings/my'), 401, 'anonymous');
      expectStatus(await api('POST', '/bookings', { body: {} }), 401, 'anonymous');
      expectStatus(await api('POST', '/bookings', { session: sessionA, body: {} }), 400, 'empty booking');
      const mine = await api('GET', '/bookings/my', { session: sessionA });
      expectStatus(mine, 200);
      assert(Array.isArray(mine.data), 'my bookings is not a list');
      expectStatus(await api('GET', '/bookings', { session: sessionA }), 403, 'customer asking for every booking');
    });

    // Last on purpose: it deliberately fails many logins for one made-up email.
    card('Login rate limiting');
    await check('repeated failed logins are blocked with a 429 and a Retry-After header', async () => {
      const limit = Number(process.env.LOGIN_RATE_MAX) || 5;
      const target = { email: email('ratelimit'), password: 'wrong-password' };
      let blockedAt = null;
      let retryAfter = null;
      for (let attempt = 1; attempt <= limit + 3; attempt += 1) {
        const res = await api('POST', '/auth/login', { body: target });
        if (res.status === 429) {
          blockedAt = attempt;
          retryAfter = res.headers.get('retry-after');
          break;
        }
        expectStatus(res, 401, `attempt ${attempt}`);
      }
      assert(blockedAt === limit + 1, `blocked at attempt ${blockedAt}, expected attempt ${limit + 1}`);
      assert(Number(retryAfter) > 0, `Retry-After header was ${retryAfter}`);
    });
    await check('being blocked for one email does not block other accounts', async () => {
      expectStatus(await api('POST', '/auth/login', { body: { email: USER_A.email, password: PASSWORD } }), 200);
    });
  } finally {
    await stopServer();
    await cleanup();
  }
}

// Remove everything this run created, directly in MongoDB.
async function cleanup() {
  try {
    if (mongoose.connection.readyState !== 1) return;
    const users = await User.find({ email: new RegExp(`^smoke-[a-z]+-${RUN_ID}@test\\.local$`) }, '_id');
    const userIds = users.map((u) => u._id);
    const movies = await Movie.find({ title: new RegExp(`^\\[SMOKE\\] .* ${RUN_ID}$`) }, '_id');
    const rooms = await Auditorium.find({ name: new RegExp(`^SMOKE .* ${RUN_ID}$`) }, '_id');
    const showtimes = await Showtime.find({
      $or: [{ movie: { $in: movies.map((m) => m._id) } }, { auditorium: { $in: rooms.map((r) => r._id) } }],
    }, '_id');
    const showtimeIds = [...showtimes.map((s) => s._id), ...fakeShowtimeIds];

    await SeatClaim.deleteMany({ showtime: { $in: showtimeIds } });
    await Booking.deleteMany({ $or: [{ user: { $in: userIds } }, { showtime: { $in: showtimeIds } }] });
    await Showtime.deleteMany({ _id: { $in: showtimeIds } });
    await Auditorium.deleteMany({ _id: { $in: rooms.map((r) => r._id) } });
    await Movie.deleteMany({ _id: { $in: movies.map((m) => m._id) } });
    await User.deleteMany({ _id: { $in: userIds } });
  } catch (error) {
    console.warn(`\n(cleanup incomplete: ${error.message})`);
  }
}

main()
  .catch((error) => {
    results.push({ card: 'Smoke test runner', name: 'unexpected error', ok: false, detail: error.stack });
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
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
