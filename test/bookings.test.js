// Offline tests for the booking engine (Trello list 4). They run the real app, models and
// services against the in-memory stand-in in fakeDb.js, which can roll a transaction back. The
// real concurrency behaviour (two requests at once, MongoDB write conflicts) is proven on the
// real database by `npm run concurrency`.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.BOOKING_RETRY_PAUSE_MS = '1';
process.env.PAYMENT_REQUIRED = 'false'; // these tests are about seats, not payments (see payments.test.js)

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const Payment = require('../models/Payment');
const Setting = require('../models/Setting');
const LoginAttempt = require('../models/LoginAttempt');
const { fakeModel, fakeTransactions } = require('./fakeDb');

const PASSWORD = 'correct-horse-1';
const COOKIE = 'filme_session';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.now();

const users = [];
const movies = [];
const auditoriums = [];
const showtimes = [];
const bookings = [];
const claims = [];
const payments = [];
const settings = [];
let server;
let base;
let passwordHash;
let hooks = {};

const clear = () => [users, movies, auditoriums, showtimes, bookings, claims, settings, payments].forEach((rows) => { rows.length = 0; });

function add(Model, rows, fields) {
  const doc = new Model(fields);
  doc.$isNew = false;
  rows.push(doc);
  return doc;
}
const addMovie = () => add(Movie, movies, {
  title: 'Dune', synopsis: 'Sand.', genre: 'Sci-Fi', rating: 'PG-13', duration: 120,
  posterUrl: 'https://example.com/dune.jpg', releaseDate: new Date('2026-01-01'), status: 'published',
});
const addHall = (name = 'Hall 1') => add(Auditorium, auditoriums, {
  name, rows: 2, seatsPerRow: 3, seatLabels: Auditorium.generateSeatLabels(2, 3),
});
const addShowtime = (movie, hall, startOffset, fields = {}) => {
  const startTime = new Date(T0 + startOffset);
  return add(Showtime, showtimes, {
    movie: movie._id, auditorium: hall._id, startTime,
    endTime: Showtime.computeEndTime(startTime, movie.duration), ticketPrice: 40000, ...fields,
  });
};
function world() {
  const movie = addMovie();
  const hall = addHall();
  return { movie, hall, showtime: addShowtime(movie, hall, DAY) };
}

async function call(method, path, { body, session } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) { headers.Cookie = session.cookie; headers['X-CSRF-Token'] = session.csrf; }
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch { /* no body */ }
  return { status: response.status, data };
}

async function signIn(name, role = 'user') {
  const email = `${name}@example.com`;
  let user = users.find((u) => u.email === email);
  if (!user) {
    user = new User({ name, email, passwordHash, role });
    user.$isNew = false;
    users.push(user);
  }
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await response.json();
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE}=`));
  return { cookie, csrf: data.csrfToken, user };
}

const book = (session, showtime, seats, extra = {}) => call('POST', '/api/bookings', {
  session, body: { showtime: String(showtime._id), seats, ...extra },
});

test.before(async () => {
  passwordHash = await User.hashPassword(PASSWORD);
  fakeModel(User, users);
  fakeModel(Movie, movies);
  fakeModel(Auditorium, auditoriums);
  fakeModel(Showtime, showtimes);
  fakeModel(Booking, bookings, { uniqueOn: 'bookingCode' });
  fakeModel(SeatClaim, claims, { uniqueOn: ['showtime', 'seatLabel'] });
  fakeModel(Payment, payments, { uniqueOn: 'reference' });
  fakeModel(Setting, settings, { uniqueOn: 'key' });
  fakeModel(LoginAttempt, [], { uniqueOn: 'key' });
  fakeTransactions({
    stores: [bookings, claims, showtimes, auditoriums, payments],
    beforeAttempt: (attempt) => (hooks.beforeAttempt ? hooks.beforeAttempt(attempt) : false),
    transient: (attempt) => (hooks.transient ? hooks.transient(attempt) : false),
  });
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { clear(); hooks = {}; });

// ---- creating a booking --------------------------------------------------------------------
test('book: the server sets owner, price, total and code; forged fields are ignored', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');
  const other = await signIn('bob');

  assert.equal((await call('POST', '/api/bookings', { body: { showtime: String(showtime._id), seats: ['A1'] } })).status, 401);

  const res = await book(ann, showtime, ['a1', ' B2 '], {
    user: String(other.user._id), unitPrice: 1, totalAmount: 1, status: 'cancelled',
    bookingCode: 'FLM-HACKED00', bookedAt: '2000-01-01', cancelledAt: '2000-01-01',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.deepEqual(res.data.seats, ['A1', 'B2'], 'labels are tidied');
  assert.equal(res.data.unitPrice, 40000, 'price comes from the showtime');
  assert.equal(res.data.totalAmount, 80000);
  assert.equal(res.data.status, 'confirmed');
  assert.match(res.data.bookingCode, /^FLM-[A-Z2-9]{8}$/);
  assert.notEqual(res.data.bookingCode, 'FLM-HACKED00');
  assert.equal(res.data.cancelledAt, null);
  assert.equal(res.data.movie.title, 'Dune');
  assert.equal(res.data.auditorium.name, 'Hall 1');
  assert.ok(!('user' in res.data), 'a customer response carries no user record');

  assert.equal(bookings.length, 1);
  assert.equal(String(bookings[0].user), String(ann.user._id), 'the owner is the signed-in user');
  assert.deepEqual(claims.map((c) => c.seatLabel).sort(), ['A1', 'B2']);
  assert.ok(claims.every((c) => String(c.booking) === String(bookings[0]._id)));
  assert.equal(showtime.bookingRevision, 1, 'the showtime was written, so competing changes conflict');
});

test('book: bad input is 400, missing showtime 404, cancelled or started showtime 409', async () => {
  const { movie, hall, showtime } = world();
  const ann = await signIn('ann');
  const id = String(showtime._id);
  const cases = [
    [{ showtime: 'nope', seats: ['A1'] }, 'showtime', 'bad showtime id'],
    [{ showtime: id }, 'seats', 'no seats'],
    [{ showtime: id, seats: [] }, 'seats', 'empty seats'],
    [{ showtime: id, seats: 'A1' }, 'seats', 'seats not a list'],
    [{ showtime: id, seats: ['A1', 5] }, 'seats', 'seat not text'],
    [{ showtime: id, seats: ['A1', 'a1'] }, 'seats', 'duplicate seat'],
    [{ showtime: id, seats: Array.from({ length: 11 }, (_, i) => `A${i + 1}`) }, 'seats', 'too many seats'],
    [{ showtime: id, seats: ['A1', 'Z9', 'A9'] }, 'seats', 'seat outside the auditorium'],
  ];
  for (const [body, field, label] of cases) {
    const res = await call('POST', '/api/bookings', { session: ann, body });
    assert.equal(res.status, 400, label);
    assert.ok(res.data.errors[field], `${label}: error names ${field}`);
  }
  const outside = await call('POST', '/api/bookings', { session: ann, body: { showtime: id, seats: ['A1', 'Z9'] } });
  assert.match(outside.data.errors.seats, /Z9/);
  assert.equal((await call('POST', '/api/bookings', { session: ann, body: { showtime: '0'.repeat(24), seats: ['A1'] } })).status, 404);

  showtime.status = 'cancelled';
  assert.equal((await book(ann, showtime, ['A1'])).status, 409, 'cancelled');
  const started = addShowtime(movie, hall, -HOUR);
  assert.equal((await book(ann, started, ['A1'])).status, 409, 'started');
  assert.equal(bookings.length, 0);
  assert.equal(claims.length, 0);
});

test('book: a taken seat is 409, and a multi-seat booking leaves no partial booking or claims', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');
  const bob = await signIn('bob');

  assert.equal((await book(ann, showtime, ['A1'])).status, 201);
  assert.equal((await book(bob, showtime, ['A1'])).status, 409, 'same seat');

  const partial = await book(bob, showtime, ['A2', 'A1', 'A3']);
  assert.equal(partial.status, 409);
  assert.match(partial.data.message, /refresh/i);
  assert.equal(bookings.length, 1, 'only Ann has a booking');
  assert.deepEqual(claims.map((c) => c.seatLabel), ['A1'], 'no claims for A2 or A3 were left behind');

  assert.equal((await book(bob, showtime, ['A2', 'A3'])).status, 201, 'the free seats are still bookable');
});

test('book: two requests for the same seat at once - exactly one wins', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const answers = await Promise.all([book(ann, showtime, ['B1']), book(bob, showtime, ['B1'])]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [201, 409]);
  assert.equal(bookings.length, 1);
  assert.equal(claims.length, 1);
});

test('book: the price is a snapshot; a later price change does not touch the booking', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');
  const made = await book(ann, showtime, ['A1', 'A2']);
  showtime.ticketPrice = 99900;
  const again = await call('GET', `/api/bookings/${made.data._id}`, { session: ann });
  assert.equal(again.data.unitPrice, 40000);
  assert.equal(again.data.totalAmount, 80000);
  assert.equal((await book(ann, showtime, ['B1'])).data.unitPrice, 99900, 'new bookings use the current price');
});

test('book: a transient conflict re-runs the transaction with fresh validation, within a limit', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');

  // The first attempt hits a write conflict after running; the retry succeeds, once.
  hooks.transient = (attempt) => attempt === 1;
  assert.equal((await book(ann, showtime, ['A1'])).status, 201);
  assert.equal(bookings.length, 1);
  assert.equal(claims.length, 1, 'the abandoned first attempt left nothing behind');

  // Before the retry runs, an admin cancels the showtime: the retry must notice.
  hooks = {
    beforeAttempt: (attempt) => {
      if (attempt !== 1) return false;
      showtime.status = 'cancelled';
      return true;
    },
  };
  assert.equal((await book(ann, showtime, ['A2'])).status, 409, 'fresh validation saw the cancellation');

  // A conflict that never clears gives up instead of looping forever.
  showtime.status = 'scheduled';
  hooks = { transient: () => true };
  const busy = await book(ann, showtime, ['B1']);
  assert.equal(busy.status, 503);
  assert.equal(bookings.length, 1);
  assert.equal(claims.length, 1);
});

// ---- reading bookings ----------------------------------------------------------------------
test('my bookings: only the signed-in customer\'s, newest first, cancelled ones kept', async () => {
  const { movie, hall, showtime } = world();
  const later = addShowtime(movie, hall, 3 * DAY);
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const first = await book(ann, showtime, ['A1']);
  await book(bob, showtime, ['B1']);
  const second = await book(ann, later, ['A1', 'A2']);
  bookings.find((b) => String(b._id) === first.data._id).bookedAt = new Date(T0 - HOUR); // make the order certain
  await call('PATCH', `/api/bookings/${first.data._id}/cancel`, { session: ann });

  assert.equal((await call('GET', '/api/bookings/my')).status, 401);
  const mine = await call('GET', '/api/bookings/my', { session: ann });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.map((b) => b._id), [second.data._id, first.data._id], 'newest first');
  assert.deepEqual(mine.data.map((b) => b.status), ['confirmed', 'cancelled']);
  assert.ok(!JSON.stringify(mine.data).includes('bob@example.com'));
  assert.deepEqual((await call('GET', '/api/bookings/my?status=cancelled', { session: ann })).data.map((b) => b._id), [first.data._id]);
  assert.equal((await call('GET', '/api/bookings/my?status=weird', { session: ann })).status, 400);
  assert.equal((await call('GET', '/api/bookings/my', { session: bob })).data.length, 1);
});

test('one booking: its owner and admins may read it, everyone else gets 404', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const boss = await signIn('boss', 'admin');
  const made = await book(ann, showtime, ['A1']);
  const url = `/api/bookings/${made.data._id}`;

  assert.equal((await call('GET', url)).status, 401);
  assert.equal((await call('GET', url, { session: ann })).status, 200);
  const asAdmin = await call('GET', url, { session: boss });
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.data.user.email, 'ann@example.com', 'admins also see the customer');
  assert.equal((await call('GET', url, { session: bob })).status, 404, 'another customer learns nothing');
  assert.equal((await call('GET', `/api/bookings/${'0'.repeat(24)}`, { session: ann })).status, 404);
  assert.equal((await call('GET', '/api/bookings/not-an-id', { session: ann })).status, 404);
});

test('admin list: every booking with its customer, filtered and paged; customers are refused', async () => {
  const { movie, hall, showtime } = world();
  const later = addShowtime(movie, hall, 4 * DAY);
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const boss = await signIn('boss', 'admin');
  const a = await book(ann, showtime, ['A1']);
  await book(bob, later, ['A1']);
  await call('PATCH', `/api/bookings/${a.data._id}/cancel`, { session: ann });

  assert.equal((await call('GET', '/api/bookings')).status, 401);
  assert.equal((await call('GET', '/api/bookings', { session: ann })).status, 403);
  const all = await call('GET', '/api/bookings', { session: boss });
  assert.equal(all.data.length, 2);
  assert.deepEqual(all.data.map((b) => b.user.email).sort(), ['ann@example.com', 'bob@example.com']);
  assert.ok(!JSON.stringify(all.data).includes('passwordHash'));
  assert.equal((await call('GET', '/api/bookings?status=cancelled', { session: boss })).data.length, 1);
  assert.equal((await call('GET', `/api/bookings?showtime=${later._id}`, { session: boss })).data.length, 1);
  const day = new Date(later.startTime).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  assert.equal((await call('GET', `/api/bookings?date=${day}`, { session: boss })).data.length, 1);
  assert.equal((await call('GET', '/api/bookings?limit=1&page=2', { session: boss })).data.length, 1);
  for (const bad of ['status=x', 'showtime=nope', 'date=today']) {
    assert.equal((await call('GET', `/api/bookings?${bad}`, { session: boss })).status, 400, bad);
  }
});

// ---- cancelling ----------------------------------------------------------------------------
test('cancel: marks the booking cancelled and frees its seats in one go; repeating is harmless', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const made = await book(ann, showtime, ['A1', 'A2']);
  const url = `/api/bookings/${made.data._id}/cancel`;

  assert.equal((await call('PATCH', url)).status, 401);
  assert.equal((await call('PATCH', url, { session: bob })).status, 404, 'not someone else\'s');
  assert.equal(bookings[0].status, 'confirmed');

  const done = await call('PATCH', url, { session: ann });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'cancelled');
  assert.ok(done.data.cancelledAt);
  assert.equal(claims.length, 0, 'the seats are free again');

  const again = await call('PATCH', url, { session: ann });
  assert.equal(again.status, 200);
  assert.equal(again.data.cancelledAt, done.data.cancelledAt, 'a repeat changes nothing');

  assert.equal((await book(bob, showtime, ['A1', 'A2'])).status, 201, 'the freed seats can be booked');
  assert.equal(bookings.length, 2, 'the cancelled booking is kept');
});

test('cancel: an admin may cancel anyone\'s booking; nobody after the showtime has started', async () => {
  const { showtime } = world();
  const ann = await signIn('ann');
  const boss = await signIn('boss', 'admin');
  const made = await book(ann, showtime, ['A1']);
  const viaAdmin = await call('PATCH', `/api/bookings/${made.data._id}/cancel`, { session: boss });
  assert.equal(viaAdmin.status, 200);
  assert.equal(viaAdmin.data.status, 'cancelled');

  // The clock moves past the showtime's start: both roles are refused and nothing changes.
  const live = await book(ann, showtime, ['B1']);
  showtime.startTime = new Date(Date.now() - HOUR);
  for (const session of [ann, boss]) {
    const late = await call('PATCH', `/api/bookings/${live.data._id}/cancel`, { session });
    assert.equal(late.status, 409);
  }
  assert.equal(bookings.find((b) => String(b._id) === live.data._id).status, 'confirmed');
  assert.equal(claims.length, 1, 'the late cancellation freed nothing');
  assert.equal((await call('PATCH', '/api/bookings/nope/cancel', { session: ann })).status, 404);
});
