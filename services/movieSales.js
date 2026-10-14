const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const Auditorium = require('../models/Auditorium');

const idOf = (value) => String(value && value._id ? value._id : value);

const emptySales = () => ({ revenue: 0, tickets: 0, bookings: 0, cancelled: 0, refunded: 0, customers: 0 });

// What each movie has earned, from the same rules as the overview: revenue and tickets come from
// confirmed bookings only. A cancelled booking never adds revenue; the ones whose payment was
// paid back are summed as `refunded`, so the admin can see money that came and went.
//
// Returns a Map of movie id -> { revenue, tickets, bookings, cancelled, refunded, customers }
// (centavos for money). A movie nobody booked is not in the map: use `sales.get(id) || emptySales()`.
async function salesByMovie(movieIds) {
  const sales = new Map();
  if (movieIds.length === 0) return sales;
  const showtimes = await Showtime.find({ movie: { $in: movieIds } }).select('movie');
  if (showtimes.length === 0) return sales;
  const movieOfShowtime = new Map(showtimes.map((showtime) => [idOf(showtime), idOf(showtime.movie)]));
  const bookings = await Booking.find({
    showtime: { $in: showtimes.map((showtime) => showtime._id) },
    status: { $in: ['confirmed', 'cancelled'] },
  });

  const buyers = new Map();
  for (const booking of bookings) {
    const movieId = movieOfShowtime.get(idOf(booking.showtime));
    if (!movieId) continue;
    const row = sales.get(movieId) || emptySales();
    if (booking.status === 'confirmed') {
      row.revenue += booking.totalAmount;
      row.tickets += booking.seats.length;
      row.bookings += 1;
      const people = buyers.get(movieId) || new Set();
      people.add(idOf(booking.user));
      buyers.set(movieId, people);
    } else {
      row.cancelled += 1;
      if (booking.paymentStatus === 'refunded') row.refunded += booking.totalAmount;
    }
    sales.set(movieId, row);
  }
  for (const [movieId, people] of buyers) sales.get(movieId).customers = people.size;
  return sales;
}

// One movie's panel: its sales, and how its showings are doing.
//   showings   upcoming (still to come), past (already happened), cancelled, and hidden (not visible)
//   occupancy  share of seats sold across its scheduled showings, or null when it has none
async function movieSummary(movie, now = new Date()) {
  const [sales, showings] = await Promise.all([
    salesByMovie([movie._id]).then((map) => map.get(idOf(movie)) || emptySales()),
    Showtime.find({ movie: movie._id }),
  ]);

  const scheduled = showings.filter((showing) => showing.status === 'scheduled');
  const upcoming = scheduled.filter((showing) => showing.startTime > now);
  const counts = {
    total: showings.length,
    upcoming: upcoming.length,
    past: scheduled.length - upcoming.length,
    cancelled: showings.length - scheduled.length,
    hidden: upcoming.filter((showing) => showing.isPublished === false).length,
  };

  let occupancy = null;
  if (scheduled.length) {
    const rooms = await Auditorium.find({ _id: { $in: [...new Set(scheduled.map((showing) => idOf(showing.auditorium)))] } });
    const seatsIn = new Map(rooms.map((room) => [idOf(room), room.seatLabels.length]));
    const capacity = scheduled.reduce((sum, showing) => sum + (seatsIn.get(idOf(showing.auditorium)) || 0), 0);
    occupancy = capacity ? Math.min(100, Math.round((sales.tickets / capacity) * 1000) / 10) : null;
  }

  const next = upcoming.reduce((first, showing) => (!first || showing.startTime < first ? showing.startTime : first), null);
  return { sales, showings: counts, occupancy, nextShowing: next };
}

module.exports = { salesByMovie, movieSummary, emptySales };
