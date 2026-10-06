const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const { HttpError } = require('../utils/http');
const { withTransaction } = require('../utils/transaction');
const { isObjectId, badRequest, collectErrors } = require('../utils/validate');

const EDITABLE = ['movie', 'auditorium', 'startTime', 'ticketPrice'];

// Reads and checks the fields an admin may send. `partial` (PATCH) accepts any subset.
function readInput(body = {}, { partial }) {
  return collectErrors((fail) => {
    const input = {};
    if (!partial || body.movie !== undefined) {
      if (!isObjectId(body.movie)) fail('movie', 'movie must be a movie id');
      else input.movie = body.movie;
    }
    if (!partial || body.auditorium !== undefined) {
      if (!isObjectId(body.auditorium)) fail('auditorium', 'auditorium must be an auditorium id');
      else input.auditorium = body.auditorium;
    }
    if (!partial || body.startTime !== undefined) {
      const start = typeof body.startTime === 'string' ? new Date(body.startTime) : null;
      if (!start || Number.isNaN(start.getTime())) fail('startTime', 'startTime must be a valid date and time');
      else input.startTime = start;
    }
    if (!partial || body.ticketPrice !== undefined) {
      if (!Number.isInteger(body.ticketPrice) || body.ticketPrice < 0) {
        fail('ticketPrice', 'ticketPrice must be a whole number of centavos (400.00 pesos is 40000)');
      } else {
        input.ticketPrice = body.ticketPrice;
      }
    }
    if (partial && !EDITABLE.some((field) => body[field] !== undefined)) {
      fail('body', `Send at least one of: ${EDITABLE.join(', ')}`);
    }
    return input;
  });
}

// The movie must be published and the auditorium active, or no one could book the showtime.
async function loadReferences({ movieId, auditoriumId, session }) {
  const movie = await Movie.findById(movieId).session(session);
  if (!movie) throw badRequest({ movie: 'Movie not found' });
  if (movie.status !== 'published') throw badRequest({ movie: 'Only published movies can be scheduled' });
  const auditorium = await Auditorium.findById(auditoriumId).session(session);
  if (!auditorium) throw badRequest({ auditorium: 'Auditorium not found' });
  if (!auditorium.isActive) throw badRequest({ auditorium: 'Auditorium is not active' });
  return { movie, auditorium };
}

// Writing the auditorium makes concurrent schedule changes for it conflict, so MongoDB runs them
// one after the other (the loser is retried and then sees the winner's showtime).
async function lockAuditorium(auditoriumId, session) {
  await Auditorium.updateOne({ _id: auditoriumId }, { $inc: { scheduleRevision: 1 } }, { session });
}

// Two scheduled showtimes in one auditorium may not overlap. Back-to-back (one ends exactly when
// the next starts) is allowed.
async function assertNoOverlap({ auditoriumId, startTime, endTime, excludeId, session }) {
  const filter = {
    auditorium: auditoriumId,
    status: 'scheduled',
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const clash = await Showtime.findOne(filter).session(session);
  if (clash) {
    throw new HttpError(409, 'This auditorium already has a showtime that overlaps that time');
  }
}

const assertFuture = (startTime, now) => {
  if (startTime <= now) throw badRequest({ startTime: 'startTime must be in the future' });
};

async function createShowtime(body, now = new Date()) {
  const input = readInput(body, { partial: false });
  assertFuture(input.startTime, now);

  return withTransaction(async (session) => {
    const { movie } = await loadReferences({
      movieId: input.movie, auditoriumId: input.auditorium, session,
    });
    await lockAuditorium(input.auditorium, session);

    const endTime = Showtime.computeEndTime(input.startTime, movie.duration);
    await assertNoOverlap({
      auditoriumId: input.auditorium, startTime: input.startTime, endTime, session,
    });

    const showtime = new Showtime({
      movie: input.movie,
      auditorium: input.auditorium,
      startTime: input.startTime,
      endTime,
      ticketPrice: input.ticketPrice,
    });
    await showtime.save({ session });
    return showtime;
  });
}

async function updateShowtime(id, body, now = new Date()) {
  const input = readInput(body, { partial: true });

  return withTransaction(async (session) => {
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (showtime.status !== 'scheduled') {
      throw new HttpError(409, 'A cancelled showtime cannot be edited. Create a new one instead.');
    }
    if (showtime.startTime <= now) throw new HttpError(409, 'A showtime that has started cannot be edited');
    // Even a cancelled booking counts: its price and seats were promised for that exact showtime.
    if (await Booking.exists({ showtime: showtime._id }).session(session)) {
      throw new HttpError(
        409,
        'This showtime already has bookings. Cancel it and create a replacement instead.',
      );
    }

    const next = {
      movie: String(input.movie ?? showtime.movie),
      auditorium: String(input.auditorium ?? showtime.auditorium),
      startTime: input.startTime ?? showtime.startTime,
      ticketPrice: input.ticketPrice ?? showtime.ticketPrice,
    };
    assertFuture(next.startTime, now);

    const { movie } = await loadReferences({
      movieId: next.movie, auditoriumId: next.auditorium, session,
    });
    await lockAuditorium(next.auditorium, session);

    const endTime = Showtime.computeEndTime(next.startTime, movie.duration);
    await assertNoOverlap({
      auditoriumId: next.auditorium,
      startTime: next.startTime,
      endTime,
      excludeId: showtime._id,
      session,
    });

    showtime.set({ ...next, endTime });
    await showtime.save({ session });
    return showtime;
  });
}

// Cancels a future showtime together with every confirmed booking on it and frees their seats,
// all in one transaction. Calling it again changes nothing.
async function cancelShowtime(id, now = new Date()) {
  return withTransaction(async (session) => {
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (showtime.status === 'cancelled') return { showtime, cancelledBookings: 0 };
    if (showtime.startTime <= now) throw new HttpError(409, 'A showtime that has started cannot be cancelled');

    showtime.status = 'cancelled';
    await showtime.save({ session });
    const result = await Booking.updateMany(
      { showtime: showtime._id, status: 'confirmed' },
      { $set: { status: 'cancelled', cancelledAt: now } },
      { session },
    );
    await SeatClaim.deleteMany({ showtime: showtime._id }, { session });
    return { showtime, cancelledBookings: result.modifiedCount ?? 0 };
  });
}

async function deleteShowtime(id) {
  return withTransaction(async (session) => {
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (await Booking.exists({ showtime: showtime._id }).session(session)) {
      throw new HttpError(409, 'This showtime has booking history and cannot be deleted. Cancel it instead.');
    }
    await Showtime.deleteOne({ _id: showtime._id }, { session });
  });
}

const idOf = (value) => String(value?._id ?? value);

// Adds movie, auditorium and seat counts to a page of showtimes. `publicOnly` hides showtimes
// whose movie is not published and trims the fields to what browsing and booking need.
async function describeShowtimes(showtimes, { publicOnly }) {
  if (showtimes.length === 0) return [];
  const movieIds = [...new Set(showtimes.map((s) => idOf(s.movie)))];
  const auditoriumIds = [...new Set(showtimes.map((s) => idOf(s.auditorium)))];
  const [movies, auditoriums, claims] = await Promise.all([
    Movie.find({ _id: { $in: movieIds } }),
    Auditorium.find({ _id: { $in: auditoriumIds } }),
    SeatClaim.find({ showtime: { $in: showtimes.map((s) => s._id) } }).select('showtime'),
  ]);
  const movieById = new Map(movies.map((m) => [idOf(m), m]));
  const auditoriumById = new Map(auditoriums.map((a) => [idOf(a), a]));
  const claimed = new Map();
  for (const claim of claims) {
    claimed.set(idOf(claim.showtime), (claimed.get(idOf(claim.showtime)) || 0) + 1);
  }

  const rows = [];
  for (const showtime of showtimes) {
    const movie = movieById.get(idOf(showtime.movie));
    const auditorium = auditoriumById.get(idOf(showtime.auditorium));
    if (publicOnly && (!movie || movie.status !== 'published' || !auditorium)) continue;
    const totalSeats = auditorium ? auditorium.seatLabels.length : 0;
    rows.push({
      _id: showtime._id,
      movie: movie
        ? { _id: movie._id, title: movie.title, posterUrl: movie.posterUrl, duration: movie.duration, rating: movie.rating }
        : { _id: showtime.movie },
      auditorium: auditorium ? { _id: auditorium._id, name: auditorium.name } : { _id: showtime.auditorium },
      startTime: showtime.startTime,
      endTime: showtime.endTime,
      ticketPrice: showtime.ticketPrice,
      totalSeats,
      remainingSeats: Math.max(0, totalSeats - (claimed.get(idOf(showtime._id)) || 0)),
      ...(publicOnly ? {} : { status: showtime.status }),
    });
  }
  return rows;
}

module.exports = {
  createShowtime,
  updateShowtime,
  cancelShowtime,
  deleteShowtime,
  describeShowtimes,
};
