// Offline tests for the automatic archive rule: a released movie with no showings for long enough is
// archived by itself, and nothing else is. They run the real app, models and services against the
// in-memory stand-in in fakeDb.js.
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



const { archiveStaleMovies, staleMovies } = require('../services/movieArchive');
const longAgo = (days) => new Date(Date.now() - days * DAY);
const quiet = (title, extra = {}) => addMovie({ title, releaseDate: longAgo(90), updatedAt: longAgo(90), ...extra });

test('the rule is on by default: 30 days', async () => {
  const admin = await signIn('boss', 'admin');
  const rules = await call('GET', '/api/admin/settings', { session: admin });
  assert.equal(rules.data.autoArchiveDays, 30);
});

test('a released movie with no showings for 30+ days is archived, and says it was automatic', async () => {
  const movie = quiet('Forgotten Film');
  const result = await archiveStaleMovies();
  assert.deepEqual(result.archived.map((m) => m.title), ['Forgotten Film']);
  assert.equal(movie.status, 'archived');
  assert.ok(movie.autoArchivedAt, 'the movie remembers it was archived by the rule');
});

test('the preview lists what would be archived and changes nothing', async () => {
  const movie = quiet('Forgotten Film');
  const admin = await signIn('boss', 'admin');
  const preview = await call('GET', '/api/admin/movies/auto-archive', { session: admin });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.enabled, true);
  assert.equal(preview.data.days, 30);
  assert.deepEqual(preview.data.movies.map((m) => m.title), ['Forgotten Film']);
  assert.equal(movie.status, 'published', 'looking does not archive');
});

test('movies that must NOT be archived', async () => {
  const hall = addHall();
  const comingSoon = quiet('Coming Soon', { releaseDate: new Date(`${day(10)}T00:00:00Z`) });
  const upcoming = quiet('Has A Showing'); addShow(upcoming, hall, soon(3 * DAY));
  const hiddenPlan = quiet('Hidden Plan'); addShow(hiddenPlan, hall, soon(5 * DAY), { isPublished: false });
  const recentShow = quiet('Played Recently'); addShow(recentShow, hall, soon(-10 * DAY));
  const justEdited = quiet('Just Edited', { updatedAt: longAgo(5) });
  const justReleased = addMovie({ title: 'Just Released', releaseDate: longAgo(3), updatedAt: longAgo(3) });
  const draft = quiet('A Draft', { status: 'draft' });
  const archived = quiet('Already Archived', { status: 'archived' });
  const result = await archiveStaleMovies();
  assert.deepEqual(result.archived, [], 'nothing qualifies');
  assert.equal(comingSoon.status, 'published');
  assert.equal(upcoming.status, 'published');
  assert.equal(hiddenPlan.status, 'published');
  assert.equal(recentShow.status, 'published');
  assert.equal(justEdited.status, 'published');
  assert.equal(justReleased.status, 'published');
  assert.equal(draft.status, 'draft');
  assert.equal(archived.autoArchivedAt, undefined, 'a movie archived by hand is left alone');
});

test('the quiet time counts from the last showing, and cancelled showings never happened', async () => {
  const hall = addHall();
  const oldShow = quiet('Played Long Ago'); addShow(oldShow, hall, soon(-40 * DAY));
  const cancelledPast = quiet('Only Cancelled'); addShow(cancelledPast, hall, soon(-5 * DAY), { status: 'cancelled' });
  const cancelledFuture = quiet('Cancelled Future'); addShow(cancelledFuture, hall, soon(4 * DAY), { status: 'cancelled' });
  const result = await archiveStaleMovies();
  assert.deepEqual(result.archived.map((m) => m.title).sort(), ['Cancelled Future', 'Only Cancelled', 'Played Long Ago']);
});

test('the number of days is the admin\'s to change, and 0 switches the rule off', async () => {
  const admin = await signIn('boss', 'admin');
  const hall = addHall();
  const movie = quiet('Aging Film'); addShow(movie, hall, soon(-20 * DAY));
  assert.equal((await staleMovies()).movies.length, 0, '20 days is under the 30 day default');

  assert.equal((await setRules(admin, { autoArchiveDays: 14 })).status, 200);
  assert.deepEqual((await staleMovies()).movies.map((m) => m.title), ['Aging Film'], '20 days is over a 14 day rule');

  assert.equal((await setRules(admin, { autoArchiveDays: 0 })).status, 200);
  const off = await archiveStaleMovies();
  assert.equal(off.enabled, false);
  assert.deepEqual(off.archived, []);
  assert.equal(movie.status, 'published', 'off means off');
});

test('the days setting is validated in plain words', async () => {
  const admin = await signIn('boss', 'admin');
  for (const bad of [-1, 3651, 1.5, '30']) {
    const response = await setRules(admin, { autoArchiveDays: bad });
    assert.equal(response.status, 400, String(bad));
    assert.match(response.data.errors.autoArchiveDays, /whole number of days from 0 to 3650/);
  }
  assert.equal((await setRules(admin, { turnaroundMinutes: 20 })).status, 200, 'the other rules still work on their own');
  assert.equal((await call('GET', '/api/admin/settings', { session: admin })).data.autoArchiveDays, 30);
});

test('"Archive them now" runs the rule, and only an admin may', async () => {
  quiet('Forgotten Film');
  const customer = await signIn('cust');
  assert.equal((await call('POST', '/api/admin/movies/auto-archive', { session: customer })).status, 403);
  assert.equal((await call('GET', '/api/admin/movies/auto-archive', { session: customer })).status, 403);
  assert.equal((await call('POST', '/api/admin/movies/auto-archive')).status, 401);
  const admin = await signIn('boss', 'admin');
  const run = await call('POST', '/api/admin/movies/auto-archive', { session: admin });
  assert.equal(run.status, 200);
  assert.deepEqual(run.data.archived.map((m) => m.title), ['Forgotten Film']);
  const again = await call('POST', '/api/admin/movies/auto-archive', { session: admin });
  assert.deepEqual(again.data.archived, [], 'running it twice archives nothing new');
});

test('an archived movie is hidden from customers', async () => {
  const hallless = quiet('Forgotten Film');
  await archiveStaleMovies();
  const list = await call('GET', '/api/movies');
  assert.equal(list.status, 200);
  assert.equal(list.data.some((m) => m.title === hallless.title), false);
});

test('an admin who publishes it again clears the "automatic" mark, and a manual archive is not automatic', async () => {
  const movie = quiet('Forgotten Film');
  const admin = await signIn('boss', 'admin');
  await archiveStaleMovies();
  assert.ok(movie.autoArchivedAt);
  const back = await call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { status: 'published' } });
  assert.equal(back.status, 200);
  assert.equal(movie.status, 'published');
  assert.equal(movie.autoArchivedAt, undefined, 'the mark is cleared');
  const manual = await call('POST', `/api/admin/movies/${movie._id}/withdraw`, { session: admin, body: {} });
  assert.equal(manual.status, 200);
  assert.equal(movie.status, 'archived');
  assert.equal(movie.autoArchivedAt, undefined, 'archived by hand is not "automatic"');
});
