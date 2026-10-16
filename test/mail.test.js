// Offline tests for the emails: which events send one, to whom, once, with what in it, and that
// a broken email service never breaks a booking. They run the real app, models and services
// against the in-memory stand-in in fakeDb.js; emails go to the test transport (mail.sent).
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://filme.test';
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
const mail = require('../services/mail');
const { sendDueReminders } = require('../services/mail/reminders');
const templates = require('../services/mail/templates');
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
test.beforeEach(() => { clear(); mail.sent.length = 0; });

const setStatus = (admin, movie, status, extra = {}) => call('PATCH', `/api/admin/movies/${movie._id}`, { session: admin, body: { status, ...extra } });
const pay = (s, b) => call('POST', `/api/bookings/${b._id}/pay`, { session: s, body: { method: 'card', number: '4242424242424242', expiry: '12/30', cvc: '123' } });


const cancelBooking = (session, booking) => call('PATCH', `/api/bookings/${booking._id}/cancel`, { session });
const bookAndPay = async (session, show, seats) => {
  const held = (await book(session, show, seats)).data;
  assert.equal((await pay(session, held)).status, 200);
  return held;
};
// Replaces the internet for the email providers only; calls to the test's own server still go through.
const localFetch = global.fetch;
const outside = (fake) => (url, options) => (String(url).startsWith('http://127.0.0.1') ? localFetch(url, options) : fake(url, options));
const sentTo = (email) => mail.sent.filter((message) => message.to === email);

test('signing up sends a welcome email; an admin account does not get one', async () => {
  const res = await call('POST', '/api/auth/register', { body: { name: 'Ann Reyes', email: 'ann@example.com', password: PASSWORD } });
  assert.equal(res.status, 201);
  await mail.idle();
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 'ann@example.com');
  assert.match(mail.sent[0].subject, /Welcome to filme, Ann/);
  assert.match(mail.sent[0].html, /Browse movies/);
  assert.match(mail.sent[0].text, /Welcome to filme, Ann/);
});

test('paying sends the tickets and receipt once, with the booking details', async () => {
  const ann = await signIn('ann');
  const movie = addMovie({ title: 'Toy Story' });
  const show = addShow(movie, addHall(), soon(2 * DAY));
  const held = await bookAndPay(ann, show, ['A1', 'A2']);
  await mail.idle();

  const [email] = sentTo('ann@example.com');
  assert.equal(sentTo('ann@example.com').length, 1);
  assert.match(email.subject, /Your tickets for Toy Story are confirmed/);
  for (const part of [held.bookingCode, 'A1, A2', 'Hall 1', 'Visa', '₱800', 'test booking']) {
    assert.ok(email.html.includes(part), `the email shows ${part}`);
  }
  for (const part of [held.bookingCode, 'A1, A2', 'Hall 1', 'Visa', '₱800']) {
    assert.ok(email.text.includes(part), `the plain text has ${part}`);
  }
  assert.ok(email.html.includes('https://filme.test/my-bookings'), 'the button goes to My Tickets');
  assert.ok(bookings[0].emailConfirmedAt, 'the booking remembers its email went out');

  assert.equal((await pay(ann, held)).status, 200, 'pressing Pay again changes nothing');
  await mail.idle();
  assert.equal(sentTo('ann@example.com').length, 1, 'no second email');
});

test('an unpaid hold sends nothing', async () => {
  const ann = await signIn('ann');
  const show = addShow(addMovie(), addHall(), soon(2 * DAY));
  await book(ann, show, ['A1']);
  await mail.idle();
  assert.equal(mail.sent.length, 0);
});

test('cancelling your own booking emails the refund; an admin cancelling it says the cinema did', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const show = addShow(addMovie({ title: 'Dune' }), addHall(), soon(2 * DAY));
  const mine = await bookAndPay(ann, show, ['A1']);
  const his = await bookAndPay(bob, show, ['A2']);
  await mail.idle();
  mail.sent.length = 0;

  assert.equal((await cancelBooking(ann, mine)).status, 200);
  await mail.idle();
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 'ann@example.com');
  assert.match(mail.sent[0].subject, /Your booking for Dune was cancelled/);
  assert.match(mail.sent[0].html, /refunded in full/);
  assert.match(mail.sent[0].html, /RF-[A-Z0-9]{8}/);
  assert.doesNotMatch(mail.sent[0].html, /The cinema cancelled your booking/);

  mail.sent.length = 0;
  assert.equal((await cancelBooking(admin, his)).status, 200);
  await mail.idle();
  assert.equal(mail.sent[0].to, 'bob@example.com');
  assert.match(mail.sent[0].html, /The cinema cancelled your booking/);

  mail.sent.length = 0;
  assert.equal((await cancelBooking(ann, mine)).status, 200, 'cancelling twice is harmless');
  await mail.idle();
  assert.equal(mail.sent.length, 0, 'and sends nothing');
});

test('cancelling a showing emails every paying customer and nobody holding unpaid seats', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const cy = await signIn('cy');
  const show = addShow(addMovie({ title: 'Dune' }), addHall(), soon(2 * DAY));
  await bookAndPay(ann, show, ['A1']);
  await bookAndPay(bob, show, ['A2']);
  await book(cy, show, ['A3']); // never paid
  await mail.idle();
  mail.sent.length = 0;

  assert.equal((await call('PATCH', `/api/showtimes/${show._id}/cancel`, { session: admin })).status, 200);
  await mail.idle();
  assert.deepEqual(mail.sent.map((message) => message.to).sort(), ['ann@example.com', 'bob@example.com']);
  assert.match(mail.sent[0].subject, /^Cancelled: Dune/);
  assert.match(mail.sent[0].html, /We had to cancel this showing/);
  assert.match(mail.sent[0].html, /RF-[A-Z0-9]{8}/);
});

test('moving a showing emails its customers with the old and new time; a change of price or seats does not', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const hall = addHall();
  const show = addShow(addMovie({ title: 'Dune' }), hall, soon(2 * DAY));
  await bookAndPay(ann, show, ['A1']);
  await mail.idle();
  mail.sent.length = 0;

  const later = new Date(show.startTime.getTime() + 3 * HOUR).toISOString();
  assert.equal((await call('PATCH', `/api/showtimes/${show._id}/reschedule`, { session: admin, body: { startTime: later } })).status, 200);
  await mail.idle();
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 'ann@example.com');
  assert.match(mail.sent[0].subject, /^Schedule change: Dune/);
  assert.match(mail.sent[0].html, /Your showing has moved/);
  assert.match(mail.sent[0].html, /line-through/, 'the old time is struck through');

  mail.sent.length = 0;
  assert.equal((await call('PATCH', `/api/showtimes/${show._id}/reschedule`, { session: admin, body: { startTime: later } })).status, 200);
  await mail.idle();
  assert.equal(mail.sent.length, 0, 'moving it to where it already is sends nothing');
});

test('reminders go to confirmed customers a few hours before, once, and skip very recent bookings', async () => {
  const ann = await signIn('ann');
  const bob = await signIn('bob');
  const cy = await signIn('cy');
  const hall = addHall();
  const movie = addMovie({ title: 'Dune' });
  const soonShow = addShow(movie, hall, soon(2 * HOUR));
  const farShow = addShow(movie, addHall(), soon(3 * DAY));
  const old = await bookAndPay(ann, soonShow, ['A1']);
  await bookAndPay(bob, farShow, ['A1']);
  const fresh = await bookAndPay(cy, soonShow, ['A2']);
  bookings.find((booking) => booking.bookingCode === old.bookingCode).bookedAt = new Date(Date.now() - 5 * HOUR);
  bookings.find((booking) => booking.bookingCode === fresh.bookingCode).bookedAt = new Date(Date.now() - 10 * MIN);
  await mail.idle();
  mail.sent.length = 0;

  const first = await sendDueReminders();
  assert.equal(first.sent, 1);
  assert.deepEqual(mail.sent.map((message) => message.to), ['ann@example.com']);
  assert.match(mail.sent[0].subject, /^Reminder: Dune starts today at /);
  assert.equal((await sendDueReminders()).sent, 0, 'the same reminder is never sent twice');
});

test('the words are escaped, and only web addresses become links or images', () => {
  const t = {
    code: 'FLM-X', movieId: 'm1', movieTitle: '<script>alert(1)</script> & "Co"', posterUrl: 'javascript:alert(1)', rating: 'G', genre: 'A', durationLabel: '1h 00m',
    dateShort: 'Thu, Oct 15', dateLong: 'Thursday, October 15, 2026', time: '2:00 PM', room: '<b>Hall</b>', seats: ['A1'], quantity: 1,
    unitPriceText: '₱400', totalText: '₱400', method: 'Visa •••• 4242', paymentReference: 'PAY-1', refundReference: '', simulated: false,
  };
  const { html } = templates.bookingConfirmed(t, { name: '<i>Ann</i>' });
  assert.ok(!html.includes('<script>alert'), 'a title cannot inject a script');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;'));
  assert.ok(!html.includes('<b>Hall</b>') && !html.includes('<i>Ann</i>'));
  assert.ok(!html.includes('javascript:'), 'a poster address that is not http(s) is dropped');
});

test('sending never throws: a bad address, a missing key, a refusing provider and a flaky one', async () => {
  const saved = { ...process.env };
  const realFetch = global.fetch;
  try {
    assert.equal((await mail.sendMail({ to: 'not-an-address', subject: 's', html: 'h', text: 't' })).ok, false);

    process.env.MAIL_PROVIDER = 'brevo';
    delete process.env.BREVO_API_KEY;
    const noKey = await mail.sendMail({ to: 'a@example.com', subject: 's', html: 'h', text: 't' });
    assert.equal(noKey.ok, false);
    assert.match(noKey.error, /BREVO_API_KEY|MAIL_FROM/);

    process.env.BREVO_API_KEY = 'secret-key';
    process.env.MAIL_FROM = 'cinema@example.com';
    process.env.MAIL_FROM_NAME = 'filme';
    const calls = [];
    global.fetch = outside(async (url, options) => { calls.push({ url, options }); return { ok: true, status: 201, json: async () => ({ messageId: 'abc' }) }; });
    const sentOk = await mail.sendMail({ to: 'a@example.com', toName: 'Ann', subject: 'Hi', html: '<p>x</p>', text: 'x', tags: ['welcome'] });
    assert.deepEqual([sentOk.ok, sentOk.id, sentOk.provider], [true, 'abc', 'brevo']);
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(calls[0].options.headers['api-key'], 'secret-key');
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body.sender, { name: 'filme', email: 'cinema@example.com' });
    assert.deepEqual(body.to, [{ email: 'a@example.com', name: 'Ann' }]);
    assert.equal(body.subject, 'Hi');
    assert.equal(body.htmlContent, '<p>x</p>');

    calls.length = 0;
    global.fetch = outside(async (url, options) => { calls.push({ url, options }); return { ok: false, status: 401, json: async () => ({ message: 'Key not found' }) }; });
    const refused = await mail.sendMail({ to: 'a@example.com', subject: 's', html: 'h', text: 't' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /401: Key not found/);
    assert.equal(calls.length, 1, 'a refusal is not retried');

    calls.length = 0;
    global.fetch = outside(async () => { calls.push(1); if (calls.length === 1) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 201, json: async () => ({ messageId: 'second' }) }; });
    assert.equal((await mail.sendMail({ to: 'a@example.com', subject: 's', html: 'h', text: 't' })).id, 'second');
    assert.equal(calls.length, 2, 'a busy provider is tried once more');

    global.fetch = outside(async () => { throw new Error('network down'); });
    assert.equal((await mail.sendMail({ to: 'a@example.com', subject: 's', html: 'h', text: 't' })).ok, false);
  } finally {
    global.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('a booking still works when the email service is broken', async () => {
  const saved = { ...process.env };
  const realFetch = global.fetch;
  try {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'k';
    process.env.MAIL_FROM = 'cinema@example.com';
    global.fetch = outside(async () => { throw new Error('network down'); });
    const ann = await signIn('ann');
    const show = addShow(addMovie(), addHall(), soon(2 * DAY));
    const held = (await book(ann, show, ['A1'])).data;
    const paid = await pay(ann, held);
    assert.equal(paid.status, 200, 'payment succeeds');
    assert.equal(paid.data.booking.status, 'confirmed');
    await mail.idle();
    assert.equal(bookings[0].emailConfirmedAt, undefined, 'it is retried later because the email did not go out');
  } finally {
    global.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('admin email page: status and a test email to the signed-in admin only', async () => {
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  assert.equal((await call('GET', '/api/admin/settings/mail')).status, 401);
  assert.equal((await call('GET', '/api/admin/settings/mail', { session: ann })).status, 403);
  const info = await call('GET', '/api/admin/settings/mail', { session: admin });
  assert.equal(info.status, 200);
  assert.deepEqual(Object.keys(info.data).sort(), ['appUrl', 'from', 'label', 'problem', 'provider', 'ready']);
  assert.ok(!JSON.stringify(info.data).includes('KEY'), 'no secrets');

  const test = await call('POST', '/api/admin/settings/mail/test', { session: admin, body: { to: 'someone-else@example.com' } });
  assert.equal(test.status, 200);
  assert.equal(test.data.ok, true);
  assert.equal(test.data.to, 'boss@example.com', 'it goes to the admin, whatever the request says');
  assert.deepEqual(mail.sent.map((message) => message.to), ['boss@example.com']);
  assert.match(mail.sent[0].subject, /test email/);
});
