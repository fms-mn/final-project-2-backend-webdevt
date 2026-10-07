const Booking = require('../models/Booking');
const Showtime = require('../models/Showtime');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const { dayRange, badRequest } = require('../utils/validate');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 92;
const idOf = (value) => String(value && value._id ? value._id : value);
const manilaDay = (date) => new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

// "2026-10-01" to "2026-10-07" (both included, Asia/Manila days) as one [start, end) range.
function readRange(query) {
  const from = dayRange(query.from);
  const to = dayRange(query.to);
  const errors = {};
  if (!from) errors.from = 'from must look like 2026-10-31';
  if (!to) errors.to = 'to must look like 2026-10-31';
  if (Object.keys(errors).length) throw badRequest(errors);
  const days = Math.round((to.end - from.start) / DAY_MS);
  if (days < 1) throw badRequest({ to: 'to must not be before from' });
  if (days > MAX_DAYS) throw badRequest({ to: `Pick at most ${MAX_DAYS} days at a time` });
  return { start: from.start, end: to.end, days };
}

// Money and tickets come from confirmed bookings made in the range. A cancelled booking is
// counted on its own and never adds revenue.
async function bookingTotals({ start, end }) {
  const bookings = await Booking.find({ bookedAt: { $gte: start, $lt: end } });
  const confirmed = bookings.filter((booking) => booking.status === 'confirmed');
  return {
    bookings: bookings.length,
    confirmed,
    cancelled: bookings.length - confirmed.length,
    revenue: confirmed.reduce((sum, booking) => sum + booking.totalAmount, 0),
    tickets: confirmed.reduce((sum, booking) => sum + booking.seats.length, 0),
    customers: new Set(confirmed.map((booking) => idOf(booking.user))).size,
  };
}

// Share of seats sold across the scheduled showings that start in the range.
async function occupancyFor({ start, end }) {
  const showtimes = await Showtime.find({ status: 'scheduled', startTime: { $gte: start, $lt: end } });
  if (showtimes.length === 0) return { occupancy: null, showings: 0 };
  const auditoriums = await Auditorium.find({ _id: { $in: [...new Set(showtimes.map((s) => idOf(s.auditorium)))] } });
  const seatsIn = new Map(auditoriums.map((room) => [idOf(room), room.seatLabels.length]));
  const capacity = showtimes.reduce((sum, s) => sum + (seatsIn.get(idOf(s.auditorium)) || 0), 0);
  const ids = new Set(showtimes.map((s) => idOf(s)));
  const bookings = await Booking.find({ status: 'confirmed', showtime: { $in: showtimes.map((s) => s._id) } });
  const sold = bookings.filter((b) => ids.has(idOf(b.showtime))).reduce((sum, b) => sum + b.seats.length, 0);
  return { occupancy: capacity ? Math.round((sold / capacity) * 1000) / 10 : null, showings: showtimes.length };
}

async function buildStats(query) {
  const range = readRange(query);
  const previous = { start: new Date(range.start - range.days * DAY_MS), end: range.start };
  const [now, before, seats] = await Promise.all([
    bookingTotals(range), bookingTotals(previous), occupancyFor(range),
  ]);

  const byDay = new Map();
  for (let i = 0; i < range.days; i += 1) byDay.set(manilaDay(new Date(range.start.getTime() + i * DAY_MS)), { revenue: 0, tickets: 0 });
  for (const booking of now.confirmed) {
    const day = byDay.get(manilaDay(booking.bookedAt));
    if (day) { day.revenue += booking.totalAmount; day.tickets += booking.seats.length; }
  }

  const showtimes = await Showtime.find({ _id: { $in: [...new Set(now.confirmed.map((b) => idOf(b.showtime)))] } });
  const movieOfShowtime = new Map(showtimes.map((s) => [idOf(s), idOf(s.movie)]));
  const movies = await Movie.find({ _id: { $in: [...new Set(showtimes.map((s) => idOf(s.movie)))] } });
  const titleOf = new Map(movies.map((m) => [idOf(m), m.title]));
  const perMovie = new Map();
  for (const booking of now.confirmed) {
    const movieId = movieOfShowtime.get(idOf(booking.showtime));
    if (!movieId) continue;
    const row = perMovie.get(movieId) || { title: titleOf.get(movieId) || 'Movie', tickets: 0, revenue: 0 };
    row.tickets += booking.seats.length;
    row.revenue += booking.totalAmount;
    perMovie.set(movieId, row);
  }

  return {
    from: query.from,
    to: query.to,
    days: range.days,
    revenue: now.revenue,
    tickets: now.tickets,
    customers: now.customers,
    bookings: now.bookings,
    cancelled: now.cancelled,
    occupancy: seats.occupancy,
    showings: seats.showings,
    previous: { revenue: before.revenue, tickets: before.tickets },
    daily: [...byDay].map(([date, values]) => ({ date, ...values })),
    topMovies: [...perMovie.values()].sort((a, b) => b.revenue - a.revenue || b.tickets - a.tickets || a.title.localeCompare(b.title)).slice(0, 5),
  };
}

module.exports = { buildStats, MAX_DAYS };
