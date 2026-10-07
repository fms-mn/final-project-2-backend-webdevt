// Offline tests for list 3: movies, auditoriums, showtimes and seat availability. They run the
// real app and models against the in-memory stand-in in fakeDb.js. Transactions are simulated,
// so the true concurrency behaviour is checked by `npm run smoke` against the real database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';

const test = require('node:test');
const mongoose = require('mongoose');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const Setting = require('../models/Setting');
const { fakeModel, fakeTransactions } = require('./fakeDb');

const PASSWORD = 'correct-horse-1';
const COOKIE = 'filme_session';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const users = [];
const movies = [];
const auditoriums = [];
const showtimes = [];
const bookings = [];
const claims = [];
const settings = [];
let server;
let base;
let passwordHash;
let transactionHook = null;

const clear = () => [users, movies, auditoriums, showtimes, bookings, claims, settings].forEach((rows) => { rows.length = 0; });
// One fixed starting point, so back-to-back showtimes line up to the millisecond.
const T0 = Date.now();
const inFuture = (ms) => new Date(T0 + ms);
const at = (offsetMs) => inFuture(offsetMs).toISOString();

function add(Model, rows, fields) {
  const doc = new Model(fields);
  doc.$isNew = false;
  rows.push(doc);
  return doc;
}
const addMovie = (fields = {}) => add(Movie, movies, {
  title: 'Dune', synopsis: 'Sand.', genre: 'Sci-Fi', rating: 'PG-13', duration: 120,
  posterUrl: 'https://example.com/dune.jpg', releaseDate: new Date('2026-01-01'), status: 'published', ...fields,
});
const addAuditorium = (fields = {}) => {
  const layout = { rows: 2, seatsPerRow: 3, ...fields };
  return add(Auditorium, auditoriums, {
    name: `Hall ${auditoriums.length + 1}`,
    ...layout,
    seatLabels: Auditorium.generateSeatLabels(layout.rows, layout.seatsPerRow),
  });
};
const addShowtime = (movie, auditorium, startOffset, fields = {}) => {
  const startTime = inFuture(startOffset);
  return add(Showtime, showtimes, {
    movie: movie._id, auditorium: auditorium._id, startTime,
    endTime: Showtime.computeEndTime(startTime, movie.duration), ticketPrice: 40000, ...fields,
  });
};
const addBooking = (showtime, fields = {}) => add(Booking, bookings, {
  bookingCode: `FLM-TEST${bookings.length}`, user: new mongoose.Types.ObjectId(), showtime: showtime._id,
  seats: ['A1'], unitPrice: 40000, totalAmount: 40000, ...fields,
});
const addClaim = (showtime, seatLabel, booking) => add(SeatClaim, claims, {
  showtime: showtime._id, seatLabel, booking: booking._id,
});

async function call(method, path, { body, session } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) { headers.Cookie = session.cookie; headers['X-CSRF-Token'] = session.csrf; }
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch { /* no body */ }
  return { status: response.status, data };
}

async function signIn(role) {
  const email = `${role}@example.com`;
  let user = users.find((u) => u.email === email);
  if (!user) {
    user = new User({ name: role, email, passwordHash, role });
    user.$isNew = false;
    users.push(user);
  }
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await response.json();
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE}=`));
  return { cookie, csrf: data.csrfToken };
}

test.before(async () => {
  passwordHash = await User.hashPassword(PASSWORD);
  test.mock.method(User, 'findById', (id) => {
    const find = () => users.find((u) => String(u._id) === String(id)) || null;
    return { select: async () => find(), then: (res, rej) => Promise.resolve().then(find).then(res, rej) };
  });
  test.mock.method(User, 'findOne', async (filter) => users.find((u) => u.email === filter.email) || null);
  fakeModel(Movie, movies);
  fakeModel(Auditorium, auditoriums, { uniqueOn: 'name' });
  fakeModel(Showtime, showtimes);
  fakeModel(Booking, bookings);
  fakeModel(SeatClaim, claims);
  fakeModel(Setting, settings, { uniqueOn: 'key' });
  fakeTransactions({ beforeAttempt: (attempt) => (transactionHook ? transactionHook(attempt) : false) });
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { clear(); transactionHook = null; });

// ---- public movies -------------------------------------------------------------------------
test('public movies: published only, trimmed fields, filters, drafts are 404', async () => {
  const dune = addMovie();
  addMovie({ title: 'Secret Draft', status: 'draft' });
  addMovie({ title: 'Old Film', status: 'archived' });
  addMovie({ title: 'Amelie', genre: 'Romance', releaseDate: new Date('2026-06-15') });

  const list = await call('GET', '/api/movies');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((m) => m.title).sort(), ['Amelie', 'Dune']);
  assert.deepEqual(Object.keys(list.data[0]).sort(), [
    '_id', 'duration', 'genre', 'posterUrl', 'rating', 'releaseDate', 'synopsis', 'title', 'trailerId',
  ]);
  assert.equal(list.data[0].trailerId, null, 'no trailer by default');

  assert.deepEqual((await call('GET', '/api/movies?search=ame')).data.map((m) => m.title), ['Amelie']);
  assert.deepEqual((await call('GET', '/api/movies?search=.*')).data, [], 'search text is not a pattern');
  assert.deepEqual((await call('GET', '/api/movies?genre=romance')).data.map((m) => m.title), ['Amelie']);
  assert.deepEqual((await call('GET', '/api/movies?releaseFrom=2026-03-01')).data.map((m) => m.title), ['Amelie']);
  assert.deepEqual((await call('GET', '/api/movies?releaseTo=2026-03-01')).data.map((m) => m.title), ['Dune']);
  for (const bad of ['releaseFrom=tomorrow', 'releaseTo=2026-02-31', 'releaseFrom=2026-1-1']) {
    assert.equal((await call('GET', `/api/movies?${bad}`)).status, 400, bad);
  }

  assert.equal((await call('GET', `/api/movies/${dune._id}`)).status, 200);
  const draft = movies.find((m) => m.status === 'draft');
  assert.equal((await call('GET', `/api/movies/${draft._id}`)).status, 404);
  assert.equal((await call('GET', '/api/movies/not-an-id')).status, 404);
});

// ---- admin movies --------------------------------------------------------------------------
test('admin movies: only admins, every status listed, writes validated', async () => {
  addMovie();
  addMovie({ title: 'Draft', status: 'draft' });
  const user = await signIn('user');
  const admin = await signIn('admin');

  assert.equal((await call('GET', '/api/admin/movies')).status, 401);
  assert.equal((await call('GET', '/api/admin/movies', { session: user })).status, 403);
  assert.equal((await call('POST', '/api/admin/movies', { body: {}, session: user })).status, 403);
  const all = await call('GET', '/api/admin/movies', { session: admin });
  assert.equal(all.data.length, 2);
  assert.equal((await call('GET', '/api/admin/movies?status=draft', { session: admin })).data.length, 1);
  assert.equal((await call('GET', '/api/admin/movies?status=oops', { session: admin })).status, 400);

  const fresh = {
    title: 'New Film', synopsis: 'Plot.', genre: 'Drama', rating: 'PG', duration: 100,
    posterUrl: 'https://example.com/n.jpg', releaseDate: '2026-12-01', status: 'draft',
  };
  const created = await call('POST', '/api/admin/movies', { body: { ...fresh, _id: 'x', createdAt: 'x' }, session: admin });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'draft');
  const bad = await call('POST', '/api/admin/movies', { body: { ...fresh, posterUrl: 'ftp://x', duration: 0 }, session: admin });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.errors.posterUrl && bad.data.errors.duration);
});

test('admin movies: updates re-validate; archive and duration are guarded by upcoming showtimes', async () => {
  const movie = addMovie();
  const hall = addAuditorium();
  const admin = await signIn('admin');
  const patch = (id, body) => call('PATCH', `/api/admin/movies/${id}`, { body, session: admin });

  assert.equal((await patch(movie._id, { posterUrl: 'not a url' })).status, 400, 'updates are validated too');
  assert.equal((await patch(movie._id, { duration: 1.5 })).status, 400);
  assert.equal((await patch(movie._id, {})).status, 400);
  assert.equal((await patch(movie._id, { _id: 'x' })).status, 400, 'ignored fields do not count');
  assert.equal((await patch('nope', { title: 'x' })).status, 404);
  assert.equal((await patch(movie.title.length ? '0'.repeat(24) : '', { title: 'x' })).status, 404);

  // past, cancelled and other movies' showtimes do not block anything
  addShowtime(movie, hall, -3 * HOUR);
  addShowtime(movie, hall, 5 * HOUR, { status: 'cancelled' });
  assert.equal((await patch(movie._id, { duration: 130 })).status, 200);

  const upcoming = addShowtime(movie, hall, 2 * DAY);
  assert.equal((await patch(movie._id, { duration: 90 })).status, 409, 'duration is locked');
  assert.equal((await patch(movie._id, { duration: 130 })).status, 200, 'same duration is fine');
  assert.equal((await patch(movie._id, { status: 'archived' })).status, 409);
  assert.equal((await patch(movie._id, { status: 'draft' })).status, 409);
  assert.equal((await patch(movie._id, { title: 'Renamed' })).status, 200);
  assert.equal(movie.status, 'published');

  upcoming.status = 'cancelled';
  assert.equal((await patch(movie._id, { status: 'archived' })).status, 200);
});

test('delete movie: only when no showtime ever used it', async () => {
  const used = addMovie({ title: 'Used' });
  const free = addMovie({ title: 'Free' });
  const hall = addAuditorium();
  addShowtime(used, hall, -DAY, { status: 'cancelled' });
  const user = await signIn('user');
  const admin = await signIn('admin');

  assert.equal((await call('DELETE', `/api/movies/${free._id}`)).status, 401);
  assert.equal((await call('DELETE', `/api/movies/${free._id}`, { session: user })).status, 403);
  assert.equal((await call('DELETE', `/api/movies/${used._id}`, { session: admin })).status, 409);
  assert.equal(movies.includes(used), true);
  assert.equal((await call('DELETE', `/api/movies/${free._id}`, { session: admin })).status, 200);
  assert.equal(movies.includes(free), false);
  assert.equal((await call('DELETE', `/api/movies/${free._id}`, { session: admin })).status, 404);
});

// ---- trailers ------------------------------------------------------------------------------
test('trailers: only YouTube links are accepted, the public gets just the video id, empty clears it', async () => {
  const movie = addMovie();
  const admin = await signIn('admin');
  const patch = (body) => call('PATCH', `/api/admin/movies/${movie._id}`, { body, session: admin });
  const publicId = async () => (await call('GET', `/api/movies/${movie._id}`)).data;

  for (const good of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.equal((await patch({ trailerUrl: good })).status, 200, good);
    const shown = await publicId();
    assert.equal(shown.trailerId, 'dQw4w9WgXcQ', good);
    assert.ok(!('trailerUrl' in shown), 'the public response carries only the id');
  }

  for (const bad of [
    'https://vimeo.com/123456789',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/watch',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://evil.example/https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'dQw4w9WgXcQ',
    42,
  ]) {
    const res = await patch({ trailerUrl: bad });
    assert.equal(res.status, 400, String(bad));
    assert.ok(res.data.errors.trailerUrl, `${bad}: the error names trailerUrl`);
  }
  assert.equal((await publicId()).trailerId, 'dQw4w9WgXcQ', 'rejected links changed nothing');

  assert.equal((await patch({ trailerUrl: '   ' })).status, 200, 'blank clears it');
  assert.equal((await publicId()).trailerId, null);
  const adminView = await call('GET', '/api/admin/movies', { session: admin });
  assert.ok(!('trailerUrl' in adminView.data[0]), 'admins no longer see a link');

  const created = await call('POST', '/api/admin/movies', {
    session: admin,
    body: {
      title: 'With Trailer', synopsis: 'x', genre: 'Drama', rating: 'PG', duration: 90,
      posterUrl: 'https://example.com/p.jpg', releaseDate: '2026-01-01', status: 'published',
      trailerUrl: 'https://youtu.be/dQw4w9WgXcQ',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.trailerUrl, 'https://youtu.be/dQw4w9WgXcQ', 'admins see the link they saved');
});

// ---- auditoriums ---------------------------------------------------------------------------
test('auditoriums: admin only, server generates seats, duplicate names are 409', async () => {
  const user = await signIn('user');
  const admin = await signIn('admin');
  assert.equal((await call('GET', '/api/auditoriums')).status, 401);
  assert.equal((await call('GET', '/api/auditoriums', { session: user })).status, 403);

  const made = await call('POST', '/api/auditoriums', {
    body: { name: 'Hall A', rows: 2, seatsPerRow: 3, seatLabels: ['HACK'] }, session: admin,
  });
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.seatLabels, ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal((await call('POST', '/api/auditoriums', { body: { name: 'Hall A', rows: 1, seatsPerRow: 1 }, session: admin })).status, 409);
  assert.equal((await call('POST', '/api/auditoriums', { body: { name: 'Big', rows: 99, seatsPerRow: 3 }, session: admin })).status, 400);
  assert.equal((await call('GET', '/api/auditoriums', { session: admin })).data.length, 1);
  assert.equal((await call('GET', `/api/auditoriums/${made.data._id}`, { session: admin })).status, 200);
  assert.equal((await call('GET', '/api/auditoriums/nope', { session: admin })).status, 404);
});

test('auditoriums: layout locks once a showtime uses it; rename still works; deactivate and delete are guarded', async () => {
  const movie = addMovie();
  const free = addAuditorium({ name: 'Free' });
  const used = addAuditorium({ name: 'Used' });
  const admin = await signIn('admin');
  const patch = (id, body) => call('PATCH', `/api/auditoriums/${id}`, { body, session: admin });

  const resized = await patch(free._id, { rows: 3, seatsPerRow: 2 });
  assert.equal(resized.status, 200);
  assert.deepEqual(resized.data.seatLabels, ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  assert.equal((await patch(free._id, {})).status, 400);
  assert.equal((await patch(free._id, { isActive: 'no' })).status, 400);

  const upcoming = addShowtime(movie, used, DAY);
  assert.equal((await patch(used._id, { rows: 5 })).status, 409, 'layout locked');
  assert.equal((await patch(used._id, { rows: 2 })).status, 200, 'same layout is not a change');
  assert.equal((await patch(used._id, { name: 'Renamed' })).status, 200);
  assert.equal((await patch(used._id, { isActive: false })).status, 409, 'upcoming showtime blocks deactivation');
  assert.equal((await call('DELETE', `/api/auditoriums/${used._id}`, { session: admin })).status, 409);

  upcoming.status = 'cancelled';
  assert.equal((await patch(used._id, { isActive: false })).status, 200);
  assert.equal((await patch(used._id, { rows: 5 })).status, 409, 'still locked: the showtime is history');
  assert.equal((await call('DELETE', `/api/auditoriums/${free._id}`, { session: admin })).status, 200);
});

// ---- creating showtimes --------------------------------------------------------------------
test('create showtime: computes the end, checks references, price and the future', async () => {
  const movie = addMovie({ duration: 90 });
  const hall = addAuditorium();
  const user = await signIn('user');
  const admin = await signIn('admin');
  const body = { movie: String(movie._id), auditorium: String(hall._id), startTime: at(DAY), ticketPrice: 45000 };

  assert.equal((await call('POST', '/api/showtimes', { body })).status, 401);
  assert.equal((await call('POST', '/api/showtimes', { body, session: user })).status, 403);

  const created = await call('POST', '/api/showtimes', { body, session: admin });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(new Date(created.data.endTime) - new Date(created.data.startTime), 90 * 60 * 1000);
  assert.equal(created.data.status, 'scheduled');
  assert.equal(created.data.ticketPrice, 45000);

  const draft = addMovie({ title: 'Draft', status: 'draft' });
  const off = addAuditorium({ isActive: false });
  const cases = [
    [{ ...body, startTime: at(-HOUR) }, 'startTime', 'past'],
    [{ ...body, startTime: 'soon' }, 'startTime', 'not a date'],
    [{ ...body, ticketPrice: 400.5 }, 'ticketPrice', 'fraction'],
    [{ ...body, ticketPrice: '400' }, 'ticketPrice', 'text'],
    [{ ...body, ticketPrice: -1 }, 'ticketPrice', 'negative'],
    [{ ...body, movie: 'x' }, 'movie', 'bad movie id'],
    [{ ...body, movie: '0'.repeat(24) }, 'movie', 'unknown movie'],
    [{ ...body, movie: String(draft._id) }, 'movie', 'draft movie'],
    [{ ...body, auditorium: '0'.repeat(24) }, 'auditorium', 'unknown auditorium'],
    [{ ...body, auditorium: String(off._id), startTime: at(3 * DAY) }, 'auditorium', 'inactive auditorium'],
  ];
  for (const [payload, field, label] of cases) {
    const res = await call('POST', '/api/showtimes', { body: payload, session: admin });
    assert.equal(res.status, 400, label);
    assert.ok(res.data.errors[field], `${label}: error names ${field}`);
  }
  assert.equal(showtimes.length, 1, 'nothing was created by the rejected requests');
});

test('create showtime: overlaps are 409, back-to-back and other rooms are fine (no turnaround set)', async () => {
  const movie = addMovie({ duration: 120 });
  const hallA = addAuditorium();
  const hallB = addAuditorium();
  const admin = await signIn('admin');
  assert.equal((await call('PATCH', '/api/admin/settings', { body: { turnaroundMinutes: 0 }, session: admin })).status, 200);
  const make = (hall, offset) => call('POST', '/api/showtimes', {
    body: { movie: String(movie._id), auditorium: String(hall._id), startTime: at(offset), ticketPrice: 40000 }, session: admin,
  });

  assert.equal((await make(hallA, DAY)).status, 201);
  assert.equal((await make(hallA, DAY + HOUR)).status, 409, 'starts inside');
  assert.equal((await make(hallA, DAY - HOUR)).status, 409, 'ends inside');
  assert.equal((await make(hallA, DAY)).status, 409, 'identical');
  assert.equal((await make(hallA, DAY + 2 * HOUR)).status, 201, 'back-to-back is allowed');
  assert.equal((await make(hallA, DAY - 2 * HOUR)).status, 201, 'ending exactly when the next starts is allowed');
  assert.equal((await make(hallB, DAY)).status, 201, 'another auditorium is independent');

  showtimes.find((s) => String(s.auditorium) === String(hallB._id)).status = 'cancelled';
  assert.equal((await make(hallB, DAY)).status, 201, 'a cancelled showtime frees the slot');
});

test('create showtime: a transaction retry re-checks overlap and loses to the earlier winner', async () => {
  const movie = addMovie({ duration: 60 });
  const hall = addAuditorium();
  const admin = await signIn('admin');
  const startTime = at(DAY);

  // Attempt 1 hits a "write conflict" while another admin's identical showtime commits.
  transactionHook = (attempt) => {
    if (attempt !== 1) return false;
    addShowtime(movie, hall, DAY);
    return true;
  };
  const res = await call('POST', '/api/showtimes', {
    body: { movie: String(movie._id), auditorium: String(hall._id), startTime, ticketPrice: 40000 }, session: admin,
  });
  assert.equal(res.status, 409);
  assert.equal(showtimes.length, 1, 'only the winner exists');
});

// ---- editing, cancelling and deleting showtimes --------------------------------------------
test('edit showtime: allowed before the first booking, blocked after, overlap re-checked', async () => {
  const movie = addMovie({ duration: 120 });
  const longMovie = addMovie({ title: 'Long', duration: 180 });
  const hall = addAuditorium();
  const admin = await signIn('admin');
  const patch = (id, body) => call('PATCH', `/api/showtimes/${id}`, { body, session: admin });

  const mine = addShowtime(movie, hall, DAY);
  const next = addShowtime(movie, hall, DAY + 4 * HOUR);

  assert.equal((await patch(mine._id, {})).status, 400);
  assert.equal((await patch(mine._id, { startTime: at(-HOUR) })).status, 400);
  assert.equal((await patch('nope', { ticketPrice: 1 })).status, 404);

  const moved = await patch(mine._id, { startTime: at(DAY + 30 * 60 * 1000), ticketPrice: 50000 });
  assert.equal(moved.status, 200, 'overlapping only itself is fine');
  assert.equal(moved.data.ticketPrice, 50000);

  assert.equal((await patch(mine._id, { startTime: at(DAY + 3 * HOUR) })).status, 409, 'now collides with the next one');
  assert.equal((await patch(mine._id, { movie: String(longMovie._id), startTime: at(DAY + 2 * HOUR) })).status, 409, 'a longer movie reaches the next one');
  const swapped = await patch(next._id, { movie: String(longMovie._id) });
  assert.equal(swapped.status, 200);
  assert.equal(new Date(swapped.data.endTime) - new Date(swapped.data.startTime), 180 * 60 * 1000, 'end follows the movie');

  addBooking(next, { status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await patch(next._id, { ticketPrice: 1 })).status, 409, 'even a cancelled booking locks it');

  mine.status = 'cancelled';
  assert.equal((await patch(mine._id, { ticketPrice: 1 })).status, 409, 'cancelled showtimes are fixed');
  const started = addShowtime(movie, hall, -HOUR);
  assert.equal((await patch(started._id, { ticketPrice: 1 })).status, 409, 'started showtimes are fixed');
});

test('cancel showtime: cancels its bookings and frees seats in one go, and is repeatable', async () => {
  const movie = addMovie();
  const hall = addAuditorium();
  const target = addShowtime(movie, hall, DAY);
  const other = addShowtime(movie, hall, 3 * DAY);
  const b1 = addBooking(target, { seats: ['A1', 'A2'], totalAmount: 80000 });
  const b2 = addBooking(target, { seats: ['B1'], totalAmount: 40000 });
  const old = addBooking(target, { status: 'cancelled', cancelledAt: new Date(Date.now() - DAY), seats: ['B2'] });
  const unrelated = addBooking(other, { seats: ['A1'] });
  [['A1', b1], ['A2', b1], ['B1', b2]].forEach(([seat, booking]) => addClaim(target, seat, booking));
  addClaim(other, 'A1', unrelated);
  const user = await signIn('user');
  const admin = await signIn('admin');
  const cancel = (id, session) => call('PATCH', `/api/showtimes/${id}/cancel`, { session });

  assert.equal((await cancel(target._id)).status, 401);
  assert.equal((await cancel(target._id, user)).status, 403);
  const done = await cancel(target._id, admin);
  assert.equal(done.status, 200);
  assert.equal(done.data.cancelledBookings, 2);
  assert.equal(done.data.showtime.status, 'cancelled');
  assert.deepEqual([b1.status, b2.status, old.status, unrelated.status], ['cancelled', 'cancelled', 'cancelled', 'confirmed']);
  assert.ok(b1.cancelledAt instanceof Date);
  assert.deepEqual(claims.map((c) => String(c.showtime)), [String(other._id)], 'only the other showtime keeps its seats');

  const again = await cancel(target._id, admin);
  assert.equal(again.status, 200, 'repeating is harmless');
  assert.equal(again.data.cancelledBookings, 0);
  assert.equal((await cancel('nope', admin)).status, 404);
  assert.equal((await cancel(addShowtime(movie, hall, -HOUR)._id, admin)).status, 409, 'a started showtime cannot be cancelled');
});

test('delete showtime: refused once it has any booking history', async () => {
  const movie = addMovie();
  const hall = addAuditorium();
  const clean = addShowtime(movie, hall, DAY);
  const busy = addShowtime(movie, hall, 3 * DAY);
  addBooking(busy, { status: 'cancelled', cancelledAt: new Date() });
  const admin = await signIn('admin');

  assert.equal((await call('DELETE', `/api/showtimes/${busy._id}`)).status, 401);
  assert.equal((await call('DELETE', `/api/showtimes/${busy._id}`, { session: admin })).status, 409);
  assert.equal(showtimes.includes(busy), true);
  assert.equal((await call('DELETE', `/api/showtimes/${clean._id}`, { session: admin })).status, 200);
  assert.equal(showtimes.includes(clean), false);
  assert.equal((await call('DELETE', `/api/showtimes/${clean._id}`, { session: admin })).status, 404);
});

// ---- listings and seats --------------------------------------------------------------------
test('public showtimes: future scheduled only, filterable, with remaining seats and no admin fields', async () => {
  const dune = addMovie({ title: 'Dune' });
  const other = addMovie({ title: 'Amelie' });
  const draft = addMovie({ title: 'Draft', status: 'draft' });
  const hall = addAuditorium({ name: 'Hall 1', rows: 2, seatsPerRow: 3 });
  const hall2 = addAuditorium({ name: 'Hall 2' });
  const soon = addShowtime(dune, hall, DAY);
  addShowtime(dune, hall, -DAY);
  addShowtime(dune, hall2, 2 * DAY, { status: 'cancelled' });
  addShowtime(other, hall2, 3 * DAY);
  addShowtime(draft, hall2, 4 * DAY);
  const booking = addBooking(soon, { seats: ['A1', 'A2'] });
  addClaim(soon, 'A1', booking);
  addClaim(soon, 'A2', booking);

  const all = await call('GET', '/api/showtimes');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.map((s) => s.movie.title), ['Dune', 'Amelie'], 'sorted by time; no past, cancelled or draft');
  const first = all.data[0];
  assert.equal(first.auditorium.name, 'Hall 1');
  assert.equal(first.ticketPrice, 40000);
  assert.equal(first.totalSeats, 6);
  assert.equal(first.remainingSeats, 4);
  assert.ok(!('status' in first) && !('seatLabels' in first.auditorium));

  assert.deepEqual((await call('GET', `/api/showtimes?movie=${other._id}`)).data.map((s) => s.movie.title), ['Amelie']);
  const day = new Date(Date.now() + DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const onDay = await call('GET', `/api/showtimes?date=${day}`);
  assert.equal(onDay.data.length >= 1 && onDay.data.every((s) => new Date(s.startTime) > new Date()), true);
  assert.equal(onDay.data.some((s) => s._id === String(soon._id)), true);
  for (const bad of ['date=today', 'date=2026-13-01', 'movie=abc']) {
    assert.equal((await call('GET', `/api/showtimes?${bad}`)).status, 400, bad);
  }
});

test('admin showtimes: every schedule and status, admin only', async () => {
  const movie = addMovie();
  const hall = addAuditorium();
  const hall2 = addAuditorium();
  addShowtime(movie, hall, DAY);
  addShowtime(movie, hall, -DAY);
  addShowtime(movie, hall2, 2 * DAY, { status: 'cancelled' });
  const user = await signIn('user');
  const admin = await signIn('admin');

  assert.equal((await call('GET', '/api/admin/showtimes')).status, 401);
  assert.equal((await call('GET', '/api/admin/showtimes', { session: user })).status, 403);
  const all = await call('GET', '/api/admin/showtimes', { session: admin });
  assert.equal(all.data.length, 3);
  assert.deepEqual(all.data.map((s) => s.status).sort(), ['cancelled', 'scheduled', 'scheduled']);
  assert.equal((await call('GET', '/api/admin/showtimes?status=cancelled', { session: admin })).data.length, 1);
  assert.equal((await call('GET', `/api/admin/showtimes?auditorium=${hall._id}`, { session: admin })).data.length, 2);
  assert.equal((await call('GET', '/api/admin/showtimes?status=weird', { session: admin })).status, 400);
});

test('seat availability: layout minus claims, public, no customer info', async () => {
  const movie = addMovie();
  const hall = addAuditorium({ rows: 2, seatsPerRow: 2 });
  const showtime = addShowtime(movie, hall, DAY);
  const booking = addBooking(showtime, { seats: ['A2', 'B1'], totalAmount: 80000 });
  addClaim(showtime, 'A2', booking);
  addClaim(showtime, 'B1', booking);

  const res = await call('GET', `/api/showtimes/${showtime._id}/seats`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.seats, [
    { label: 'A1', status: 'available' }, { label: 'A2', status: 'booked' },
    { label: 'B1', status: 'booked' }, { label: 'B2', status: 'available' },
  ]);
  assert.equal(res.data.showtime.bookable, true);
  assert.equal(res.data.auditorium.rows, 2);
  assert.ok(!/user|booking|email/i.test(JSON.stringify(res.data)));

  showtime.status = 'cancelled';
  assert.equal((await call('GET', `/api/showtimes/${showtime._id}/seats`)).status, 404);
  assert.equal((await call('GET', '/api/showtimes/nope/seats')).status, 404);
  const hidden = addShowtime(addMovie({ title: 'Hidden', status: 'draft' }), hall, DAY);
  assert.equal((await call('GET', `/api/showtimes/${hidden._id}/seats`)).status, 404);
  const started = addShowtime(movie, hall, -HOUR);
  assert.equal((await call('GET', `/api/showtimes/${started._id}/seats`)).data.showtime.bookable, false);
});
