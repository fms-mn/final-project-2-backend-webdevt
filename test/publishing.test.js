// Offline tests for when a movie may go live: a released movie needs a showing customers can book,
// a coming-soon movie does not, and showings can be scheduled while the movie is still a draft
// (customers cannot see them until it is published). They run the real app, models and services
// against the in-memory stand-in in fakeDb.js.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.BOOKING_RETRY_PAUSE_MS = '1';
process.env.PAYMENT_REQUIRED = 'false'; // these tests are about movies and showings (see payments.test.js)

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
const { atManila, manilaClock, manilaDay } = require('../utils/manila');
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
let transactionHook = null;

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
const setRules = (admin, body) => call('PATCH', '/api/admin/settings', { body, session: admin });

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
    beforeAttempt: (attempt) => (transactionHook ? transactionHook(attempt) : false),
  });
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { clear(); transactionHook = null; });



const iso = (n, clock = '18:00') => atManila(day(n), clock);
const payload = (fields = {}) => ({
  title: 'New Film', synopsis: 'x', genre: 'Drama', rating: 'PG', duration: 100,
  posterUrl: 'https://example.com/p.jpg', releaseDate: day(-10), status: 'draft', ...fields,
});
const create = (admin, fields) => call('POST', '/api/admin/movies', { session: admin, body: payload(fields) });
const setStatus = (admin, movie, status, extra = {}) => call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { status, ...extra } });
const schedule = (admin, movie, hall, n = 3) => call('POST', '/api/showtimes', {
  session: admin, body: { movie: String(movie._id), auditorium: String(hall._id), startTime: iso(n).toISOString(), ticketPrice: 40000 },
});

test('a released movie cannot be created as published: it would say "No showings"', async () => {
  const admin = await signIn('boss', 'admin');
  const refused = await create(admin, { status: 'published' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.message, /already released.*Schedule at least one showing/);
  assert.equal(movies.length, 0, 'nothing was saved');
  assert.equal((await create(admin, { status: 'draft' })).status, 201, 'a draft is always fine');
  assert.equal((await create(admin, { title: 'Soon', status: 'published', releaseDate: day(10) })).status, 201, 'coming soon may be published without showings');
});

test('a bad request is still a 400, not a publishing error', async () => {
  const admin = await signIn('boss', 'admin');
  const bad = await create(admin, { status: 'published', title: '' });
  assert.equal(bad.status, 400);
});

test('publishing a released draft needs a showing customers can book', async () => {
  const admin = await signIn('boss', 'admin');
  const hall = addHall();
  const movie = addMovie({ status: 'draft', releaseDate: new Date(`${day(-10)}T00:00:00Z`) });

  assert.equal((await setStatus(admin, movie, 'published')).status, 409, 'no showings at all');
  assert.equal(movie.status, 'draft');

  addShow(movie, hall, soon(-2 * DAY));                                    // already over
  addShow(movie, hall, soon(3 * DAY), { status: 'cancelled' });            // never happened
  addShow(movie, hall, soon(4 * DAY), { isPublished: false });             // hidden from customers
  assert.equal((await setStatus(admin, movie, 'published')).status, 409, 'past, cancelled and hidden showings do not count');

  addShow(movie, hall, soon(5 * DAY));
  const done = await setStatus(admin, movie, 'published');
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(movie.status, 'published');
});

test('a coming-soon movie can be published without showings, and the release date is judged as sent', async () => {
  const admin = await signIn('boss', 'admin');
  const soonMovie = addMovie({ status: 'draft', releaseDate: new Date(`${day(20)}T00:00:00Z`) });
  assert.equal((await setStatus(admin, soonMovie, 'published')).status, 200, 'coming soon');

  const draft = addMovie({ title: 'Other', status: 'draft', releaseDate: new Date(`${day(20)}T00:00:00Z`) });
  const both = await setStatus(admin, draft, 'published', { releaseDate: day(-1) });
  assert.equal(both.status, 409, 'moving the release date into the past in the same request makes it a released movie');
  assert.equal(draft.status, 'draft');
});

test('showings can be scheduled for a draft movie, and customers cannot see or book them', async () => {
  const admin = await signIn('boss', 'admin');
  const customer = await signIn('ann');
  const hall = addHall();
  const movie = addMovie({ status: 'draft', releaseDate: new Date(`${day(-10)}T00:00:00Z`) });

  const one = await schedule(admin, movie, hall, 3);
  assert.equal(one.status, 201, JSON.stringify(one.data));
  const bulk = await call('POST', '/api/showtimes/bulk', {
    session: admin, body: { movie: String(movie._id), auditorium: String(hall._id), startDate: day(4), endDate: day(5), times: ['10:00'], ticketPrice: 30000 },
  });
  assert.equal(bulk.status, 201, JSON.stringify(bulk.data));
  assert.equal(showtimes.length, 3);

  const list = await call('GET', '/api/showtimes');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 0, 'the public list shows nothing for a draft movie');
  assert.equal((await call('GET', `/api/showtimes/${one.data._id}/seats`)).status, 404, 'its seat map is not public');
  const refused = await book(customer, { _id: one.data._id }, ['A1']);
  assert.equal(refused.status, 404, 'and it cannot be booked');
  assert.equal(bookings.length, 0);
  const admin_ = await call('GET', `/api/admin/showtimes?movie=${movie._id}`, { session: admin });
  assert.equal(admin_.data.length, 3, 'the admin sees them');

  // publish it: now the showings are on sale
  assert.equal((await setStatus(admin, movie, 'published')).status, 200);
  assert.equal((await call('GET', '/api/showtimes')).data.length, 3);
  assert.equal((await book(customer, { _id: one.data._id }, ['A1'])).status, 201);
});

test('an archived movie cannot get showings until it is a draft or published again', async () => {
  const admin = await signIn('boss', 'admin');
  const hall = addHall();
  const movie = addMovie({ status: 'archived' });
  const refused = await schedule(admin, movie, hall);
  assert.equal(refused.status, 400);
  assert.match(refused.data.errors.movie, /archived.*Draft or Published/);
  assert.equal((await setStatus(admin, movie, 'draft')).status, 200);
  assert.equal((await schedule(admin, movie, hall)).status, 201);
});

test('after "take off sale" the movie cannot go live again until it has a showing', async () => {
  const admin = await signIn('boss', 'admin');
  const hall = addHall();
  const movie = addMovie();
  addShow(movie, hall, soon(2 * DAY));
  const off = await call('POST', `/api/admin/movies/${movie._id}/withdraw`, { session: admin, body: { status: 'draft' } });
  assert.equal(off.status, 200);
  assert.equal(movie.status, 'draft');
  assert.equal((await setStatus(admin, movie, 'published')).status, 409, 'its showings were cancelled');
  assert.equal((await schedule(admin, movie, hall, 6)).status, 201);
  assert.equal((await setStatus(admin, movie, 'published')).status, 200);
});

test('unpublishing a movie that has upcoming showings is still refused', async () => {
  const admin = await signIn('boss', 'admin');
  const hall = addHall();
  const movie = addMovie();
  addShow(movie, hall, soon(2 * DAY));
  assert.equal((await setStatus(admin, movie, 'draft')).status, 409);
});
