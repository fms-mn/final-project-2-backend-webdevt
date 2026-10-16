const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const payments = require('./payments');
const notifications = require('./mail/notifications');
const { HttpError } = require('../utils/http');
const { withTransaction } = require('../utils/transaction');
const { isObjectId, badRequest, collectErrors } = require('../utils/validate');
const { getSettings } = require('./settings');
const { manilaClock, manilaDay, manilaLabel, manilaDateLabel } = require('../utils/manila');

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
    if (body.published !== undefined) {
      if (typeof body.published !== 'boolean') fail('published', 'published must be true or false');
      else input.published = body.published;
    }
    if (partial && !EDITABLE.some((field) => body[field] !== undefined)) {
      fail('body', `Send at least one of: ${EDITABLE.join(', ')}`);
    }
    return input;
  });
}

// The movie must not be archived and the auditorium must be active. A draft movie may get showings:
// customers cannot see them until the movie is published (see services/moviePublishing.js).
async function loadReferences({ movieId, auditoriumId, session }) {
  const movie = await Movie.findById(movieId).session(session);
  if (!movie) throw badRequest({ movie: 'Movie not found' });
  if (movie.status === 'archived') throw badRequest({ movie: `"${movie.title}" is archived. Set it back to Draft or Published to schedule showings.` });
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

// Two scheduled showtimes in one auditorium may not overlap, and the auditorium needs
// `turnaroundMinutes` between the end of one show and the start of the next (cleaning, getting
// people in and out). Returns the showtime in the way, or null when the slot is free.
async function findClash({ auditoriumId, startTime, endTime, excludeId, turnaroundMinutes = 0, session }) {
  const gap = turnaroundMinutes * 60 * 1000;
  const filter = {
    auditorium: auditoriumId,
    status: 'scheduled',
    startTime: { $lt: new Date(endTime.getTime() + gap) },
    endTime: { $gt: new Date(startTime.getTime() - gap) },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Showtime.findOne(filter).session(session);
}

function clashError(clash, startTime, endTime, turnaroundMinutes) {
  const strict = clash.startTime < endTime && clash.endTime > startTime;
  const when = `${manilaClock(clash.startTime)}-${manilaClock(clash.endTime)}`;
  return new HttpError(409, strict
    ? `This auditorium already has a showtime that overlaps that time (${when})`
    : `That is too close to another showtime (${when}). The auditorium needs ${turnaroundMinutes} minutes between shows`);
}

async function assertNoOverlap({ auditoriumId, startTime, endTime, excludeId, turnaroundMinutes = 0, session }) {
  const clash = await findClash({ auditoriumId, startTime, endTime, excludeId, turnaroundMinutes, session });
  if (clash) throw clashError(clash, startTime, endTime, turnaroundMinutes);
}

// A movie cannot be shown before its release day. Both sides are compared as Manila calendar days.
const beforeRelease = (movie, startTime) => manilaDay(startTime) < manilaDay(movie.releaseDate);
const releaseMessage = (movie) => `"${movie.title}" is released on ${manilaDateLabel(movie.releaseDate)}. A showing cannot start before that day.`;
const assertReleased = (movie, startTime) => {
  if (beforeRelease(movie, startTime)) throw badRequest({ startTime: releaseMessage(movie) });
};

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
    assertReleased(movie, input.startTime);
    await lockAuditorium(input.auditorium, session);

    const { turnaroundMinutes } = await getSettings(session);
    const endTime = Showtime.computeEndTime(input.startTime, movie.duration);
    await assertNoOverlap({
      auditoriumId: input.auditorium, startTime: input.startTime, endTime, turnaroundMinutes, session,
    });

    const showtime = new Showtime({
      movie: input.movie,
      auditorium: input.auditorium,
      startTime: input.startTime,
      endTime,
      ticketPrice: input.ticketPrice,
      isPublished: input.published ?? true,
    });
    await showtime.save({ session });
    return showtime;
  });
}

async function updateShowtime(id, body, now = new Date()) {
  const input = readInput(body, { partial: true });
  if (isObjectId(id)) await payments.expireHolds({ showtimeId: id }); // a timed-out hold is let go first

  return withTransaction(async (session) => {
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (showtime.status !== 'scheduled') {
      throw new HttpError(409, 'A cancelled showtime cannot be edited. Create a new one instead.');
    }
    if (showtime.startTime <= now) throw new HttpError(409, 'A showtime that has started cannot be edited');
    // Even a cancelled booking counts: its price and seats were promised for that exact showtime.
    // A hold that ran out or was let go promised nothing, so it does not lock the showing.
    if (await Booking.exists({ showtime: showtime._id, status: { $ne: 'expired' } }).session(session)) {
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
    assertReleased(movie, next.startTime);
    await lockAuditorium(next.auditorium, session);

    const { turnaroundMinutes } = await getSettings(session);
    const endTime = Showtime.computeEndTime(next.startTime, movie.duration);
    await assertNoOverlap({
      auditoriumId: next.auditorium,
      startTime: next.startTime,
      endTime,
      excludeId: showtime._id,
      turnaroundMinutes,
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
  let refundedBookings = []; // the paid bookings this call cancelled: their owners are emailed
  const result = await withTransaction(async (session) => {
    refundedBookings = [];
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (showtime.status === 'cancelled') return { showtime, cancelledBookings: 0 };
    if (showtime.startTime <= now) throw new HttpError(409, 'A showtime that has started cannot be cancelled');

    showtime.status = 'cancelled';
    await showtime.save({ session });
    // Paid bookings are cancelled and refunded; unpaid holds are released.
    const affected = await Booking.find({ showtime: showtime._id, status: { $in: ['confirmed', 'pending'] } }).session(session);
    let cancelledBookings = 0;
    for (const booking of affected) {
      if (booking.status === 'pending') {
        await payments.releaseHold(booking._id, 'showtime_cancelled', { session });
      } else {
        booking.status = 'cancelled';
        booking.cancelledAt = now;
        await payments.refundBooking(booking, now, session);
        await booking.save({ session });
        cancelledBookings += 1;
        refundedBookings.push(booking._id);
      }
    }
    await SeatClaim.deleteMany({ showtime: showtime._id }, { session });
    return { showtime, cancelledBookings };
  });
  if (refundedBookings.length) notifications.showingCancelled(refundedBookings);
  return result;
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

// Showtimes saved before the visibility switch existed have no value, which counts as visible.
const isShown = (showtime) => showtime.isPublished !== false;

// Every seat that cannot be booked at this showing: blocked in the auditorium or for the showing.
const blockedSet = (auditorium, showtime) => new Set([
  ...((auditorium && auditorium.blockedSeats) || []),
  ...(showtime.blockedSeats || []),
]);

// Adds movie, auditorium and seat counts to a page of showtimes. `publicOnly` hides showtimes
// whose movie is not published and trims the fields to what browsing and booking need.
async function describeShowtimes(showtimes, { publicOnly }) {
  if (showtimes.length === 0) return [];
  const movieIds = [...new Set(showtimes.map((s) => idOf(s.movie)))];
  const auditoriumIds = [...new Set(showtimes.map((s) => idOf(s.auditorium)))];
  const [movies, auditoriums, claims] = await Promise.all([
    Movie.find({ _id: { $in: movieIds } }),
    Auditorium.find({ _id: { $in: auditoriumIds } }),
    SeatClaim.find({ showtime: { $in: showtimes.map((s) => s._id) } }).select('showtime seatLabel'),
  ]);
  const movieById = new Map(movies.map((m) => [idOf(m), m]));
  const auditoriumById = new Map(auditoriums.map((a) => [idOf(a), a]));
  const claimsOf = new Map();
  for (const claim of claims) {
    const key = idOf(claim.showtime);
    claimsOf.set(key, [...(claimsOf.get(key) || []), claim.seatLabel]);
  }

  const rows = [];
  for (const showtime of showtimes) {
    const movie = movieById.get(idOf(showtime.movie));
    const auditorium = auditoriumById.get(idOf(showtime.auditorium));
    if (publicOnly && (!movie || movie.status !== 'published' || !auditorium)) continue;
    const blocked = blockedSet(auditorium, showtime);
    const totalSeats = auditorium ? auditorium.seatLabels.filter((label) => !blocked.has(label)).length : 0;
    const taken = (claimsOf.get(idOf(showtime._id)) || []).filter((label) => !blocked.has(label)).length;
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
      remainingSeats: Math.max(0, totalSeats - taken),
      ...(publicOnly ? {} : {
        status: showtime.status,
        published: isShown(showtime),
        blockedSeats: showtime.blockedSeats || [],
        rescheduledAt: showtime.rescheduledAt || null,
        originalStartTime: showtime.originalStartTime || null,
      }),
    });
  }
  return rows;
}

module.exports = {
  idOf,
  isShown,
  blockedSet,
  loadReferences,
  lockAuditorium,
  findClash,
  clashError,
  assertNoOverlap,
  assertFuture,
  assertReleased,
  beforeRelease,
  releaseMessage,
  createShowtime,
  updateShowtime,
  cancelShowtime,
  deleteShowtime,
  describeShowtimes,
};
