// Offline tests for the admin sales figures (GET /api/admin/stats), against the in-memory
// stand-in in fakeDb.js.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const LoginAttempt = require('../models/LoginAttempt');
const { fakeModel } = require('./fakeDb');

const PASSWORD = 'correct-horse-1';
const HOUR = 60 * 60 * 1000;
const users = [];
const movies = [];
const auditoriums = [];
const showtimes = [];
const bookings = [];
let server;
let base;
let passwordHash;

const add = (Model, rows, fields) => { const doc = new Model(fields); doc.$isNew = false; rows.push(doc); return doc; };
const movie = (title) => add(Movie, movies, {
  title, synopsis: 'x', genre: 'Drama', rating: 'PG', duration: 100,
  posterUrl: 'https://example.com/p.jpg', releaseDate: new Date('2026-01-01'), status: 'published',
});
const hall = () => add(Auditorium, auditoriums, { name: 'Hall', rows: 2, seatsPerRow: 5, seatLabels: Auditorium.generateSeatLabels(2, 5) });
const showing = (m, h, start) => add(Showtime, showtimes, {
  movie: m._id, auditorium: h._id, startTime: new Date(start),
  endTime: Showtime.computeEndTime(new Date(start), m.duration), ticketPrice: 40000,
});
let code = 0;
const booking = (user, show, seats, bookedAt, status = 'confirmed') => add(Booking, bookings, {
  bookingCode: `FLM-TEST${String(code += 1).padStart(4, '0')}`, user: user._id, showtime: show._id, seats,
  unitPrice: 40000, totalAmount: 40000 * seats.length, status, bookedAt: new Date(bookedAt),
});

async function signIn(name, role) {
  const email = `${name}@example.com`;
  const user = add(User, users, { name, email, passwordHash, role });
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await response.json();
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('filme_session='));
  return { cookie, user };
}
const get = async (path, session) => {
  const response = await fetch(base + path, { headers: session ? { Cookie: session.cookie } : {} });
  let data = null;
  try { data = await response.json(); } catch { /* no body */ }
  return { status: response.status, data };
};

test.before(async () => {
  passwordHash = await User.hashPassword(PASSWORD);
  [[User, users], [Movie, movies], [Auditorium, auditoriums], [Showtime, showtimes], [Booking, bookings], [LoginAttempt, []]]
    .forEach(([Model, rows]) => fakeModel(Model, rows));
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { [users, movies, auditoriums, showtimes, bookings].forEach((rows) => { rows.length = 0; }); code = 0; });

test('stats: only an admin may read them, and the dates are checked', async () => {
  const customer = await signIn('cust', 'user');
  assert.equal((await get('/api/admin/stats?from=2026-10-01&to=2026-10-07')).status, 401);
  assert.equal((await get('/api/admin/stats?from=2026-10-01&to=2026-10-07', customer)).status, 403);
  const admin = await signIn('boss', 'admin');
  for (const query of ['', '?from=2026-10-01', '?from=nope&to=2026-10-07', '?from=2026-10-09&to=2026-10-07', '?from=2026-01-01&to=2026-12-31']) {
    const res = await get(`/api/admin/stats${query}`, admin);
    assert.equal(res.status, 400, query);
  }
});

test('stats: revenue, tickets, customers, daily series, top movies and occupancy', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann', 'user');
  const bob = await signIn('bob', 'user');
  const dune = movie('Dune');
  const heat = movie('Heat');
  const room = hall(); // 10 seats
  const duneShow = showing(dune, room, '2026-10-05T10:00:00+08:00');
  const heatShow = showing(heat, room, '2026-10-06T10:00:00+08:00');

  booking(ann.user, duneShow, ['A1', 'A2'], '2026-10-04T06:00:00+08:00'); // 800.00, still Oct 3 in UTC
  booking(bob.user, duneShow, ['A3'], '2026-10-04T23:30:00+08:00'); // 400.00, still Oct 4 in Manila
  booking(ann.user, heatShow, ['B1', 'B2', 'B3'], '2026-10-05T15:00:00+08:00'); // 1200.00
  booking(bob.user, heatShow, ['B4'], '2026-10-05T16:00:00+08:00', 'cancelled'); // never revenue
  booking(bob.user, heatShow, ['B5'], '2026-10-02T12:00:00+08:00'); // outside the range, in the previous period

  const res = await get('/api/admin/stats?from=2026-10-04&to=2026-10-06', admin);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const stats = res.data;
  assert.equal(stats.revenue, 80000 + 40000 + 120000);
  assert.equal(stats.tickets, 6);
  assert.equal(stats.customers, 2);
  assert.equal(stats.bookings, 4, 'the cancelled one is counted as a booking');
  assert.equal(stats.cancelled, 1);
  assert.deepEqual(stats.previous, { revenue: 40000, tickets: 1 });
  assert.deepEqual(stats.daily, [
    { date: '2026-10-04', revenue: 120000, tickets: 3 },
    { date: '2026-10-05', revenue: 120000, tickets: 3 },
    { date: '2026-10-06', revenue: 0, tickets: 0 },
  ]);
  // A tie on money and tickets is listed by title.
  assert.deepEqual(stats.topMovies.map((m) => [m.title, m.tickets, m.revenue]), [
    ['Dune', 3, 120000], ['Heat', 3, 120000],
  ]);
  // Two showings of 10 seats each. Confirmed seats sold on them: 3 (Dune), 3 and 1 (Heat) = 7 of 20.
  assert.equal(stats.showings, 2);
  assert.equal(stats.occupancy, 35);
});

test('stats: an empty range is all zeros and has no occupancy', async () => {
  const admin = await signIn('boss', 'admin');
  const res = await get('/api/admin/stats?from=2026-10-04&to=2026-10-04', admin);
  assert.equal(res.status, 200);
  assert.equal(res.data.revenue, 0);
  assert.equal(res.data.occupancy, null);
  assert.deepEqual(res.data.topMovies, []);
  assert.equal(res.data.daily.length, 1);
});
