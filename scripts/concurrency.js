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
 *   - cancelling frees the seat so it can be booked again;
 *   - blocking a seat while customers race to book it never leaves a booked seat that is blocked;
 *   - hiding a showing while customers race to book it never leaves a hidden showing with tickets;
 *   - three admins scheduling the same room and time at once: exactly one showing is created.
 * Everything it creates is named "conc-..." / "[CONC] ..." and is deleted again at the end.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'test';
// The seat checks below are about seats, so they confirm bookings at once. The payment checks at the
// end switch payments on (the setting is read on every request).
process.env.PAYMENT_REQUIRED = 'false';
process.env.PAYMENT_DELAY_MS = '0';

const mongoose = require('mongoose');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const Payment = require('../models/Payment');

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
  await Payment.init();

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
      posterUrl: 'https://example.com/p.jpg', duration: 90, releaseDate: '2020-01-01', status: 'published',
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

  await check('blocking a seat while customers race to book it: a seat is never both booked and blocked', async () => {
    const showtime = await newShowtime();
    const [blocked, ...answers] = await Promise.all([
      api('PUT', `/showtimes/${showtime._id}/blocked-seats`, { session: admin, body: { seats: ['A1'] } }),
      ...customers.slice(0, 6).map((c) => book(c, showtime, ['A1'])),
    ]);
    assert(answers.every((a) => [201, 409, 503].includes(a.status)), `unexpected statuses: ${statuses(answers)}`);
    const booked = await Booking.countDocuments({ showtime: showtime._id, status: 'confirmed' });
    if (blocked.status === 200) {
      assert(booked === 0, `the seat was blocked, yet ${booked} booking(s) hold it`);
    } else {
      assert(blocked.status === 409, `unexpected block status ${blocked.status}`);
      assert(booked === 1, `the block was refused because a customer holds the seat, but ${booked} bookings exist`);
    }
    assert(await claimsOf(showtime) === booked, 'seat claims do not match the bookings');
  });

  await check('hiding a showing while customers race to book it: a hidden showing never has tickets', async () => {
    const showtime = await newShowtime();
    const [hidden, ...answers] = await Promise.all([
      api('PATCH', `/showtimes/${showtime._id}/visibility`, { session: admin, body: { published: false } }),
      ...customers.slice(0, 6).map((c, i) => book(c, showtime, [`B${i + 1}`])),
    ]);
    assert(answers.every((a) => [201, 404, 409, 503].includes(a.status)), `unexpected statuses: ${statuses(answers)}`);
    const booked = await Booking.countDocuments({ showtime: showtime._id, status: 'confirmed' });
    if (hidden.status === 200) {
      assert(booked === 0, `the showing was hidden, yet ${booked} confirmed booking(s) exist`);
    } else {
      assert(hidden.status === 409, `unexpected hide status ${hidden.status}`);
      assert(booked >= 1, 'hiding was refused, but no one holds a ticket');
    }
  });

  await check('3 admins scheduling the same room and time at once: exactly one showing is created', async () => {
    const farDay = new Date(Date.now() + 60 * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const answers = await Promise.all([1, 2, 3].map(() => api('POST', '/showtimes/bulk', {
      session: admin,
      body: { movie: movie._id, auditorium: hall._id, startDate: farDay, times: ['10:00'], ticketPrice: 40000 },
    })));
    assert(count(answers, 201) === 1, `created by ${count(answers, 201)} requests (statuses ${statuses(answers)})`);
    assert(answers.every((a) => a.status === 201 || a.status === 409), `unexpected statuses: ${statuses(answers)}`);
    const start = new Date(`${farDay}T10:00:00+08:00`);
    assert(await Showtime.countDocuments({ auditorium: hall._id, startTime: start }) === 1, 'the same slot was scheduled more than once');
  });

  // ---- payments: seats are held while paying (real database, real transactions) ---------------
  process.env.PAYMENT_REQUIRED = 'true';
  const VISA = { method: 'card', number: '4242424242424242', expiry: '12/39', cvc: '123' };
  const pay = (session, booking, body = VISA) => api('POST', `/bookings/${booking._id}/pay`, { session, body });
  try {
    await check('payments: 6 customers hold the same seat at once, exactly one wins, and paying confirms it', async () => {
      const showtime = await newShowtime();
      const answers = await Promise.all(customers.slice(0, 6).map((c) => book(c, showtime, ['B1'])));
      assert(statuses(answers).join() === '201,409,409,409,409,409', `statuses: ${statuses(answers)}`);
      const winnerIndex = answers.findIndex((a) => a.status === 201);
      const held = answers[winnerIndex].data;
      assert(held.status === 'pending' && held.holdExpiresAt, `the hold was ${held.status}`);
      const paid = await pay(customers[winnerIndex], held);
      assert(paid.status === 200 && paid.data.booking.status === 'confirmed', `paying gave ${paid.status} ${JSON.stringify(paid.data)}`);
      assert(await Payment.countDocuments({ booking: held._id, status: 'paid' }) === 1, 'expected exactly one paid payment');
      assert(await claimsOf(showtime) === 1, 'expected exactly one seat claim');
    });

    await check('payments: a hold that ran out frees the seat for the next customer, and the late payment is refused', async () => {
      const showtime = await newShowtime();
      const first = (await book(customers[0], showtime, ['C1'])).data;
      await Booking.updateOne({ _id: first._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const second = await book(customers[1], showtime, ['C1']);
      assert(second.status === 201, `the next customer got ${second.status} ${JSON.stringify(second.data)}`);
      const late = await pay(customers[0], first);
      assert(late.status === 409, `the late payment got ${late.status}`);
      assert(await Payment.countDocuments({ booking: first._id, status: 'paid' }) === 0, 'a released booking was charged');
      assert(await claimsOf(showtime) === 1, 'expected exactly one seat claim');
    });

    await check('payments: paying and giving up at the same moment never leaves a paid booking without seats', async () => {
      for (let round = 0; round < 3; round += 1) {
        const showtime = await newShowtime();
        const held = (await book(customers[2], showtime, ['D1', 'D2'])).data;
        await Promise.all([pay(customers[2], held), api('POST', `/bookings/${held._id}/release`, { session: customers[2] })]);
        const booking = await Booking.findById(held._id);
        const claims = await claimsOf(showtime);
        const paid = await Payment.countDocuments({ booking: held._id, status: 'paid' });
        if (booking.status === 'confirmed') assert(paid === 1 && claims === 2, `confirmed but paid=${paid} claims=${claims}`);
        else assert(booking.status === 'expired' && paid === 0 && claims === 0, `${booking.status} but paid=${paid} claims=${claims}`);
      }
    });

    await check('payments: cancelling a paid booking refunds it once, even when requested twice at the same time', async () => {
      const showtime = await newShowtime();
      const held = (await book(customers[3], showtime, ['E1'])).data;
      await pay(customers[3], held);
      await Promise.all([1, 2].map(() => api('PATCH', `/bookings/${held._id}/cancel`, { session: customers[3] })));
      assert(await Payment.countDocuments({ booking: held._id, status: 'refunded' }) === 1, 'expected exactly one refund');
      assert(await Payment.countDocuments({ booking: held._id, status: 'paid' }) === 0, 'a refunded payment is still marked paid');
      assert(await claimsOf(showtime) === 0, 'the seat was not freed');
    });

    await check('payments: cancelling a showing refunds its paid bookings and releases unpaid holds', async () => {
      const showtime = await newShowtime();
      const heldOne = await book(customers[4], showtime, ['F1']);
      assert(heldOne.status === 201, `booking F1 gave ${heldOne.status} ${JSON.stringify(heldOne.data)}`);
      const paidOne = heldOne.data;
      const paidAnswer = await pay(customers[4], paidOne);
      assert(paidAnswer.status === 200, `paying F1 gave ${paidAnswer.status} ${JSON.stringify(paidAnswer.data)}`);
      const unpaid = (await book(customers[5], showtime, ['F2'])).data;
      const cancelled = await api('PATCH', `/showtimes/${showtime._id}/cancel`, { session: admin });
      assert(cancelled.status === 200, `cancel gave ${cancelled.status}`);
      const after = await Booking.findById(paidOne._id);
      const payments = await Payment.find({ booking: paidOne._id });
      assert(
        payments.filter((p) => p.status === 'refunded').length === 1,
        `the paid booking was not refunded (booking ${after.status}/${after.paymentStatus}, payments ${payments.map((p) => p.status).join() || 'none'}, cancel said ${JSON.stringify(cancelled.data)})`,
      );
      assert((await Booking.findById(unpaid._id)).status === 'expired', 'the unpaid hold was not released');
      assert(await claimsOf(showtime) === 0, 'seats are still claimed');
    });
  } finally {
    process.env.PAYMENT_REQUIRED = 'false';
  }
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
    const owned = await Booking.find({ $or: [{ user: { $in: users.map((u) => u._id) } }, { showtime: { $in: showtimeIds } }] }, '_id');
    await Payment.deleteMany({ booking: { $in: owned.map((b) => b._id) } });
    await Booking.deleteMany({ _id: { $in: owned.map((b) => b._id) } });
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
