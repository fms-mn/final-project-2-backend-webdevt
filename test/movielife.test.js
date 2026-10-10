// Offline tests for the life of a movie: it cannot be shown before its release day, whether it is
// "now showing" follows its real showings, customers see the cheapest price and next showing, and an
// admin can take a movie off sale in one step. They run the real app, models and services against the
// in-memory stand-in in fakeDb.js.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.BOOKING_RETRY_PAUSE_MS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
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
const settings = [];
let server;
let base;
let passwordHash;
let transactionHook = null;

const clear = () => [users, movies, auditoriums, showtimes, bookings, claims, settings].forEach((rows) => { rows.length = 0; });
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
  fakeModel(Setting, settings, { uniqueOn: 'key' });
  fakeModel(LoginAttempt, [], { uniqueOn: 'key' });
  fakeTransactions({
    stores: [bookings, claims, showtimes, auditoriums, settings],
    beforeAttempt: (attempt) => (transactionHook ? transactionHook(attempt) : false),
  });
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { clear(); transactionHook = null; });


const iso = (n, clock = '18:00') => atManila(day(n), clock);

// ---- 1. no showing before the release day --------------------------------------------------
test('release day: a showing cannot start before the movie is released', async () => {
  const movie = addMovie({ title: 'Big Premiere', releaseDate: new Date(`${day(5)}T00:00:00Z`) });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const make = (n, clock = '18:00') => call('POST', '/api/showtimes', {
    session: admin, body: { movie: String(movie._id), auditorium: String(hall._id), startTime: iso(n, clock).toISOString(), ticketPrice: 40000 },
  });

  const early = await make(3);
  assert.equal(early.status, 400);
  assert.match(early.data.errors.startTime, /"Big Premiere" is released on .* A showing cannot start before that day/);
  const lastMinute = await make(4, '23:59');
  assert.equal(lastMinute.status, 400, 'the night before is still before');
  assert.equal(showtimes.length, 0, 'nothing was saved');

  assert.equal((await make(5, '00:30')).status, 201, 'the first minutes of the release day are fine');
  assert.equal((await make(6)).status, 201);
});

test('release day: editing, moving and bulk scheduling follow the same rule', async () => {
  const movie = addMovie({ title: 'Big Premiere', releaseDate: new Date(`${day(5)}T00:00:00Z`) });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const ok = addShow(movie, hall, iso(6));
  const booked = addShow(movie, hall, iso(7));
  const customer = await signIn('ann');
  assert.equal((await book(customer, booked, ['A1'])).status, 201);

  const edit = await call('PATCH', `/api/showtimes/${ok._id}`, { session: admin, body: { startTime: iso(4).toISOString() } });
  assert.equal(edit.status, 400);
  assert.match(edit.data.errors.startTime, /released on/);
  const move = await call('PATCH', `/api/showtimes/${booked._id}/reschedule`, { session: admin, body: { startTime: iso(2).toISOString() } });
  assert.equal(move.status, 400, 'a showing with bookings cannot be moved before the release either');
  assert.equal((await call('PATCH', `/api/showtimes/${booked._id}/reschedule`, { session: admin, body: { startTime: iso(8).toISOString() } })).status, 200);

  const bulk = (extra) => call('POST', '/api/showtimes/bulk', {
    session: admin,
    body: { movie: String(movie._id), auditorium: String(hall._id), startDate: day(3), endDate: day(5), times: ['10:00'], ticketPrice: 30000, ...extra },
  });
  const preview = await bulk({ dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.createdCount, 1, 'only the release day itself fits');
  assert.equal(preview.data.skippedCount, 2);
  assert.match(preview.data.skipped[0].reason, /released on/);
  assert.equal((await bulk({})).status, 409, 'without skipConflicts the whole request fails');
  const done = await bulk({ skipConflicts: true });
  assert.equal(done.data.createdCount, 1);
  assert.equal(showtimes.filter((s) => manilaDay(s.startTime) < day(5)).length, 0, 'no showing before the release day');
});

test('release day: the release date cannot move past a showing that is already scheduled', async () => {
  const movie = addMovie({ releaseDate: new Date(`${day(-30)}T00:00:00Z`) });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  addShow(movie, hall, iso(3));
  const later = await call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { releaseDate: `${day(10)}` } });
  assert.equal(later.status, 409);
  assert.match(later.data.message, /showing is already scheduled for/);
  assert.equal((await call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { releaseDate: `${day(3)}` } })).status, 200, 'the same day is fine');
  assert.equal((await call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { releaseDate: `${day(-5)}` } })).status, 200, 'earlier is fine');
});

// ---- 2 + 3. "now showing" follows the showings ----------------------------------------------
test('showing status: now showing needs a bookable showing, coming soon needs a future release', async () => {
  const hall = addHall();
  const withShow = addMovie({ title: 'Has Showings' });
  const noShow = addMovie({ title: 'No Showings' });
  const future = addMovie({ title: 'Later', releaseDate: new Date(`${day(20)}T00:00:00Z`) });
  addShow(withShow, hall, iso(1), { ticketPrice: 50000 });
  addShow(withShow, hall, iso(2), { ticketPrice: 35000 });
  addShow(withShow, hall, iso(3), { ticketPrice: 45000 });

  const list = (await call('GET', '/api/movies')).data;
  const by = (title) => list.find((m) => m.title === title);
  assert.equal(by('Has Showings').showStatus, 'now_showing');
  assert.equal(by('Has Showings').upcomingShowings, 3);
  assert.equal(new Date(by('Has Showings').nextShowing).getTime(), iso(1).getTime(), 'the earliest showing');
  assert.equal(by('Has Showings').fromPrice, 35000, 'the cheapest ticket, in centavos');
  assert.equal(by('No Showings').showStatus, 'not_showing', 'released, but nothing to book');
  assert.equal(by('No Showings').upcomingShowings, 0);
  assert.equal(by('No Showings').nextShowing, null);
  assert.equal(by('No Showings').fromPrice, null);
  assert.equal(by('Later').showStatus, 'coming_soon');
  assert.equal((await call('GET', `/api/movies/${noShow._id}`)).data.showStatus, 'not_showing', 'the single-movie answer agrees');
  assert.equal((await call('GET', `/api/movies/${future._id}`)).data.showStatus, 'coming_soon');
});

test('showing status: hidden, cancelled, past and too-late showings do not count', async () => {
  const hall = addHall();
  const movie = addMovie({ title: 'Quiet' });
  addShow(movie, hall, iso(1), { isPublished: false });
  addShow(movie, hall, iso(2), { status: 'cancelled' });
  addShow(movie, hall, new Date(Date.now() - 2 * HOUR));
  addShow(movie, hall, soon(10 * MIN)); // inside the 15-minute sales cutoff
  const status = async () => (await call('GET', `/api/movies/${movie._id}`)).data;
  assert.equal((await status()).showStatus, 'not_showing');

  addShow(movie, hall, iso(3), { ticketPrice: 25000 });
  const now = await status();
  assert.equal(now.showStatus, 'now_showing');
  assert.equal(now.upcomingShowings, 1);
  assert.equal(now.fromPrice, 25000, 'the price comes only from showings that can be booked');

  const admin = await signIn('boss', 'admin');
  await call('PATCH', '/api/admin/settings', { session: admin, body: { salesCutoffMinutes: 0 } });
  assert.equal((await status()).upcomingShowings, 2, 'with no cutoff the showing 10 minutes away counts');
});

test('showing status: the admin list carries the same facts', async () => {
  const hall = addHall();
  const movie = addMovie({ title: 'Live' });
  addMovie({ title: 'Quiet' });
  addMovie({ title: 'Draft one', status: 'draft' });
  addShow(movie, hall, iso(1));
  const admin = await signIn('boss', 'admin');
  const all = (await call('GET', '/api/admin/movies', { session: admin })).data;
  assert.equal(all.length, 3);
  assert.equal(all.find((m) => m.title === 'Live').showStatus, 'now_showing');
  assert.equal(all.find((m) => m.title === 'Live').upcomingShowings, 1);
  assert.equal(all.find((m) => m.title === 'Quiet').showStatus, 'not_showing');
});

// ---- 5. taking a movie off sale in one step -------------------------------------------------
test('withdraw: admin only, validated, and a missing movie is 404', async () => {
  const movie = addMovie();
  const admin = await signIn('boss', 'admin');
  const customer = await signIn('ann');
  const path = `/api/admin/movies/${movie._id}/withdraw`;
  assert.equal((await call('POST', path, { body: {} })).status, 401);
  assert.equal((await call('POST', path, { body: {}, session: customer })).status, 403);
  assert.equal((await call('POST', path, { body: { dryRun: 'yes' }, session: admin })).status, 400);
  assert.equal((await call('POST', path, { body: { status: 'published' }, session: admin })).status, 400);
  assert.equal((await call('POST', '/api/admin/movies/507f1f77bcf86cd799439099/withdraw', { body: {}, session: admin })).status, 404);
  assert.equal((await call('POST', '/api/admin/movies/not-an-id/withdraw', { body: {}, session: admin })).status, 404);
  assert.equal(movie.status, 'published', 'nothing changed');
});

test('withdraw: a dry run only counts; the real thing cancels showings and bookings, then archives', async () => {
  const movie = addMovie({ title: 'Pulled' });
  const other = addMovie({ title: 'Stays' });
  const hall = addHall({ rows: 3, seatsPerRow: 3 });
  const a = addShow(movie, hall, iso(1));
  const b = addShow(movie, hall, iso(2));
  const gone = addShow(movie, hall, iso(3), { status: 'cancelled' });
  const keep = addShow(other, hall, iso(4));
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  assert.equal((await book(ann, a, ['A1', 'A2'])).status, 201);
  assert.equal((await book(bob, b, ['B1'])).status, 201);
  assert.equal((await book(bob, keep, ['C1'])).status, 201);
  const path = `/api/admin/movies/${movie._id}/withdraw`;

  const dry = await call('POST', path, { body: { dryRun: true }, session: admin });
  assert.deepEqual(dry.data, { dryRun: true, status: 'archived', showings: 2, bookings: 2 });
  assert.equal(movie.status, 'published', 'a dry run changes nothing');
  assert.equal(bookings.filter((x) => x.status === 'confirmed').length, 3);

  // the old rule still protects against a careless archive
  assert.equal((await call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { status: 'archived' } })).status, 409);

  const real = await call('POST', path, { body: {}, session: admin });
  assert.equal(real.status, 200);
  assert.equal(real.data.showings, 2);
  assert.equal(real.data.bookings, 2);
  assert.equal(movie.status, 'archived');
  assert.deepEqual([a.status, b.status, gone.status, keep.status], ['cancelled', 'cancelled', 'cancelled', 'scheduled']);
  assert.equal(bookings.filter((x) => x.status === 'confirmed').length, 1, 'only the booking on the other movie is left');
  assert.equal(claims.filter((c) => String(c.showtime) === String(a._id) || String(c.showtime) === String(b._id)).length, 0, 'the seats are free again');
  assert.equal((await call('GET', '/api/movies')).data.some((m) => m.title === 'Pulled'), false, 'customers no longer see it');

  const again = await call('POST', path, { body: {}, session: admin });
  assert.equal(again.status, 200, 'safe to repeat');
  assert.equal(again.data.showings, 0);
});

test('withdraw: it can move the movie back to draft instead', async () => {
  const movie = addMovie();
  const hall = addHall();
  addShow(movie, hall, iso(1));
  const admin = await signIn('boss', 'admin');
  const done = await call('POST', `/api/admin/movies/${movie._id}/withdraw`, { body: { status: 'draft' }, session: admin });
  assert.equal(done.status, 200);
  assert.equal(movie.status, 'draft');
  assert.equal(showtimes.filter((s) => s.status === 'scheduled').length, 0);
});
