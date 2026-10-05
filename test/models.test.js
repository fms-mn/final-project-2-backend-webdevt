// Offline model tests: they exercise schema validation and hooks without a database.
// Run with: npm test --workspace=server   (or `npm run test:server` from the repo root)
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');

const id = () => new mongoose.Types.ObjectId();
const failedPaths = async (doc) => {
  try {
    await doc.validate();
    return [];
  } catch (error) {
    return Object.keys(error.errors);
  }
};

const validMovie = () => ({
  title: 'Test Movie',
  synopsis: 'A test.',
  genre: 'Drama',
  rating: 'PG',
  posterUrl: 'https://example.com/p.jpg',
  duration: 120,
  releaseDate: new Date('2030-01-01'),
});

test('User: required fields, defaults and normalisation', async () => {
  assert.deepEqual((await failedPaths(new User({}))).sort(), ['email', 'name', 'passwordHash']);
  const user = new User({ name: '  Ann ', email: ' ANN@Example.COM ', passwordHash: 'x' });
  assert.deepEqual(await failedPaths(user), []);
  assert.equal(user.role, 'user');
  assert.equal(user.isActive, true);
  assert.equal(user.email, 'ann@example.com');
  assert.equal(user.name, 'Ann');
  assert.deepEqual(await failedPaths(new User({ name: ' ', email: 'a@b.c', passwordHash: 'x' })), ['name']);
  assert.deepEqual(await failedPaths(new User({ name: 'A', email: 'a@b.c', passwordHash: 'x', role: 'root' })), ['role']);
});

test('User: phone stays a string and passwordHash never serialises', () => {
  const user = new User({ name: 'A', email: 'a@b.c', passwordHash: 'secret-hash', phone: '09171234567' });
  assert.equal(user.phone, '09171234567');
  const json = user.toJSON();
  assert.equal('passwordHash' in json, false);
  assert.equal(JSON.stringify(user).includes('secret-hash'), false);
});

test('User: password rules (8+ characters, at most 72 bytes) and hashing', async () => {
  assert.equal(User.validatePassword('12345678'), null);
  assert.match(User.validatePassword('1234567'), /at least 8/);
  assert.match(User.validatePassword(''), /required/);
  assert.match(User.validatePassword(undefined), /required/);
  assert.match(User.validatePassword('a'.repeat(73)), /at most 72/);
  assert.equal(User.validatePassword('a'.repeat(72)), null);
  assert.match(User.validatePassword('é'.repeat(37)), /at most 72/); // 74 bytes
  const hash = await User.hashPassword('correct-horse');
  assert.notEqual(hash, 'correct-horse');
  const user = new User({ name: 'A', email: 'a@b.c', passwordHash: hash });
  assert.equal(await user.comparePassword('correct-horse'), true);
  assert.equal(await user.comparePassword('wrong-horse'), false);
});

test('Movie: required fields, status default and validation', async () => {
  assert.deepEqual(
    (await failedPaths(new Movie({}))).sort(),
    ['duration', 'genre', 'posterUrl', 'rating', 'releaseDate', 'synopsis', 'title'],
  );
  const movie = new Movie(validMovie());
  assert.deepEqual(await failedPaths(movie), []);
  assert.equal(movie.status, 'draft');
  assert.deepEqual(await failedPaths(new Movie({ ...validMovie(), status: 'now_showing' })), ['status']);
  assert.deepEqual(await failedPaths(new Movie({ ...validMovie(), duration: 0 })), ['duration']);
  assert.deepEqual(await failedPaths(new Movie({ ...validMovie(), duration: 90.5 })), ['duration']);
  assert.deepEqual(await failedPaths(new Movie({ ...validMovie(), posterUrl: 'ftp://x/y.jpg' })), ['posterUrl']);
  assert.deepEqual(await failedPaths(new Movie({ ...validMovie(), posterUrl: 'javascript:alert(1)' })), ['posterUrl']);
  assert.deepEqual(await failedPaths(new Movie({ ...validMovie(), posterUrl: 'http://example.com/p.png' })), []);
});

test('Auditorium: the server generates seat labels from the layout', async () => {
  assert.deepEqual(Auditorium.generateSeatLabels(2, 3), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  const room = new Auditorium({ name: 'Hall 1', rows: 2, seatsPerRow: 3, seatLabels: ['EVIL1'] });
  assert.deepEqual(await failedPaths(room), []);
  assert.deepEqual(room.seatLabels, ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal(room.isActive, true);
});

test('Auditorium: rejects bad layouts', async () => {
  assert.deepEqual((await failedPaths(new Auditorium({}))).sort(), ['name', 'rows', 'seatLabels', 'seatsPerRow']);
  assert.ok((await failedPaths(new Auditorium({ name: 'x', rows: 0, seatsPerRow: 5 }))).includes('rows'));
  assert.ok((await failedPaths(new Auditorium({ name: 'x', rows: 27, seatsPerRow: 5 }))).includes('rows'));
  assert.ok((await failedPaths(new Auditorium({ name: 'x', rows: 2.5, seatsPerRow: 5 }))).includes('rows'));
  assert.ok((await failedPaths(new Auditorium({ name: 'x', rows: 2, seatsPerRow: 51 }))).includes('seatsPerRow'));
  assert.ok((await failedPaths(new Auditorium({ name: ' ', rows: 2, seatsPerRow: 5 }))).includes('name'));
});

test('Showtime: required fields, defaults and time ordering', async () => {
  assert.deepEqual(
    (await failedPaths(new Showtime({}))).sort(),
    ['auditorium', 'endTime', 'movie', 'startTime', 'ticketPrice'],
  );
  const start = new Date('2030-01-01T02:00:00Z');
  const end = Showtime.computeEndTime(start, 120);
  assert.equal(end.toISOString(), '2030-01-01T04:00:00.000Z');
  const base = { movie: id(), auditorium: id(), startTime: start, endTime: end, ticketPrice: 40000 };
  const showtime = new Showtime(base);
  assert.deepEqual(await failedPaths(showtime), []);
  assert.equal(showtime.status, 'scheduled');
  assert.deepEqual(await failedPaths(new Showtime({ ...base, endTime: start })), ['endTime']);
  assert.deepEqual(await failedPaths(new Showtime({ ...base, endTime: new Date('2029-12-31') })), ['endTime']);
  assert.deepEqual(await failedPaths(new Showtime({ ...base, ticketPrice: -1 })), ['ticketPrice']);
  assert.deepEqual(await failedPaths(new Showtime({ ...base, ticketPrice: 99.5 })), ['ticketPrice']);
  assert.deepEqual(await failedPaths(new Showtime({ ...base, status: 'done' })), ['status']);
});

test('Booking: required fields, defaults, empty and duplicate seats, totals', async () => {
  const base = {
    bookingCode: 'FLM-ABCD2345',
    user: id(),
    showtime: id(),
    seats: ['A1', 'A2'],
    unitPrice: 40000,
    totalAmount: 80000,
  };
  const booking = new Booking(base);
  assert.deepEqual(await failedPaths(booking), []);
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.cancelledAt, null);
  assert.ok(booking.bookedAt instanceof Date);

  assert.deepEqual(
    (await failedPaths(new Booking({}))).sort(),
    ['bookingCode', 'seats', 'showtime', 'totalAmount', 'unitPrice', 'user'],
  );
  assert.deepEqual(await failedPaths(new Booking({ ...base, seats: [], totalAmount: 0 })), ['seats']);
  assert.deepEqual(await failedPaths(new Booking({ ...base, seats: ['A1', 'A1'] })), ['seats']);
  assert.deepEqual(await failedPaths(new Booking({ ...base, seats: ['A1', ' '], totalAmount: 80000 })), ['seats']);
  assert.deepEqual(await failedPaths(new Booking({ ...base, totalAmount: 1 })), ['totalAmount']);
  assert.deepEqual(await failedPaths(new Booking({ ...base, status: 'pending' })), ['status']);
});

test('Booking: generated codes look right and do not repeat', () => {
  const codes = new Set();
  for (let i = 0; i < 500; i += 1) {
    const code = Booking.generateCode();
    assert.match(code, /^FLM-[A-HJ-NP-Z2-9]{8}$/);
    codes.add(code);
  }
  assert.equal(codes.size, 500);
});

test('SeatClaim: required fields', async () => {
  assert.deepEqual((await failedPaths(new SeatClaim({}))).sort(), ['booking', 'seatLabel', 'showtime']);
  assert.deepEqual(await failedPaths(new SeatClaim({ showtime: id(), seatLabel: 'A1', booking: id() })), []);
});

test('Indexes: the unique rules the proposal relies on are declared', () => {
  const hasIndex = (Model, keys, unique) => Model.schema.indexes().some(
    ([fields, options]) => JSON.stringify(fields) === JSON.stringify(keys) && Boolean(options.unique) === unique,
  );
  assert.ok(hasIndex(SeatClaim, { showtime: 1, seatLabel: 1 }, true), 'SeatClaim (showtime, seatLabel) unique');
  assert.ok(User.schema.path('email').options.unique, 'User.email unique');
  assert.ok(Auditorium.schema.path('name').options.unique, 'Auditorium.name unique');
  assert.ok(Booking.schema.path('bookingCode').options.unique, 'Booking.bookingCode unique');
});
