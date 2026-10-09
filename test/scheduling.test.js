// Offline tests for the admin's schedule controls: the turnaround gap, scheduling many showings,
// copying a day, the sales cutoff, blocked seats, moving a booked showing, and hiding a showing.
// They run the real app, models and services against the in-memory stand-in in fakeDb.js.
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

// ---- the rules (settings) -------------------------------------------------------------------
test('settings: defaults, admin only, validated, and saved', async () => {
  const admin = await signIn('boss', 'admin');
  const customer = await signIn('ann');
  assert.equal((await call('GET', '/api/admin/settings')).status, 401);
  assert.equal((await call('GET', '/api/admin/settings', { session: customer })).status, 403);
  assert.equal((await setRules(customer, { turnaroundMinutes: 5 })).status, 403);

  assert.deepEqual((await call('GET', '/api/admin/settings', { session: admin })).data, { turnaroundMinutes: 15, salesCutoffMinutes: 15 });
  for (const bad of [{ turnaroundMinutes: -1 }, { turnaroundMinutes: 1.5 }, { salesCutoffMinutes: 'soon' }, { salesCutoffMinutes: 5000 }, { turnaroundMinutes: 241 }, {}, { nonsense: 1 }]) {
    assert.equal((await setRules(admin, bad)).status, 400, JSON.stringify(bad));
  }
  const saved = await setRules(admin, { turnaroundMinutes: 30 });
  assert.deepEqual(saved.data, { turnaroundMinutes: 30, salesCutoffMinutes: 15 }, 'the other rule keeps its value');
  await setRules(admin, { salesCutoffMinutes: 0 });
  assert.deepEqual((await call('GET', '/api/admin/settings', { session: admin })).data, { turnaroundMinutes: 30, salesCutoffMinutes: 0 });
  assert.equal(settings.length, 1, 'one settings record, however often it is saved');
});

// ---- turnaround gap -------------------------------------------------------------------------
test('turnaround: the gap between shows is enforced when creating and editing', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const make = (offsetMin) => call('POST', '/api/showtimes', {
    session: admin,
    body: { movie: String(movie._id), auditorium: String(hall._id), startTime: new Date(Date.parse(`${day(3)}T10:00:00+08:00`) + offsetMin * MIN).toISOString(), ticketPrice: 40000 },
  });

  assert.equal((await make(0)).status, 201); // 10:00-12:00, and the default gap is 15 minutes
  const tooClose = await make(120 + 5); // starts 5 minutes after it ends
  assert.equal(tooClose.status, 409);
  assert.match(tooClose.data.message, /too close .* 15 minutes between shows/);
  const after = await make(120 + 15);
  assert.equal(after.status, 201, 'exactly the gap is allowed');
  assert.equal((await make(-120 - 10)).status, 409, 'the gap also applies before a show');
  assert.equal((await make(60)).status, 409);
  assert.match((await make(60)).data.message, /overlaps/, 'a real overlap keeps its own message');

  // editing a showing is held to the same rule
  const edited = await call('PATCH', `/api/showtimes/${after.data._id}`, { session: admin, body: { startTime: new Date(Date.parse(`${day(3)}T10:00:00+08:00`) + 125 * MIN).toISOString() } });
  assert.equal(edited.status, 409);

  await setRules(admin, { turnaroundMinutes: 0 });
  assert.equal((await make(-120)).status, 201, 'with no gap set, back-to-back is allowed');
});

// ---- scheduling many showings ---------------------------------------------------------------
const bulkBody = (movie, hall, extra = {}) => ({
  movie: String(movie._id), auditorium: String(hall._id), startDate: day(2), endDate: day(4), times: ['14:00', '10:00'], ticketPrice: 30000, ...extra,
});

test('bulk: one movie, several days and times, all in cinema time', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  assert.equal((await call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall) })).status, 401);
  assert.equal((await call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall), session: await signIn('ann') })).status, 403);

  const res = await call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall, { published: false }), session: admin });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.createdCount, 6);
  assert.equal(res.data.skippedCount, 0);
  assert.equal(showtimes.length, 6);
  assert.deepEqual([...new Set(showtimes.map((s) => manilaClock(s.startTime)))].sort(), ['10:00', '14:00']);
  assert.deepEqual([...new Set(showtimes.map((s) => manilaDay(s.startTime)))].sort(), [day(2), day(3), day(4)]);
  assert.ok(showtimes.every((s) => s.ticketPrice === 30000 && s.isPublished === false && s.status === 'scheduled'));
  assert.ok(showtimes.every((s) => s.endTime - s.startTime === 120 * MIN), 'end times come from the movie length');
});

test('bulk: weekday filter, a dry run writes nothing, limits and bad input are 400', async () => {
  const movie = addMovie();
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const post = (extra) => call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall, extra), session: admin });

  const target = atManila(day(3), '12:00');
  const weekday = new Date(target.getTime() + 4 * HOUR).getUTCDay() === 0 ? 0 : new Date(`${day(3)}T12:00:00+08:00`).getUTCDay();
  const only = await post({ weekdays: [weekday], times: ['10:00'] });
  assert.equal(only.status, 201);
  assert.deepEqual(showtimes.map((s) => manilaDay(s.startTime)), [day(3)], 'only the chosen weekday is scheduled');

  const before = showtimes.length;
  const dry = await post({ dryRun: true, startDate: day(10), endDate: day(11) });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.createdCount, 4, 'the plan lists what would be created');
  assert.equal(showtimes.length, before, 'and nothing was saved');

  for (const bad of [
    { times: [] }, { times: ['25:00'] }, { times: ['10:00', '10:00'] }, { times: '10:00' },
    { startDate: 'soon' }, { endDate: day(1) }, { endDate: day(40) }, { weekdays: [7] }, { weekdays: 'mon' },
    { ticketPrice: 400.5 }, { ticketPrice: -1 }, { published: 'yes' }, { dryRun: 1 },
    { movie: 'nope' }, { auditorium: 'nope' },
  ]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  const many = await post({ endDate: day(30), times: Array.from({ length: 10 }, (_, i) => `${String(8 + i).padStart(2, '0')}:00`) });
  assert.equal(many.status, 400, 'more than 200 showings in one go is refused');
  assert.equal((await post({ movie: String(movie._id).replace(/./, '0') })).status, 400, 'an unknown movie is a 400, not a skipped slot');
  addMovie({ title: 'Draft', status: 'draft' });
  assert.equal((await post({ movie: String(movies[1]._id) })).status, 400, 'only published movies can be scheduled');
});

test('bulk: a clash fails the whole request unless skipConflicts is set', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  addShow(movie, hall, atManila(day(3), '10:30')); // sits on day 3's 10:00 slot
  const before = showtimes.length;

  const strict = await call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall), session: admin });
  assert.equal(strict.status, 409);
  assert.match(strict.data.message, /1 of 6 showings cannot be scheduled, so none were saved/);
  assert.equal(Object.keys(strict.data.errors).length, 1, 'the clashing slot is named');
  assert.equal(showtimes.length, before, 'nothing was saved');

  const plan = await call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall, { dryRun: true }), session: admin });
  assert.equal(plan.status, 200, 'a dry run reports clashes instead of failing');
  assert.equal(plan.data.skippedCount, 1);
  assert.equal(plan.data.createdCount, 5);
  assert.equal(showtimes.length, before);

  const lenient = await call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall, { skipConflicts: true }), session: admin });
  assert.equal(lenient.status, 201);
  assert.equal(lenient.data.createdCount, 5);
  assert.equal(lenient.data.skippedCount, 1);
  assert.match(lenient.data.skipped[0].reason, /overlaps/);
  assert.equal(showtimes.length, before + 5);
});

test('bulk: the turnaround gap also applies between slots of the same request, and the past is skipped', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const res = await call('POST', '/api/showtimes/bulk', {
    body: bulkBody(movie, hall, { startDate: day(2), endDate: day(2), times: ['10:00', '12:05', '14:00'], skipConflicts: true }), session: admin,
  });
  assert.equal(res.data.createdCount, 2);
  assert.deepEqual(showtimes.map((s) => manilaClock(s.startTime)).sort(), ['10:00', '14:00']);
  assert.match(res.data.skipped[0].reason, /same request/);

  const past = await call('POST', '/api/showtimes/bulk', {
    body: bulkBody(movie, hall, { startDate: day(-2), endDate: day(-2), times: ['10:00'], skipConflicts: true }), session: admin,
  });
  assert.equal(past.data.createdCount, 0);
  assert.match(past.data.skipped[0].reason, /already passed/);
});

test('bulk: two admins scheduling the same room at once - the later one re-checks and loses', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  let fired = false;
  transactionHook = () => {
    if (fired) return false;
    fired = true;
    addShow(movie, hall, atManila(day(2), '10:00')); // the other admin's showing commits first
    return true;
  };
  const res = await call('POST', '/api/showtimes/bulk', { body: bulkBody(movie, hall, { startDate: day(2), endDate: day(2), times: ['10:00'] }), session: admin });
  assert.equal(res.status, 409);
  assert.equal(showtimes.length, 1, 'only the first showing exists');
});

// ---- copying a day --------------------------------------------------------------------------
test('copy day: same movies, rooms, clock times and prices on other days', async () => {
  const movie = addMovie({ duration: 100 });
  const other = addMovie({ title: 'Heat', duration: 90 });
  const hallA = addHall();
  const hallB = addHall();
  const admin = await signIn('boss', 'admin');
  addShow(movie, hallA, atManila(day(2), '10:00'), { ticketPrice: 25000 });
  addShow(other, hallB, atManila(day(2), '15:30'), { ticketPrice: 45000, isPublished: false });
  const post = (extra) => call('POST', '/api/showtimes/copy', { body: { fromDate: day(2), toDates: [day(3), day(4)], ...extra }, session: admin });

  const dry = await post({ dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.createdCount, 4);
  assert.equal(showtimes.length, 2);

  const res = await post();
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.createdCount, 4);
  const copies = showtimes.slice(2);
  assert.deepEqual(copies.map((s) => `${manilaDay(s.startTime)} ${manilaClock(s.startTime)} ${s.ticketPrice} ${s.isPublished}`).sort(), [
    `${day(3)} 10:00 25000 true`, `${day(3)} 15:30 45000 false`, `${day(4)} 10:00 25000 true`, `${day(4)} 15:30 45000 false`,
  ].sort(), 'a hidden showing is copied hidden unless told otherwise');

  const forced = await post({ toDates: [day(5)], published: true });
  assert.equal(forced.data.createdCount, 2);
  assert.ok(showtimes.slice(-2).every((s) => s.isPublished === true));
});

test('copy day: clashes, an empty day and bad input', async () => {
  const movie = addMovie({ duration: 100 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  addShow(movie, hall, atManila(day(2), '10:00'));
  addShow(movie, hall, atManila(day(3), '10:30')); // on top of the 10:00 copy for day 3
  const post = (extra) => call('POST', '/api/showtimes/copy', { body: { fromDate: day(2), toDates: [day(3), day(4)], ...extra }, session: admin });

  const before = showtimes.length;
  assert.equal((await post()).status, 409);
  assert.equal(showtimes.length, before, 'nothing was saved');
  const lenient = await post({ skipConflicts: true });
  assert.equal(lenient.data.createdCount, 1);
  assert.equal(lenient.data.skippedCount, 1);

  assert.equal((await post({ fromDate: day(8) })).status, 400, 'nothing to copy from that day');
  assert.equal((await post({ toDates: [day(2)] })).status, 400, 'a day cannot be copied onto itself');
  assert.equal((await post({ toDates: [] })).status, 400);
  assert.equal((await post({ toDates: [day(3), day(3)] })).status, 400);
  assert.equal((await post({ fromDate: 'x' })).status, 400);
  assert.equal((await post({ movie: 'nope' })).status, 400);
});

// ---- sales cutoff ---------------------------------------------------------------------------
test('sales cutoff: booking closes before the start, and closing showings leave the public list', async () => {
  const movie = addMovie();
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const closing = addShow(movie, hall, soon(10 * MIN)); // inside the default 15 minutes
  const open = addShow(movie, hall, soon(2 * HOUR));

  const refused = await book(ann, closing, ['A1']);
  assert.equal(refused.status, 409);
  assert.match(refused.data.message, /closed 15 minutes before it starts/);
  assert.equal((await book(ann, open, ['A1'])).status, 201);

  const listed = (await call('GET', '/api/showtimes')).data.map((s) => s._id);
  assert.deepEqual(listed, [String(open._id)], 'a showing that can no longer be booked is not offered');
  assert.equal((await call('GET', `/api/showtimes/${closing._id}/seats`)).data.showtime.bookable, false);
  assert.equal((await call('GET', `/api/showtimes/${open._id}/seats`)).data.showtime.bookable, true);

  await setRules(admin, { salesCutoffMinutes: 0 });
  assert.equal((await book(ann, closing, ['A1'])).status, 201, 'with no cutoff, booking is open until the start');
  assert.equal((await call('GET', '/api/showtimes')).data.length, 2);

  await setRules(admin, { salesCutoffMinutes: 180 });
  assert.equal((await book(ann, open, ['A2'])).status, 409, 'a longer cutoff closes it earlier');
});

// ---- blocked seats --------------------------------------------------------------------------
test('blocked seats: an auditorium can block seats; they cannot be booked and do not count', async () => {
  const movie = addMovie();
  const hall = addHall(); // A1 A2 A3 B1 B2 B3
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const show = addShow(movie, hall, soon(2 * DAY));
  const put = (seats, session = admin) => call('PUT', `/api/auditoriums/${hall._id}/blocked-seats`, { body: { seats }, session });

  assert.equal((await put(['A1'], ann)).status, 403);
  assert.equal((await call('PUT', `/api/auditoriums/${hall._id}/blocked-seats`, { body: { seats: ['A1'] } })).status, 401);
  for (const bad of [['Z9'], 'A1', [1], undefined]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));

  const blocked = await put(['b3', 'A1', 'A1']);
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.data.blockedSeats, ['A1', 'B3'], 'tidied, sorted, no duplicates');

  const seatMap = (await call('GET', `/api/showtimes/${show._id}/seats`)).data;
  assert.deepEqual(seatMap.seats.filter((seat) => seat.status === 'blocked').map((seat) => seat.label), ['A1', 'B3']);
  const listed = (await call('GET', '/api/showtimes')).data[0];
  assert.equal(listed.totalSeats, 4, 'blocked seats are not for sale');
  assert.equal(listed.remainingSeats, 4);

  const refused = await book(ann, show, ['A1', 'A2']);
  assert.equal(refused.status, 409);
  assert.match(refused.data.message, /cannot be booked: A1/);
  assert.equal(bookings.length, 0, 'the whole booking was refused');
  assert.equal((await book(ann, show, ['B1'])).status, 201);
  assert.equal((await call('GET', '/api/showtimes')).data[0].remainingSeats, 3);

  assert.equal((await put(['A1', 'B3', 'B1'])).status, 409, 'a seat a customer holds cannot be newly blocked');
  assert.deepEqual(auditoriums[0].blockedSeats, ['A1', 'B3'], 'and nothing changed');

  const open = await put([]);
  assert.deepEqual(open.data.blockedSeats, []);
  assert.equal((await book(ann, show, ['A1'])).status, 201, 'unblocked seats can be booked again');
});

test('blocked seats: one showing can block seats without touching others in the room', async () => {
  const movie = addMovie();
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const first = addShow(movie, hall, soon(2 * DAY));
  const second = addShow(movie, hall, soon(3 * DAY));
  const put = (show, seats, session = admin) => call('PUT', `/api/showtimes/${show._id}/blocked-seats`, { body: { seats }, session });

  assert.equal((await put(first, ['A2'], ann)).status, 403);
  assert.equal((await put(first, ['Z1'])).status, 400);
  assert.equal((await put(first, ['A2'])).status, 200);
  assert.equal((await book(ann, first, ['A2'])).status, 409);
  assert.equal((await book(ann, second, ['A2'])).status, 201, 'the other showing still sells A2');
  assert.equal((await put(second, ['A2'])).status, 409, 'but a held seat cannot be blocked there');

  const listed = (await call('GET', '/api/admin/showtimes', { session: admin })).data;
  assert.deepEqual(listed.find((s) => s._id === String(first._id)).blockedSeats, ['A2']);
  addShow(movie, hall, soon(-HOUR)); // a showing that has started
  assert.equal((await put(showtimes[2], ['A1'])).status, 409);
});

test('blocked seats: a booking that raced with a block is checked again and refused', async () => {
  const movie = addMovie();
  const hall = addHall();
  const ann = await signIn('ann');
  const show = addShow(movie, hall, soon(2 * DAY));
  transactionHook = (attempt) => {
    if (attempt !== 1) return false;
    showtimes[0].blockedSeats = ['A1']; // an admin blocks A1 and commits before the booking does
    return true;
  };
  const res = await book(ann, show, ['A1']);
  assert.equal(res.status, 409);
  assert.equal(bookings.length, 0);
  assert.equal(claims.length, 0);
});

test('blocked seats: changing a room layout drops blocked seats that no longer exist', async () => {
  const hall = new Auditorium({ name: 'Hall', rows: 2, seatsPerRow: 3, blockedSeats: ['A1', 'B3'] });
  await hall.validate();
  hall.rows = 1;
  await hall.validate();
  assert.deepEqual(hall.seatLabels, ['A1', 'A2', 'A3']);
  assert.deepEqual([...hall.blockedSeats], ['A1']);
});

// ---- moving a showing that already has bookings ---------------------------------------------
test('reschedule: bookings stay attached, and the move is recorded', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const original = soon(2 * DAY);
  const show = addShow(movie, hall, original);
  const booked = await book(ann, show, ['A1', 'A2']);
  assert.equal(booked.status, 201);

  assert.equal((await call('PATCH', `/api/showtimes/${show._id}`, { body: { ticketPrice: 1 }, session: admin })).status, 409, 'a plain edit is still locked');
  const move = await call('PATCH', `/api/showtimes/${show._id}/reschedule`, { body: { startTime: new Date(original.getTime() + 3 * HOUR).toISOString() }, session: admin });
  assert.equal(move.status, 200, JSON.stringify(move.data));
  assert.equal(new Date(move.data.endTime) - new Date(move.data.startTime), 120 * MIN);

  const mine = (await call('GET', '/api/bookings/my', { session: ann })).data[0];
  assert.equal(mine.status, 'confirmed');
  assert.deepEqual(mine.seats, ['A1', 'A2']);
  assert.equal(mine.totalAmount, 80000, 'the price paid is untouched');
  assert.equal(new Date(mine.showtime.startTime).getTime(), original.getTime() + 3 * HOUR, 'the customer sees the new time');
  assert.equal(new Date(mine.showtime.originalStartTime).getTime(), original.getTime());
  assert.ok(mine.showtime.rescheduledAt);
  assert.equal(claims.length, 2, 'the seats are still held');
});

test('reschedule: the new time must be free, in the future, and the showing must be movable', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const show = addShow(movie, hall, atManila(day(3), '10:00'));
  addShow(movie, hall, atManila(day(3), '14:00'));
  const move = (target, body, session = admin) => call('PATCH', `/api/showtimes/${target._id}/reschedule`, { body, session });

  assert.equal((await move(show, {})).status, 400);
  assert.equal((await move(show, { startTime: 'later' })).status, 400);
  assert.equal((await move(show, { auditorium: 'nope' })).status, 400);
  assert.equal((await move(show, { startTime: atManila(day(3), '15:00').toISOString() })).status, 409, 'overlaps the 14:00 show');
  assert.equal((await move(show, { startTime: atManila(day(3), '12:05').toISOString() })).status, 409, 'ends 14:05, overlapping the 14:00 show');
  assert.equal((await move(show, { startTime: atManila(day(3), '12:00').toISOString() })).status, 409, 'ends exactly when the 14:00 show starts, with no gap');
  assert.equal((await move(show, { startTime: atManila(day(3), '11:50').toISOString() })).status, 409, 'ends 13:50: only 10 minutes before the 14:00 show');
  assert.equal((await move(show, { startTime: atManila(day(3), '11:45').toISOString() })).status, 200, 'ends 13:45: exactly the 15 minute gap');
  assert.equal((await move(show, { startTime: atManila(day(-2), '10:00').toISOString() })).status, 400, 'the past');
  assert.equal((await move(show, { startTime: atManila(day(3), '11:00').toISOString() }, await signIn('ann'))).status, 403);
  assert.equal((await move(show, { startTime: atManila(day(3), '11:00').toISOString() })).status, 200, 'ends 13:00, a full 60 minutes before 14:00');
  assert.equal((await move(show, { startTime: atManila(day(3), '11:00').toISOString() })).status, 200, 'moving onto its own time is fine');

  const cancelled = addShow(movie, hall, atManila(day(5), '10:00'), { status: 'cancelled' });
  assert.equal((await move(cancelled, { startTime: atManila(day(5), '12:00').toISOString() })).status, 409);
  const started = addShow(movie, hall, soon(-HOUR));
  assert.equal((await move(started, { startTime: atManila(day(5), '18:00').toISOString() })).status, 409);
  assert.equal((await call('PATCH', '/api/showtimes/not-an-id/reschedule', { body: { startTime: atManila(day(5), '18:00').toISOString() }, session: admin })).status, 404);
});

test('reschedule: moving to another room needs every booked seat to exist and be open there', async () => {
  const movie = addMovie({ duration: 120 });
  const hall = addHall(); // A1 A2 A3 B1 B2 B3
  const tiny = addHall({ rows: 1, seatsPerRow: 2 }); // A1 A2
  const same = addHall();
  const blockedRoom = addHall({ blockedSeats: ['B3'] });
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const show = addShow(movie, hall, soon(2 * DAY));
  assert.equal((await book(ann, show, ['A1', 'B3'])).status, 201);
  const move = (room) => call('PATCH', `/api/showtimes/${show._id}/reschedule`, { body: { auditorium: String(room._id) }, session: admin });

  const tooSmall = await move(tiny);
  assert.equal(tooSmall.status, 409);
  assert.match(tooSmall.data.message, /cannot take these booked seats: B3/);
  assert.match((await move(blockedRoom)).data.message, /B3/);
  auditoriums[3].isActive = false;
  auditoriums[2].isActive = false;
  assert.equal((await move(same)).status, 400, 'an inactive room is refused');
  auditoriums[2].isActive = true;
  const moved = await move(same);
  assert.equal(moved.status, 200);
  assert.equal(String(showtimes[0].auditorium), String(same._id));
  assert.equal(claims.length, 2, 'the seats are still held');
});

// ---- hiding a showing -----------------------------------------------------------------------
test('visibility: a hidden showing cannot be seen or booked until it is shown', async () => {
  const movie = addMovie();
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const ann = await signIn('ann');
  const created = await call('POST', '/api/showtimes', {
    session: admin, body: { movie: String(movie._id), auditorium: String(hall._id), startTime: soon(2 * DAY).toISOString(), ticketPrice: 40000, published: false },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.isPublished, false);
  const id = created.data._id;
  const show = showtimes[0];

  assert.deepEqual((await call('GET', '/api/showtimes')).data, [], 'not in the public list');
  assert.equal((await call('GET', `/api/showtimes/${id}/seats`)).status, 404);
  assert.equal((await book(ann, show, ['A1'])).status, 404);
  const adminList = (await call('GET', '/api/admin/showtimes', { session: admin })).data;
  assert.equal(adminList[0].published, false, 'admins still see it, marked hidden');

  assert.equal((await call('PATCH', `/api/showtimes/${id}/visibility`, { body: { published: 'yes' }, session: admin })).status, 400);
  assert.equal((await call('PATCH', `/api/showtimes/${id}/visibility`, { body: { published: true }, session: ann })).status, 403);
  assert.equal((await call('PATCH', `/api/showtimes/${id}/visibility`, { body: { published: true }, session: admin })).status, 200);
  assert.equal((await call('GET', '/api/showtimes')).data.length, 1);
  assert.equal((await book(ann, show, ['A1'])).status, 201);

  const hide = await call('PATCH', `/api/showtimes/${id}/visibility`, { body: { published: false }, session: admin });
  assert.equal(hide.status, 409, 'customers hold tickets, so it cannot be hidden');
  assert.match(hide.data.message, /hold tickets/);
  assert.equal(showtimes[0].isPublished, true);

  const bookingId = bookings[0]._id;
  await call('PATCH', `/api/bookings/${bookingId}/cancel`, { session: ann });
  assert.equal((await call('PATCH', `/api/showtimes/${id}/visibility`, { body: { published: false }, session: admin })).status, 200, 'once no one holds a ticket it can be hidden');
});

test('visibility: a booking racing with hiding is checked again', async () => {
  const movie = addMovie();
  const hall = addHall();
  const admin = await signIn('boss', 'admin');
  const show = addShow(movie, hall, soon(2 * DAY));
  const ann = await signIn('ann');
  transactionHook = (attempt) => {
    if (attempt !== 1) return false;
    const booking = add(Booking, bookings, {
      bookingCode: 'FLM-RACE0001', user: ann.user._id, showtime: show._id, seats: ['B2'], unitPrice: 40000, totalAmount: 40000,
    });
    add(SeatClaim, claims, { showtime: show._id, seatLabel: 'B2', booking: booking._id });
    return true; // a customer's booking commits first
  };
  const res = await call('PATCH', `/api/showtimes/${show._id}/visibility`, { body: { published: false }, session: admin });
  assert.equal(res.status, 409);
  assert.equal(showtimes[0].isPublished, true);
});
