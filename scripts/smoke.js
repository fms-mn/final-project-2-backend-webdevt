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
  releaseDate: '2030-01-01',
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
    for (const what of ['movies', 'auditoriums', 'showtimes']) {
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
    card('User model and authentication');
    let tokenA = null;
    let tokenB = null;
    await check('register creates a regular user and never returns a password or hash', async () => {
      const res = await api('POST', '/auth/register', { body: { ...USER_A, phone: '09171234567' } });
      expectStatus(res, 201);
      assert(res.data.token, 'no token returned');
      assert(res.data.user.role === 'user', `role was ${res.data.user.role}`);
      const text = JSON.stringify(res.data);
      assert(!text.includes(PASSWORD) && !/passwordHash|"password"/.test(text), 'password data leaked in response');
      tokenA = res.data.token;
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
      tokenB = res.data.token;
    });
    await check('duplicate email is rejected', async () => {
      expect4xx(await api('POST', '/auth/register', { body: USER_A }));
    });
    await check('passwords shorter than 8 characters are rejected', async () => {
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
    await check('login works; wrong password and unknown email are rejected', async () => {
      const ok = await api('POST', '/auth/login', { body: { email: USER_A.email, password: PASSWORD } });
      expectStatus(ok, 200);
      assert(ok.data.token && ok.data.user.email === USER_A.email, 'bad login payload');
      expect4xx(await api('POST', '/auth/login', { body: { email: USER_A.email, password: 'wrong-password' } }));
      expect4xx(await api('POST', '/auth/login', { body: { email: 'nobody@test.local', password: PASSWORD } }));
    });
    await check('GET /auth/me returns the logged-in user without password data', async () => {
      const res = await api('GET', '/auth/me', { token: tokenA });
      expectStatus(res, 200);
      assert(res.data.user.email === USER_A.email, 'wrong user returned');
      assert(!/passwordHash|"password"/.test(JSON.stringify(res.data)), 'password data present');
    });
    await check('deactivated accounts lose access, including with an existing token', async () => {
      await User.updateOne({ email: USER_B.email }, { isActive: false });
      expectStatus(await api('GET', '/auth/me', { token: tokenB }), 403, 'existing token');
      expectStatus(await api('POST', '/auth/login', { body: { email: USER_B.email, password: PASSWORD } }), 403, 'login');
    });

    card('Initial admin setup script');
    let adminToken = null;
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
      adminToken = res.data.token;
    });
    if (!adminToken) return;

    // ---- JWT middleware -----------------------------------------------------------------------
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

    // ---- Movies -------------------------------------------------------------------------------
    card('Movie model and routes');
    let movie = null;
    await check('creating a movie without required fields is rejected', async () => {
      const res = await api('POST', '/movies', { token: adminToken, body: { title: 'Incomplete' } });
      expectStatus(res, 400);
    });
    await check('invalid values are rejected (status, duration, poster URL)', async () => {
      for (const bad of [{ status: 'now_showing' }, { duration: 0 }, { posterUrl: 'javascript:alert(1)' }]) {
        const res = await api('POST', '/movies', { token: adminToken, body: testMovie('invalid', bad) });
        expectStatus(res, 400, JSON.stringify(bad));
      }
    });
    await check('admin can create a movie; it starts as a draft; unknown fields are ignored', async () => {
      const res = await api('POST', '/movies', {
        token: adminToken,
        body: { ...testMovie('crud'), isFeatured: true, _id: '000000000000000000000001' },
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
      const updated = await api('PUT', `/movies/${movie._id}`, { token: adminToken, body: { status: 'published' } });
      expectStatus(updated, 200);
      const found = await api('GET', `/movies/${movie._id}`);
      expectStatus(found, 200);
      assert(found.data.title === movie.title, 'wrong movie returned');
      const bySearch = await api('GET', `/movies?search=${encodeURIComponent(`crud ${RUN_ID}`)}`);
      assert(bySearch.data.some((m) => m._id === movie._id), 'search did not find the published movie');
      const byGenre = await api('GET', `/movies?genre=${encodeURIComponent(movie.genre.toLowerCase())}`);
      assert(byGenre.data.some((m) => m._id === movie._id), 'genre filter did not find the published movie');
    });
    await check('the public list only ever contains published movies', async () => {
      const list = await api('GET', '/movies');
      expectStatus(list, 200);
      assert(list.data.length > 0, 'no published movies in the list');
      assert(list.data.every((m) => m.status === 'published'), 'a non-published movie is in the public list');
    });
    await check('search text is not treated as a regular expression', async () => {
      const res = await api('GET', `/movies?search=${encodeURIComponent('(')}`);
      expectStatus(res, 200);
      assert(Array.isArray(res.data), 'response is not a list');
    });
    await check('updates are validated; unknown and malformed ids give 404', async () => {
      expectStatus(await api('PUT', `/movies/${movie._id}`, { token: adminToken, body: { duration: 0 } }), 400);
      expectStatus(await api('PUT', `/movies/${movie._id}`, { token: adminToken, body: { status: 'now_showing' } }), 400);
      expectStatus(await api('PUT', `/movies/${movie._id}`, { token: adminToken, body: { duration: 101 } }), 200);
      expectStatus(await api('GET', '/movies/000000000000000000000000'), 404);
      expectStatus(await api('GET', '/movies/not-an-id'), 404);
    });
    await check('admin can delete a movie; it is gone afterwards', async () => {
      expectStatus(await api('DELETE', `/movies/${movie._id}`, { token: adminToken }), 200);
      expectStatus(await api('GET', `/movies/${movie._id}`), 404);
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

    card('Bookings API (being rebuilt)');
    await check('booking routes answer 501 until the booking engine is built', async () => {
      expectStatus(await api('GET', '/bookings/my', { token: tokenA }), 501);
      expectStatus(await api('POST', '/bookings', { token: tokenA, body: {} }), 501);
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
