/**
 * Booking concurrency test (Trello: "Concurrency test script"). Run from the repository root with
 * MongoDB reachable (for example Atlas) and server/.env set:
 *
 *   npm run concurrency
 *
 * It starts the real API on a spare port, creates its own temporary users, movie, auditorium and
 * showtimes, and then fires booking requests AT THE SAME TIME to prove the rules the whole system
 * depends on:
 *   - two requests for the same seat: exactly one succeeds, the other gets 409;
 *   - many requests for one seat: still exactly one;
 *   - a multi-seat booking where one seat is taken leaves no booking and no seat claims;
 *   - many customers booking different seats at once all succeed (conflicts retry internally);
 *   - a showtime cancelled while bookings are arriving never ends up with a confirmed booking;
 *   - cancelling frees the seat so it can be booked again.
 * Everything it creates is named "conc-..." / "[CONC] ..." and is deleted again at the end.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'test';

const mongoose = require('mongoose');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');

const RUN_ID = Date.now();
const PASSWORD = 'conc-pass-12345';
const DAY = 24 * 60 * 60 * 1000;
const results = [];
let base;
let httpServer;

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error.message).split('\n').slice(0, 6).join('\n') });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(method, route, { session, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { /* empty */ }
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('filme_session='));
  return { status: response.status, data, cookie };
}

async function newCustomer(tag) {
  const res = await api('POST', '/auth/register', {
    body: { name: `Conc ${tag}`, email: `conc-${tag}-${RUN_ID}@test.local`, password: PASSWORD },
  });
  assert(res.status === 201, `could not register ${tag}: ${res.status} ${JSON.stringify(res.data)}`);
  return { cookie: res.cookie, csrf: res.data.csrfToken };
}

const statuses = (answers) => answers.map((a) => a.status).sort((a, b) => a - b);
const count = (answers, code) => answers.filter((a) => a.status === code).length;

async function main() {
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
    console.error('Set MONGODB_URI and JWT_SECRET in server/.env first (see server/.env.example).');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  // Transactions and the unique seat index need the indexes to exist.
  await SeatClaim.init();
  await Booking.init();

  const { createApp } = require('../app');
  httpServer = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${httpServer.address().port}/api`;

  // An administrator of our own, to build the test data through the real API.
  await new User({
    name: 'Conc Admin', email: `conc-admin-${RUN_ID}@test.local`,
    passwordHash: await User.hashPassword(PASSWORD), role: 'admin',
  }).save();
  const login = await api('POST', '/auth/login', { body: { email: `conc-admin-${RUN_ID}@test.local`, password: PASSWORD } });
  assert(login.status === 200, `admin login failed: ${login.status}`);
  const admin = { cookie: login.cookie, csrf: login.data.csrfToken };

  const movie = (await api('POST', '/admin/movies', {
    session: admin,
    body: {
      title: `[CONC] film ${RUN_ID}`, synopsis: 'Temporary.', genre: 'Test', rating: 'PG',
      posterUrl: 'https://example.com/p.jpg', duration: 90, releaseDate: '2030-01-01', status: 'published',
    },
  })).data;
  const hall = (await api('POST', '/auditoriums', {
    session: admin, body: { name: `CONC hall ${RUN_ID}`, rows: 5, seatsPerRow: 6 },
  })).data;
  assert(movie && movie._id && hall && hall._id, 'could not create the test movie and auditorium');
  let slotNumber = 0;
  const newShowtime = async () => {
    slotNumber += 1;
    const res = await api('POST', '/showtimes', {
      session: admin,
      body: { movie: movie._id, auditorium: hall._id, startTime: new Date(Date.now() + (slotNumber + 1) * DAY).toISOString(), ticketPrice: 40000 },
    });
    assert(res.status === 201, `could not create a showtime: ${res.status} ${JSON.stringify(res.data)}`);
    return res.data;
  };
  const book = (session, showtime, seats) => api('POST', '/bookings', { session, body: { showtime: showtime._id, seats } });
  const claimsOf = (showtime) => SeatClaim.countDocuments({ showtime: showtime._id });

  const customers = await Promise.all(Array.from({ length: 12 }, (_, i) => newCustomer(`c${i}`)));

  await check('2 simultaneous requests for the same seat: exactly one 201 and one 409', async () => {
    const showtime = await newShowtime();
    const answers = await Promise.all([book(customers[0], showtime, ['A1']), book(customers[1], showtime, ['A1'])]);
    assert(statuses(answers).join() === '201,409', `statuses: ${statuses(answers)}`);
    assert(await claimsOf(showtime) === 1, 'expected exactly one seat claim');
    assert(await Booking.countDocuments({ showtime: showtime._id }) === 1, 'expected exactly one booking');
  });

  await check('10 simultaneous requests for the same seat: exactly one wins, nobody gets a server error', async () => {
    const showtime = await newShowtime();
    const answers = await Promise.all(customers.slice(0, 10).map((c) => book(c, showtime, ['B2'])));
    assert(count(answers, 201) === 1, `winners: ${count(answers, 201)} (statuses ${statuses(answers)})`);
    assert(answers.every((a) => a.status === 201 || a.status === 409 || a.status === 503), `unexpected statuses: ${statuses(answers)}`);
    assert(count(answers, 503) === 0, `${count(answers, 503)} requests gave up as "busy" (statuses ${statuses(answers)})`);
    assert(await claimsOf(showtime) === 1, 'expected exactly one seat claim');
  });

  await check('a multi-seat booking with one taken seat leaves no partial booking and no partial claims', async () => {
    const showtime = await newShowtime();
    assert((await book(customers[0], showtime, ['C1'])).status === 201, 'setup booking failed');
    const refused = await book(customers[1], showtime, ['C2', 'C1', 'C3']);
    assert(refused.status === 409, `expected 409, got ${refused.status} ${JSON.stringify(refused.data)}`);
    assert(await claimsOf(showtime) === 1, `expected 1 claim, found ${await claimsOf(showtime)} (partial claims left behind)`);
    assert(await Booking.countDocuments({ showtime: showtime._id }) === 1, 'a partial booking was left behind');
    assert((await book(customers[1], showtime, ['C2', 'C3'])).status === 201, 'the untouched seats should still be bookable');
  });

  await check('12 customers booking 12 different seats at once: all succeed (conflicts are retried)', async () => {
    const showtime = await newShowtime();
    const seats = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6'];
    const answers = await Promise.all(customers.map((c, i) => book(c, showtime, [seats[i]])));
    assert(count(answers, 201) === 12, `only ${count(answers, 201)} of 12 succeeded (statuses ${statuses(answers)})`);
    assert(await claimsOf(showtime) === 12, 'expected 12 seat claims');
  });

  await check('overlapping multi-seat requests: every seat ends up with at most one owner', async () => {
    const showtime = await newShowtime();
    const wanted = [['D1', 'D2'], ['D2', 'D3'], ['D3', 'D4'], ['D4', 'D5'], ['D1', 'D5']];
    const answers = await Promise.all(wanted.map((seats, i) => book(customers[i], showtime, seats)));
    assert(answers.every((a) => a.status === 201 || a.status === 409), `unexpected statuses: ${statuses(answers)}`);
    const claimed = await SeatClaim.find({ showtime: showtime._id });
    assert(new Set(claimed.map((c) => c.seatLabel)).size === claimed.length, 'a seat was claimed twice');
    const winners = answers.map((a, i) => (a.status === 201 ? wanted[i].length : 0)).reduce((a, b) => a + b, 0);
    assert(claimed.length === winners, `${claimed.length} claims for ${winners} booked seats`);
  });

  await check('cancelling a booking frees the seat, repeating is harmless, then it can be booked again', async () => {
    const showtime = await newShowtime();
    const made = await book(customers[0], showtime, ['E1']);
    assert(made.status === 201, 'setup booking failed');
    const url = `/bookings/${made.data._id}/cancel`;
    assert((await api('PATCH', url, { session: customers[1] })).status === 404, 'another customer must not be able to cancel it');
    const first = await api('PATCH', url, { session: customers[0] });
    const second = await api('PATCH', url, { session: customers[0] });
    assert(first.status === 200 && second.status === 200, `statuses ${first.status}, ${second.status}`);
    assert(first.data.cancelledAt === second.data.cancelledAt, 'a repeated cancel changed cancelledAt');
    assert(await claimsOf(showtime) === 0, 'the seat claim was not removed');
    assert((await book(customers[1], showtime, ['E1'])).status === 201, 'the freed seat could not be booked again');
  });

  await check('cancelling a showtime while bookings arrive never leaves a confirmed booking on it', async () => {
    const showtime = await newShowtime();
    const seats = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2'];
    const [, ...answers] = await Promise.all([
      api('PATCH', `/showtimes/${showtime._id}/cancel`, { session: admin }),
      ...seats.map((seat, i) => book(customers[i], showtime, [seat])),
    ]);
    assert(answers.every((a) => [201, 409, 503].includes(a.status)), `unexpected statuses: ${statuses(answers)}`);
    const stored = await Showtime.findById(showtime._id);
    assert(stored.status === 'cancelled', 'the showtime was not cancelled');
    const confirmed = await Booking.countDocuments({ showtime: showtime._id, status: 'confirmed' });
    assert(confirmed === 0, `${confirmed} confirmed booking(s) are left on a cancelled showtime`);
    assert(await claimsOf(showtime) === 0, 'seat claims are left on a cancelled showtime');
  });
}

async function cleanup() {
  try {
    if (mongoose.connection.readyState !== 1) return;
    const users = await User.find({ email: new RegExp(`^conc-.*-${RUN_ID}@test\\.local$`) }, '_id');
    const movies = await Movie.find({ title: `[CONC] film ${RUN_ID}` }, '_id');
    const halls = await Auditorium.find({ name: `CONC hall ${RUN_ID}` }, '_id');
    const showtimes = await Showtime.find({
      $or: [{ movie: { $in: movies.map((m) => m._id) } }, { auditorium: { $in: halls.map((h) => h._id) } }],
    }, '_id');
    const showtimeIds = showtimes.map((s) => s._id);
    await SeatClaim.deleteMany({ showtime: { $in: showtimeIds } });
    await Booking.deleteMany({ $or: [{ user: { $in: users.map((u) => u._id) } }, { showtime: { $in: showtimeIds } }] });
    await Showtime.deleteMany({ _id: { $in: showtimeIds } });
    await Auditorium.deleteMany({ _id: { $in: halls.map((h) => h._id) } });
    await Movie.deleteMany({ _id: { $in: movies.map((m) => m._id) } });
    await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  } catch (error) {
    console.warn(`\n(cleanup incomplete: ${error.message})`);
  }
}

main()
  .catch((error) => {
    results.push({ name: 'setup', ok: false, detail: error.stack || error.message });
  })
  .finally(async () => {
    await cleanup();
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await mongoose.disconnect();
    console.log('\nBooking concurrency test\n');
    for (const r of results) {
      console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}`);
      if (!r.ok) console.log(`        ${String(r.detail).replace(/\n/g, '\n        ')}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ' - paste the FAIL lines to get help' : ''}\n`);
    process.exit(failed ? 1 : 0);
  });
