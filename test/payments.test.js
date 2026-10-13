// Offline tests for paying: seats are held while the customer pays, a card or wallet payment
// confirms the booking, a failed payment can be retried, an unpaid hold expires, and cancelling
// refunds. They run the real app, models and services against the in-memory stand-in in fakeDb.js.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.BOOKING_RETRY_PAUSE_MS = '1';
process.env.PAYMENT_DELAY_MS = '0'; // no pretend processing time in tests

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
let codeCounter = 0;
const addBooking = (showtime, user, fields = {}) => add(Booking, bookings, {
  bookingCode: `FLM-OLD${String(codeCounter += 1).padStart(5, '0')}`, user: user._id, showtime: showtime._id, seats: ['C4'],
  unitPrice: showtime.ticketPrice, totalAmount: showtime.ticketPrice, ...fields,
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
  fakeTransactions({
    stores: [bookings, claims, showtimes, auditoriums, settings, payments],
    beforeAttempt: (attempt) => (transactionHook ? transactionHook(attempt) : false),
  });
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { clear(); transactionHook = null; });


const VISA = { method: 'card', number: '4242 4242 4242 4242', expiry: '12/39', cvc: '123', name: 'Ann Reyes' };
const hold = (session, showtime, seats) => book(session, showtime, seats);
const pay = (session, booking, body) => call('POST', `/api/bookings/${booking._id}/pay`, { session, body });
const seatMap = async (showtime) => (await call('GET', `/api/showtimes/${showtime._id}/seats`)).data.seats;
const statusOf = (map, label) => map.find((seat) => seat.label === label).status;

async function setup() {
  const movie = addMovie();
  const hall = addHall({ rows: 3, seatsPerRow: 4 });
  const show = addShow(movie, hall, soon(2 * DAY), { ticketPrice: 40000 });
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const admin = await signIn('boss', 'admin');
  return { movie, hall, show, ann, bob, admin };
}

// ---- 1. choosing seats holds them ----------------------------------------------------------
test('hold: booking only holds the seats until the customer pays', async () => {
  const { show, ann, bob, admin } = await setup();
  const res = await hold(ann, show, ['A1', 'A2']);
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'pending');
  assert.equal(res.data.paymentStatus, 'unpaid');
  assert.equal(res.data.totalAmount, 80000, 'the server works out the total');
  const left = new Date(res.data.holdExpiresAt).getTime() - Date.now();
  assert.ok(left > 4 * MIN && left <= 5 * MIN, `held for about five minutes (was ${left} ms)`);

  const map = await seatMap(show);
  assert.equal(statusOf(map, 'A1'), 'held');
  assert.equal(statusOf(map, 'A3'), 'available');
  const taken = await hold(bob, show, ['A2', 'A3']);
  assert.equal(taken.status, 409, 'someone else cannot take a held seat');
  assert.equal(claims.length, 2, 'the failed attempt left nothing behind');

  assert.equal((await call('GET', '/api/bookings/my', { session: ann })).data.length, 0, 'an unpaid hold is not a ticket');
  const adminList = await call('GET', '/api/bookings', { session: admin });
  assert.equal(adminList.data.length, 1, 'the admin can see it');
  assert.equal(adminList.data[0].status, 'pending');
  assert.equal((await call('GET', '/api/bookings?status=nonsense', { session: admin })).status, 400);
});

test('hold: starting over replaces the customer\'s own earlier hold', async () => {
  const { show, ann } = await setup();
  const first = await hold(ann, show, ['A1']);
  const second = await hold(ann, show, ['B1', 'B2']);
  assert.equal(second.status, 201);
  assert.equal(bookings.find((b) => String(b._id) === first.data._id).status, 'expired');
  assert.deepEqual(claims.map((c) => c.seatLabel).sort(), ['B1', 'B2']);
  assert.equal(statusOf(await seatMap(show), 'A1'), 'available');
});

// ---- 2. paying by card ---------------------------------------------------------------------
test('card: a successful payment confirms the booking and records the payment', async () => {
  const { show, ann } = await setup();
  const held = (await hold(ann, show, ['A1', 'A2'])).data;
  const done = await pay(ann, held, { ...VISA, amount: 1 }); // an amount sent by the browser is ignored
  assert.equal(done.status, 200);
  assert.equal(done.data.booking.status, 'confirmed');
  assert.equal(done.data.booking.paymentStatus, 'paid');
  assert.equal(held.paymentMode, 'simulated');
  assert.equal(done.data.booking.paymentMode, 'simulated');
  assert.equal(done.data.booking.payment.mode, 'simulated');
  assert.equal(done.data.booking.holdExpiresAt, null);
  assert.equal(done.data.booking.payment.method, 'card');
  assert.equal(done.data.booking.payment.cardBrand, 'Visa');
  assert.equal(done.data.booking.payment.cardLast4, '4242');
  assert.match(done.data.booking.payment.reference, /^PAY-[A-Z0-9]{8}$/);
  assert.equal(done.data.booking.payment.amount, 80000);
  assert.equal(payments.length, 1);
  assert.equal(statusOf(await seatMap(show), 'A1'), 'booked');
  assert.equal((await call('GET', '/api/bookings/my', { session: ann })).data.length, 1);

  const stored = JSON.stringify(payments) + JSON.stringify(bookings);
  assert.ok(!stored.includes('4242424242424242') && !stored.includes('4242 4242'), 'the full card number is never stored');
  assert.ok(!stored.includes('"123"') && !stored.includes('cvc'), 'the security code is never stored');

  const again = await pay(ann, held, VISA);
  assert.equal(again.status, 200, 'pressing Pay twice');
  assert.equal(payments.length, 1, 'is never charged twice');
});

test('card: a refused card keeps the hold so the customer can try again', async () => {
  const { show, ann } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  const cases = [
    ['4000 0000 0000 0002', /declined/],
    ['4000000000009995', /insufficient funds/],
    ['4000000000000069', /expired/],
    ['4000000000000127', /security code/],
    ['4000000000000119', /processing your card/],
  ];
  for (const [number, message] of cases) {
    const res = await pay(ann, held, { ...VISA, number });
    assert.equal(res.status, 402, number);
    assert.match(res.data.message, message, number);
  }
  assert.equal(payments.length, cases.length);
  assert.ok(payments.every((p) => p.status === 'failed' && p.failureMessage));
  const booking = bookings.find((b) => String(b._id) === held._id);
  assert.equal(booking.status, 'pending', 'still held');
  assert.equal(statusOf(await seatMap(show), 'A1'), 'held');

  const retry = await pay(ann, held, { ...VISA, number: '5555 5555 5555 4444' });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.booking.payment.cardBrand, 'Mastercard');
  assert.equal(booking.status, 'confirmed');
});

test('card: bad details are 400 and no payment is created', async () => {
  const { show, ann } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  const bad = [
    [{ number: '4242 4242 4242 4241' }, 'number'],
    [{ number: '1234' }, 'number'],
    [{ expiry: '01/20' }, 'expiry'],
    [{ expiry: '13/30' }, 'expiry'],
    [{ expiry: 'soon' }, 'expiry'],
    [{ cvc: '12' }, 'cvc'],
    [{ cvc: 'abc' }, 'cvc'],
    [{ method: 'cheque' }, 'method'],
    [{ method: undefined }, 'method'],
    [{ method: 'gcash', mobile: '12345' }, 'mobile'],
  ];
  for (const [change, field] of bad) {
    const res = await pay(ann, held, { ...VISA, ...change });
    assert.equal(res.status, 400, JSON.stringify(change));
    assert.ok(res.data.errors?.[field], `${field} named in ${JSON.stringify(change)}`);
  }
  assert.equal(payments.length, 0);
  assert.equal(bookings[0].status, 'pending');
  assert.equal((await pay(ann, held, { ...VISA, number: '378282246310005', cvc: '123' })).status, 400, 'American Express needs 4 digits');
  assert.equal((await pay(ann, held, { ...VISA, number: '378282246310005', cvc: '1234' })).status, 200);
});

// ---- 3. wallets ----------------------------------------------------------------------------
test('wallet: the payment waits for approval, and declining keeps the hold', async () => {
  const { show, ann, bob } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  const start = await pay(ann, held, { method: 'gcash', mobile: '0917 123 4567' });
  assert.equal(start.status, 202);
  assert.equal(start.data.awaitingApproval, true);
  assert.equal(start.data.payment.status, 'awaiting_approval');
  assert.equal(start.data.payment.walletLast4, '4567');
  assert.equal(start.data.payment.mode, 'simulated');
  assert.ok(!JSON.stringify(payments).includes('09171234567') && !JSON.stringify(payments).includes('0917 123 4567'), 'the wallet number is never stored');
  assert.equal(bookings[0].status, 'pending', 'not confirmed until approved');
  const paymentId = start.data.payment._id;

  assert.equal((await call('POST', `/api/payments/${paymentId}/authorize`, { session: bob, body: { approve: true } })).status, 404, 'not someone else\'s');
  assert.equal((await call('POST', `/api/payments/${paymentId}/authorize`, { session: ann, body: { approve: 'yes' } })).status, 400);
  const declined = await call('POST', `/api/payments/${paymentId}/authorize`, { session: ann, body: { approve: false } });
  assert.equal(declined.status, 402);
  assert.match(declined.data.message, /declined in GCash/);
  assert.equal(bookings[0].status, 'pending');
  assert.equal((await call('POST', `/api/payments/${paymentId}/authorize`, { session: ann, body: { approve: true } })).status, 409, 'a finished payment cannot be approved later');

  const second = await pay(ann, held, { method: 'maya', mobile: '+639171234567' });
  assert.equal(second.status, 202);
  const approved = await call('POST', `/api/payments/${second.data.payment._id}/authorize`, { session: ann, body: { approve: true } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.booking.status, 'confirmed');
  assert.equal(approved.data.booking.payment.method, 'maya');
  assert.equal(payments.filter((p) => p.status === 'paid').length, 1);
});

test('wallet: a newer payment replaces an unfinished one', async () => {
  const { show, ann } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  const first = await pay(ann, held, { method: 'gcash', mobile: '09171234567' });
  await pay(ann, held, { method: 'maya', mobile: '09171234567' });
  assert.equal(payments.find((p) => String(p._id) === first.data.payment._id).status, 'failed');
  assert.equal(payments.filter((p) => p.status === 'awaiting_approval').length, 1);
});

// ---- 4. holds run out ----------------------------------------------------------------------
test('expiry: an unpaid hold releases its seats and cannot be paid any more', async () => {
  const { show, ann, bob } = await setup();
  const held = (await hold(ann, show, ['A1', 'A2'])).data;
  bookings[0].holdExpiresAt = new Date(Date.now() - 1000); // five minutes have passed

  const map = await seatMap(show);
  assert.equal(statusOf(map, 'A1'), 'available', 'the seat map frees expired seats');
  assert.equal(bookings[0].status, 'expired');
  assert.equal(claims.length, 0);

  const late = await pay(ann, held, VISA);
  assert.equal(late.status, 409);
  assert.match(late.data.message, /payment time ran out/);
  assert.equal(payments.length, 0, 'nothing is charged');
  assert.equal((await hold(bob, show, ['A1', 'A2'])).status, 201, 'someone else can now have them');
});

test('expiry: paying exactly as the hold runs out is refused and charges nothing', async () => {
  const { show, ann } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  bookings[0].holdExpiresAt = new Date(Date.now() - 1);
  const res = await pay(ann, held, VISA);
  assert.equal(res.status, 409);
  assert.equal(bookings[0].status, 'expired');
  assert.equal(payments.length, 0);
});

test('expiry: a new booking clears expired holds first, and a wallet payment left open is closed', async () => {
  const { show, ann, bob } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  const wallet = await pay(ann, held, { method: 'gcash', mobile: '09171234567' });
  bookings[0].holdExpiresAt = new Date(Date.now() - 1000);
  assert.equal((await hold(bob, show, ['A1'])).status, 201);
  assert.equal(payments.find((p) => String(p._id) === wallet.data.payment._id).status, 'failed');
});

test('release: giving up a hold frees the seats at once', async () => {
  const { show, ann, bob } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  assert.equal((await call('POST', `/api/bookings/${held._id}/release`, { session: bob })).status, 404, 'not someone else\'s');
  const released = await call('POST', `/api/bookings/${held._id}/release`, { session: ann });
  assert.equal(released.status, 200);
  assert.equal(released.data.status, 'expired');
  assert.equal(statusOf(await seatMap(show), 'A1'), 'available');
  assert.equal((await call('POST', `/api/bookings/${held._id}/release`, { session: ann })).status, 200, 'repeating is harmless');
  assert.equal((await pay(ann, held, VISA)).status, 409);

  const paid = (await hold(ann, show, ['B1'])).data;
  await pay(ann, paid, VISA);
  assert.equal((await call('POST', `/api/bookings/${paid._id}/release`, { session: ann })).status, 409, 'a paid booking is cancelled, not released');
});

// ---- 5. security ---------------------------------------------------------------------------
test('security: only the owner can pay, and only signed-in customers', async () => {
  const { show, ann, bob } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  assert.equal((await call('POST', `/api/bookings/${held._id}/pay`, { body: VISA })).status, 401);
  assert.equal((await pay(bob, held, VISA)).status, 404, 'someone else\'s booking looks like it does not exist');
  assert.equal((await call('POST', '/api/bookings/not-an-id/pay', { session: ann, body: VISA })).status, 404);
  assert.equal((await call('POST', '/api/payments/not-an-id/authorize', { session: ann, body: { approve: true } })).status, 404);
  assert.equal(payments.length, 0);
});

// ---- 6. refunds ----------------------------------------------------------------------------
test('refund: cancelling a paid booking refunds the payment and frees the seats', async () => {
  const { show, ann } = await setup();
  const held = (await hold(ann, show, ['A1', 'A2'])).data;
  await pay(ann, held, VISA);
  const cancelled = await call('PATCH', `/api/bookings/${held._id}/cancel`, { session: ann });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.paymentStatus, 'refunded');
  assert.equal(cancelled.data.payment.status, 'refunded');
  assert.match(cancelled.data.payment.refundReference, /^RF-[A-Z0-9]{8}$/);
  assert.ok(cancelled.data.payment.refundedAt);
  assert.equal(claims.length, 0);
  assert.equal(statusOf(await seatMap(show), 'A1'), 'available');
  const again = await call('PATCH', `/api/bookings/${held._id}/cancel`, { session: ann });
  assert.equal(again.status, 200);
  assert.equal(payments.filter((p) => p.status === 'refunded').length, 1, 'refunded once');
});

test('refund: cancelling an unpaid hold is not a refund', async () => {
  const { show, ann } = await setup();
  const held = (await hold(ann, show, ['A1'])).data;
  const res = await call('PATCH', `/api/bookings/${held._id}/cancel`, { session: ann });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'expired');
  assert.equal(claims.length, 0);
  assert.equal(payments.length, 0);
});

test('refund: cancelling a showing refunds every paid booking and releases unpaid holds', async () => {
  const { show, ann, bob, admin } = await setup();
  const a = (await hold(ann, show, ['A1'])).data;
  await pay(ann, a, VISA);
  const b = (await hold(bob, show, ['B1'])).data;
  await pay(bob, b, { method: 'card', number: '5555555555554444', expiry: '01/40', cvc: '999' });
  const pending = await signIn('cy');
  const c = (await hold(pending, show, ['C1'])).data;

  const res = await call('PATCH', `/api/showtimes/${show._id}/cancel`, { session: admin });
  assert.equal(res.status, 200);
  assert.equal(res.data.cancelledBookings, 2);
  assert.deepEqual(bookings.map((x) => x.status).sort(), ['cancelled', 'cancelled', 'expired']);
  assert.equal(payments.filter((p) => p.status === 'refunded').length, 2);
  assert.equal(claims.length, 0);
  assert.equal(bookings.find((x) => String(x._id) === c._id).status, 'expired');
});

// ---- 7. the rest of the system -------------------------------------------------------------
test('bookings made before payments existed count as paid', async () => {
  const { movie, hall, ann } = await setup();
  const show = addShow(movie, hall, soon(3 * DAY));
  const old = addBooking(show, ann.user);
  const mine = await call('GET', '/api/bookings/my', { session: ann });
  assert.equal(mine.data.find((b) => b._id === String(old._id)).paymentStatus, 'paid');
  assert.equal(mine.data[0].payment, null);
});

test('PAYMENT_REQUIRED=false confirms a booking at once, as before', async () => {
  const { show, ann } = await setup();
  process.env.PAYMENT_REQUIRED = 'false';
  try {
    const res = await hold(ann, show, ['A1']);
    assert.equal(res.status, 201);
    assert.equal(res.data.status, 'confirmed');
    assert.equal(res.data.holdExpiresAt, null);
  } finally {
    delete process.env.PAYMENT_REQUIRED;
  }
});

test('revenue only counts paid bookings', async () => {
  const { show, ann, admin } = await setup();
  const held = (await hold(ann, show, ['A1', 'A2'])).data;
  const today = manilaDay(new Date());
  const revenue = async () => (await call('GET', `/api/admin/stats?from=${today}&to=${today}`, { session: admin })).data.revenue ?? (await call('GET', `/api/admin/stats?from=${today}&to=${today}`, { session: admin })).data;
  const before = JSON.stringify(await revenue());
  await pay(ann, held, VISA);
  const after = JSON.stringify(await revenue());
  assert.notEqual(before, after, 'the sale shows up only once it is paid');
  assert.match(after, /80000/);
});
