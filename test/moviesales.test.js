// Offline tests for what each movie has earned: revenue, tickets and refunds on the movie list, the
// movie panel's summary, and the admin bookings list filtered to one movie. They run the real app,
// models and services against the in-memory stand-in in fakeDb.js.
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


const addBooking = (user, showtime, fields = {}) => add(Booking, bookings, {
  bookingCode: `FLM-T${bookings.length}`, user: user._id, showtime: showtime._id, seats: ['A1'], unitPrice: 40000,
  totalAmount: 40000, status: 'confirmed', paymentStatus: 'paid', bookedAt: new Date(), ...fields,
});

function seed() {
  const dune = addMovie({ title: 'Dune' });
  const toy = addMovie({ title: 'Toy Story' });
  const hall = addHall(); // 2 rows x 3 seats = 6
  const hall2 = addHall();
  const past = addShow(dune, hall, soon(-2 * DAY));
  const next = addShow(dune, hall2, soon(2 * DAY));
  const called = addShow(dune, hall, soon(3 * DAY), { status: 'cancelled' });
  const toyShow = addShow(toy, hall2, soon(5 * DAY));
  return { dune, toy, past, next, called, toyShow };
}

test('the movie list carries each movie\'s revenue, tickets and refunds', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const { dune, toy, past, next, called, toyShow } = seed();
  addBooking(ann.user, past, { seats: ['A1', 'A2'], totalAmount: 80000 });
  addBooking(ann.user, next, { seats: ['B1'], totalAmount: 40000 });
  addBooking(bob.user, next, { seats: ['B2', 'B3'], totalAmount: 80000 });
  addBooking(bob.user, called, { status: 'cancelled', paymentStatus: 'refunded', seats: ['A3'], totalAmount: 40000 });
  addBooking(bob.user, next, { status: 'cancelled', paymentStatus: 'unpaid', seats: ['C1'], totalAmount: 40000 });
  addBooking(bob.user, toyShow, { status: 'pending', paymentStatus: 'unpaid', seats: ['A1'], totalAmount: 40000 });

  const list = (await call('GET', '/api/admin/movies', { session: admin })).data;
  const sales = (title) => list.find((movie) => movie.title === title).sales;
  assert.deepEqual(sales('Dune'), { revenue: 200000, tickets: 5, bookings: 3, cancelled: 2, refunded: 40000, customers: 2 });
  assert.deepEqual(sales('Toy Story'), { revenue: 0, tickets: 0, bookings: 0, cancelled: 0, refunded: 0, customers: 0 }, 'an unpaid hold earns nothing');
  assert.ok(dune && toy);
});

test('a movie\'s summary counts its showings and how full they are', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const { dune, past, next } = seed();
  addBooking(ann.user, past, { seats: ['A1', 'A2'], totalAmount: 80000 });
  addBooking(ann.user, next, { seats: ['B1', 'B2', 'B3'], totalAmount: 120000 });

  const { status, data } = await call('GET', `/api/admin/movies/${dune._id}/summary`, { session: admin });
  assert.equal(status, 200);
  assert.deepEqual(data.showings, { total: 3, upcoming: 1, past: 1, cancelled: 1, hidden: 0 });
  assert.equal(data.sales.revenue, 200000);
  assert.equal(data.sales.tickets, 5);
  assert.equal(data.occupancy, 41.7, '5 of the 12 seats across its two scheduled showings');
  assert.equal(new Date(data.nextShowing).getTime(), next.startTime.getTime());

  assert.equal((await call('GET', `/api/admin/movies/${dune._id}/summary`)).status, 401);
  assert.equal((await call('GET', `/api/admin/movies/${dune._id}/summary`, { session: ann })).status, 403);
  assert.equal((await call('GET', '/api/admin/movies/000000000000000000000000/summary', { session: admin })).status, 404);
});

test('the admin bookings list can show one movie\'s bookings only', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const { dune, toy, past, next, toyShow } = seed();
  addBooking(ann.user, past);
  addBooking(ann.user, next, { status: 'cancelled', paymentStatus: 'refunded' });
  addBooking(ann.user, toyShow);

  const duneBookings = (await call('GET', `/api/bookings?movie=${dune._id}`, { session: admin })).data;
  assert.equal(duneBookings.length, 2);
  assert.ok(duneBookings.every((booking) => booking.movie.title === 'Dune'));
  const confirmed = (await call('GET', `/api/bookings?movie=${dune._id}&status=confirmed`, { session: admin })).data;
  assert.equal(confirmed.length, 1);
  assert.equal((await call('GET', `/api/bookings?movie=${toy._id}`, { session: admin })).data.length, 1);
  assert.equal((await call('GET', '/api/bookings?movie=nope', { session: admin })).status, 400);
  assert.equal((await call('GET', `/api/bookings?movie=${dune._id}`, { session: ann })).status, 403);
});
