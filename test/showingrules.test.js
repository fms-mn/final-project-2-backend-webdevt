// Offline tests for the gaps found by a full review of the showing and booking workflow: a hidden
// or cancelled showing cannot be paid for, the publish rule matches what customers can book, a
// movie with coming showings cannot be archived, the public list pages correctly, a hold that ran
// out does not lock a showing, and a move to another room drops seats that room does not have.
// They run the real app, models and services against the in-memory stand-in in fakeDb.js.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.BOOKING_RETRY_PAUSE_MS = '1';
process.env.PAYMENT_REQUIRED = 'true'; process.env.PAYMENT_DELAY_MS = '0'; // these tests are about movies and showings (see payments.test.js)

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
const { manilaDay } = require('../utils/manila');
const { fakeModel, fakeTransactions } = require('./fakeDb');

const PASSWORD = 'correct-horse-1';
const COOKIE = 'filme_session';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

const clear = () => [users, movies, auditoriums, showtimes, bookings, claims, settings, payments].forEach((rows) => { rows.length = 0; });
const day = (n) => manilaDay(Date.now() + n * DAY); // a Manila calendar day, n days from today

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
const addHall = (fields = {}) => {
  const layout = { rows: 2, seatsPerRow: 3, ...fields };
  return add(Auditorium, auditoriums, {
    name: `Hall ${auditoriums.length + 1}`, ...layout, seatLabels: Auditorium.generateSeatLabels(layout.rows, layout.seatsPerRow),
  });
};
const addShow = (movie, hall, startTime, fields = {}) => add(Showtime, showtimes, {
  movie: movie._id, auditorium: hall._id, startTime,
  endTime: Showtime.computeEndTime(startTime, movie.duration), ticketPrice: 40000, ...fields,
});
const soon = (ms) => new Date(Date.now() + ms);

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
  if (!users.find((u) => u.email === email)) add(User, users, { name, email, passwordHash, role });
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await response.json();
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE}=`));
  return { cookie, csrf: data.csrfToken, user: users.find((u) => u.email === email) };
}

const book = (session, showtime, seats) => call('POST', '/api/bookings', { session, body: { showtime: String(showtime._id), seats } });

test.before(async () => {
  passwordHash = await User.hashPassword(PASSWORD);
  fakeModel(User, users);
  fakeModel(Movie, movies);
  fakeModel(Auditorium, auditoriums, { uniqueOn: 'name' });
  fakeModel(Showtime, showtimes);
  fakeModel(Booking, bookings, { uniqueOn: 'bookingCode' });
  fakeModel(SeatClaim, claims, { uniqueOn: ['showtime', 'seatLabel'] });
  fakeModel(Payment, payments, { uniqueOn: 'reference' });
  fakeModel(Setting, settings, { uniqueOn: 'key' });
  fakeModel(LoginAttempt, [], { uniqueOn: 'key' });
  fakeTransactions({
    stores: [bookings, claims, showtimes, auditoriums, settings, payments],
  });
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(clear);

const setStatus = (admin, movie, status, extra = {}) => call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { status, ...extra } });
const pay = (s, b) => call('POST', `/api/bookings/${b._id}/pay`, { session: s, body: { method: 'card', number: '4242424242424242', expiry: '12/30', cvc: '123' } });


test('a hold cannot be paid after its showing was hidden, and the attempt is closed', async () => {
  const admin = await signIn('boss', 'admin');
  const cust = await signIn('cust');
  const show = addShow(addMovie(), addHall(), soon(2 * DAY));
  const held = await book(cust, show, ['A1']);
  assert.equal(held.status, 201);
  assert.equal((await call('PATCH', `/api/showtimes/${show._id}/visibility`, { session: admin, body: { published: false } })).status, 200);

  const paid = await pay(cust, held.data);
  assert.equal(paid.status, 409);
  assert.match(paid.data.message, /no longer available/);
  assert.equal(bookings[0].status, 'pending', 'no ticket for a showing customers cannot see');
  assert.equal(payments[0].status, 'failed', 'the refused attempt is not left open');
});

test('publishing counts only showings customers can still book (the sales cutoff applies)', async () => {
  const admin = await signIn('boss', 'admin');
  const movie = addMovie({ status: 'draft' });
  const hall = addHall();
  addShow(movie, hall, soon(5 * MIN)); // online sales closed 15 minutes before
  assert.equal((await setStatus(admin, movie, 'published')).status, 409);
  addShow(movie, hall, soon(DAY));
  assert.equal((await setStatus(admin, movie, 'published')).status, 200);
});

test('a draft movie with coming showings cannot be archived (they would still hold the room)', async () => {
  const admin = await signIn('boss', 'admin');
  const movie = addMovie({ status: 'draft' });
  addShow(movie, addHall(), soon(2 * DAY));
  const res = await setStatus(admin, movie, 'archived');
  assert.equal(res.status, 409);
  assert.equal(movies[0].status, 'draft');
  assert.equal((await setStatus(admin, addMovie({ status: 'draft', title: 'Empty' }), 'archived')).status, 200);
});

test('moving a published movie\'s release date into the past needs a bookable showing', async () => {
  const admin = await signIn('boss', 'admin');
  const movie = addMovie({ releaseDate: new Date(Date.now() + 10 * DAY) }); // coming soon, no showings
  const res = await call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { releaseDate: day(-1) } });
  assert.equal(res.status, 409);
  assert.match(res.data.message, /Schedule at least one showing/);
  const later = await call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { releaseDate: day(20) } });
  assert.equal(later.status, 200, 'still coming soon is fine');
});

test('the public showtime list leaves out unpublished movies before paging', async () => {
  const draft = addMovie({ status: 'draft', title: 'Draft' });
  const live = addMovie({ title: 'Live' });
  addShow(draft, addHall(), soon(DAY));
  addShow(live, addHall(), soon(DAY + HOUR));
  addShow(live, addHall(), soon(DAY + 2 * HOUR));
  const first = await call('GET', '/api/showtimes?limit=2&page=1');
  assert.equal(first.data.length, 2, 'a full page while more showings exist');
  assert.equal((await call('GET', '/api/showtimes?limit=2&page=2')).data.length, 0);
  assert.deepEqual((await call('GET', `/api/showtimes?movie=${draft._id}`)).data, []);
  assert.equal((await call('GET', `/api/showtimes?movie=${live._id}`)).data.length, 2);
});

test('a hold that was let go or ran out does not lock the showing against edits', async () => {
  const admin = await signIn('boss', 'admin');
  const cust = await signIn('cust');
  const show = addShow(addMovie(), addHall(), soon(2 * DAY));
  const first = await book(cust, show, ['A1']);
  assert.equal((await call('POST', `/api/bookings/${first.data._id}/release`, { session: cust })).status, 200);
  assert.equal((await call('PATCH', `/api/showtimes/${show._id}`, { session: admin, body: { ticketPrice: 45000 } })).status, 200);

  await book(cust, show, ['A2']);
  bookings.find((b) => b.status === 'pending').holdExpiresAt = new Date(Date.now() - 1000); // time ran out
  assert.equal((await call('PATCH', `/api/showtimes/${show._id}`, { session: admin, body: { ticketPrice: 46000 } })).status, 200);

  const live = await book(cust, show, ['A3']);
  assert.equal(live.status, 201);
  assert.equal((await call('PATCH', `/api/showtimes/${show._id}`, { session: admin, body: { ticketPrice: 47000 } })).status, 409, 'a live hold still locks it');
});

test('moving a showing to a smaller room drops blocked seats that room does not have', async () => {
  const admin = await signIn('boss', 'admin');
  const big = addHall({ rows: 3, seatsPerRow: 4 });
  const small = addHall({ rows: 2, seatsPerRow: 3 });
  const show = addShow(addMovie(), big, soon(2 * DAY));
  assert.equal((await call('PUT', `/api/showtimes/${show._id}/blocked-seats`, { session: admin, body: { seats: ['A1', 'C4'] } })).status, 200);
  const moved = await call('PATCH', `/api/showtimes/${show._id}/reschedule`, { session: admin, body: { auditorium: String(small._id) } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.deepEqual(showtimes[0].blockedSeats, ['A1']);
  assert.equal((await call('PUT', `/api/showtimes/${show._id}/blocked-seats`, { session: admin, body: { seats: ['A1', 'B2'] } })).status, 200);
});
