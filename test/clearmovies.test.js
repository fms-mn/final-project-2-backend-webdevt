// The "start from zero" script removes movies and what depends on them, and keeps users, rooms and
// settings. Runs against the in-memory stand-in in fakeDb.js.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const Payment = require('../models/Payment');
const Setting = require('../models/Setting');
const { fakeModel } = require('./fakeDb');
const { clearMovies } = require('../scripts/clear-movies');

const stores = {};
test.before(() => {
  for (const [name, Model, options] of [
    ['users', User, { uniqueOn: 'email' }], ['movies', Movie], ['rooms', Auditorium, { uniqueOn: 'name' }],
    ['showtimes', Showtime], ['bookings', Booking], ['claims', SeatClaim], ['payments', Payment], ['settings', Setting, { uniqueOn: 'key' }],
  ]) {
    stores[name] = [];
    fakeModel(Model, stores[name], options);
  }
});

const put = (Model, rows, fields) => { const doc = new Model(fields); doc.$isNew = false; rows.push(doc); return doc; };

test('clear-movies: a preview deletes nothing, the real run removes movies and their bookings but keeps people and rooms', async () => {
  const admin = put(User, stores.users, { name: 'Boss', email: 'boss@example.com', passwordHash: 'x', role: 'admin' });
  const customer = put(User, stores.users, { name: 'Ann', email: 'ann@example.com', passwordHash: 'x' });
  const layout = { rows: 2, seatsPerRow: 3 };
  const room = put(Auditorium, stores.rooms, { name: 'Hall 1', ...layout, seatLabels: Auditorium.generateSeatLabels(2, 3) });
  put(Setting, stores.settings, { key: 'rules', turnaroundMinutes: 15, salesCutoffMinutes: 15 });
  const movie = put(Movie, stores.movies, {
    title: 'Dune', synopsis: 'Sand.', genre: 'Sci-Fi', rating: 'PG-13', duration: 120,
    posterUrl: 'https://example.com/d.jpg', releaseDate: new Date('2026-01-01'), status: 'published',
  });
  const start = new Date(Date.now() + 86400000);
  const show = put(Showtime, stores.showtimes, {
    movie: movie._id, auditorium: room._id, startTime: start, endTime: Showtime.computeEndTime(start, 120), ticketPrice: 40000,
  });
  const booking = put(Booking, stores.bookings, {
    bookingCode: 'FLM-1', user: customer._id, showtime: show._id, seats: ['A1'], unitPrice: 40000, totalAmount: 40000, status: 'confirmed',
  });
  put(SeatClaim, stores.claims, { showtime: show._id, seatLabel: 'A1', booking: booking._id });
  put(Payment, stores.payments, { booking: booking._id, user: customer._id, amount: 40000, method: 'card', reference: 'PAY-1', status: 'paid' });

  const preview = await clearMovies({ dryRun: true });
  assert.deepEqual(Object.fromEntries(preview.map((row) => [row.name, row.count])), { payments: 1, seatclaims: 1, bookings: 1, showtimes: 1, movies: 1 });
  assert.equal(stores.movies.length + stores.bookings.length, 2, 'the preview deleted nothing');

  await clearMovies({ dryRun: false });
  for (const name of ['movies', 'showtimes', 'bookings', 'claims', 'payments']) assert.equal(stores[name].length, 0, `${name} are gone`);
  assert.deepEqual(stores.users.map((user) => user.email).sort(), ['ann@example.com', 'boss@example.com'], 'users and the admin stay');
  assert.equal(stores.users.find((user) => user === admin).role, 'admin');
  assert.equal(stores.rooms.length, 1, 'rooms stay');
  assert.equal(stores.settings.length, 1, 'settings stay');
  assert.equal((await clearMovies({ dryRun: false })).every((row) => row.count === 0), true, 'running it again is harmless');
});
