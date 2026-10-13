const Booking = require('../models/Booking');
const Showtime = require('../models/Showtime');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const SeatClaim = require('../models/SeatClaim');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { HttpError } = require('../utils/http');
const { withTransaction } = require('../utils/transaction');
const { isObjectId, badRequest, collectErrors } = require('../utils/validate');
const config = require('../config');
const { getSettings } = require('./settings');
const payments = require('./payments');
const { cancellationInfo } = require('./cancellationInfo');

const MAX_SEATS_PER_BOOKING = 10;
// Transient conflicts (another booking, cancellation or edit on the same showtime committed first)
// make MongoDB re-run the transaction. Bounded, so a request can never loop forever.
const MAX_ATTEMPTS = 20;
// MongoDB re-runs a conflicting transaction immediately, which would burn the attempts while the
// other booking is still finishing (against a cloud database one booking takes a few hundred
// milliseconds). A growing random pause per retry spreads the competing requests out so they
// commit one after another. (Overridable so the offline tests do not wait.)
const RETRY_PAUSE_MS = Number(process.env.BOOKING_RETRY_PAUSE_MS ?? 30);
const RETRY_PAUSE_MAX_MS = 400;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Only the showtime and the seat labels come from the customer. The user, price, total, code and
// status are always decided here, so anything else in the request body is ignored.
function readInput(body = {}) {
  return collectErrors((fail) => {
    const input = {};
    if (!isObjectId(body.showtime)) fail('showtime', 'showtime must be a showtime id');
    else input.showtime = body.showtime;

    if (!Array.isArray(body.seats) || body.seats.length === 0) {
      fail('seats', 'Choose at least one seat');
    } else if (body.seats.length > MAX_SEATS_PER_BOOKING) {
      fail('seats', `You can book at most ${MAX_SEATS_PER_BOOKING} seats at a time`);
    } else if (!body.seats.every((seat) => typeof seat === 'string' && seat.trim())) {
      fail('seats', 'Every seat must be a seat label such as A1');
    } else {
      const seats = body.seats.map((seat) => seat.trim().toUpperCase());
      if (new Set(seats).size !== seats.length) fail('seats', 'A seat can only be chosen once');
      else input.seats = seats;
    }
    return input;
  });
}

async function uniqueBookingCode(session) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = Booking.generateCode();
    if (!await Booking.exists({ bookingCode: code }).session(session)) return code;
  }
  throw new Error('Could not generate a unique booking code');
}

const isDuplicateKey = (error) => Boolean(error) && error.code === 11000;

// Books every requested seat or none of them, in ONE transaction:
//  1. the showtime must exist, be scheduled and not have started;
//  2. every label must be a seat of the showtime's auditorium;
//  3. the Booking and one SeatClaim per seat are inserted. The unique (showtime, seatLabel) index
//     rejects a seat that is already claimed: the whole transaction rolls back and the customer
//     gets a 409 and can choose again;
//  4. the showtime record is written (last, see below), so a concurrent cancellation/edit of the
//     same showtime conflicts with this booking and one of them re-runs against the other's result.
//
// With payments on (the default) the booking is only a HOLD: it is "pending" and the seats stay
// claimed for HOLD_MINUTES while the customer pays (services/payments.js). Paying confirms it; an
// unpaid hold expires and the seats go back on sale. With PAYMENT_REQUIRED=false it confirms at once.
async function createBooking(userId, body) {
  const input = readInput(body);
  // Seats whose hold has run out, and this customer's own earlier unpaid hold, must not block them.
  await payments.expireHolds({ showtimeId: input.showtime });
  await payments.releaseUserHolds(userId, input.showtime);

  for (let codeTry = 0; codeTry < 3; codeTry += 1) {
    let attempts = 0;
    try {
      return await withTransaction(async (session) => {
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
          throw new HttpError(503, 'This showtime is very busy right now. Please try again in a moment.');
        }
        if (attempts > 1) await pause(Math.min(RETRY_PAUSE_MAX_MS, RETRY_PAUSE_MS * attempts) * (0.5 + Math.random()));

        const showtime = await Showtime.findById(input.showtime).session(session);
        if (!showtime) throw new HttpError(404, 'Showtime not found');
        if (showtime.status !== 'scheduled') {
          throw new HttpError(409, 'This showtime has been cancelled');
        }
        // A hidden showtime does not exist as far as customers are concerned.
        if (showtime.isPublished === false) throw new HttpError(404, 'Showtime not found');
        const untilStart = showtime.startTime.getTime() - Date.now();
        if (untilStart <= 0) {
          throw new HttpError(409, 'This showtime has already started');
        }
        const { salesCutoffMinutes } = await getSettings(session);
        if (untilStart <= salesCutoffMinutes * 60 * 1000) {
          throw new HttpError(409, `Online booking for this showtime closed ${salesCutoffMinutes} minutes before it starts`);
        }

        const auditorium = await Auditorium.findById(showtime.auditorium).session(session);
        if (!auditorium) throw new HttpError(409, 'This showtime has no auditorium');
        const known = new Set(auditorium.seatLabels);
        const unknown = input.seats.filter((seat) => !known.has(seat));
        if (unknown.length) {
          throw badRequest({ seats: `Not a seat in this auditorium: ${unknown.join(', ')}` });
        }

        const blocked = new Set([...(auditorium.blockedSeats || []), ...(showtime.blockedSeats || [])]);
        const unavailable = input.seats.filter((seat) => blocked.has(seat));
        if (unavailable.length) {
          throw new HttpError(409, `These seats cannot be booked: ${unavailable.join(', ')}`);
        }

        const booking = new Booking({
          bookingCode: await uniqueBookingCode(session),
          user: userId,
          showtime: showtime._id,
          seats: input.seats,
          unitPrice: showtime.ticketPrice, // snapshot of the price the customer saw and accepted
          totalAmount: showtime.ticketPrice * input.seats.length,
          ...(config.paymentRequired
            ? { status: 'pending', paymentStatus: 'unpaid', holdExpiresAt: new Date(Date.now() + config.holdMinutes * 60 * 1000) }
            : {}),
        });
        try {
          await booking.save({ session });
        } catch (error) {
          if (isDuplicateKey(error)) throw Object.assign(new Error('booking code collision'), { retryCode: true });
          throw error;
        }

        try {
          await SeatClaim.insertMany(
            input.seats.map((seatLabel) => ({ showtime: showtime._id, seatLabel, booking: booking._id })),
            { session },
          );
        } catch (error) {
          if (isDuplicateKey(error)) {
            throw new HttpError(409, 'One or more of those seats were just taken. Please refresh and choose again.');
          }
          throw error;
        }

        // Written LAST, right before the commit, so the window in which two bookings of the same
        // showtime can clash is as short as possible. It still does its job: if a cancellation or
        // edit of this showtime committed after this transaction began, this write conflicts, the
        // transaction re-runs and everything above is validated again.
        await Showtime.updateOne({ _id: showtime._id }, { $inc: { bookingRevision: 1 } }, { session });
        return booking;
      });
    } catch (error) {
      if (error.retryCode) continue; // an astronomically rare code clash: generate another code
      throw error;
    }
  }
  throw new HttpError(503, 'Could not complete the booking. Please try again.');
}

// Cancels one booking and frees its seats in ONE transaction. Repeating it changes nothing.
// Nothing can be cancelled once the showtime has started, for customers and admins alike.
async function cancelBooking(bookingId, actor) {
  return withTransaction(async (session) => {
    const booking = await Booking.findById(bookingId).session(session);
    // Someone else's booking looks exactly like one that does not exist.
    if (!booking || !canAccess(actor, booking)) throw new HttpError(404, 'Booking not found');
    if (booking.status === 'cancelled' || booking.status === 'expired') return booking;
    // An unpaid hold is simply given up: nothing was paid, so there is nothing to refund.
    if (booking.status === 'pending') {
      await payments.releaseHold(booking._id, 'abandoned', { session });
      return Booking.findById(booking._id).session(session);
    }

    const showtime = await Showtime.findById(booking.showtime).session(session);
    if (showtime && showtime.startTime <= new Date()) {
      throw new HttpError(409, 'This showtime has already started, so the booking can no longer be cancelled');
    }

    const now = new Date();
    booking.status = 'cancelled';
    booking.cancelledAt = now;
    await payments.refundBooking(booking, now, session); // a paid booking is refunded in full
    await booking.save({ session });
    await SeatClaim.deleteMany({ booking: booking._id }, { session });
    return booking;
  });
}

const canAccess = (actor, booking) => (
  actor.role === 'admin' || String(actor._id) === String(booking.user)
);

const idOf = (value) => String(value?._id ?? value);

// Bookings with the movie, showtime and auditorium they belong to (and the customer, for admins).
async function describeBookings(bookings, { admin = false } = {}) {
  if (bookings.length === 0) return [];
  const showtimes = await Showtime.find({ _id: { $in: [...new Set(bookings.map((b) => idOf(b.showtime)))] } });
  const showtimeById = new Map(showtimes.map((s) => [idOf(s), s]));
  const [movies, auditoriums, customers] = await Promise.all([
    Movie.find({ _id: { $in: [...new Set(showtimes.map((s) => idOf(s.movie)))] } }),
    Auditorium.find({ _id: { $in: [...new Set(showtimes.map((s) => idOf(s.auditorium)))] } }),
    admin ? User.find({ _id: { $in: [...new Set(bookings.map((b) => idOf(b.user)))] } }) : [],
  ]);
  const movieById = new Map(movies.map((m) => [idOf(m), m]));
  const auditoriumById = new Map(auditoriums.map((a) => [idOf(a), a]));
  const customerById = new Map(customers.map((u) => [idOf(u), u]));
  // The payment that matters for each booking: the paid or refunded one, else the latest attempt.
  const attempts = await Payment.find({ booking: { $in: bookings.map((b) => b._id) } });
  const paymentByBooking = new Map();
  for (const payment of [...attempts].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))) {
    const key = idOf(payment.booking);
    const current = paymentByBooking.get(key);
    const settled = ['paid', 'refunded'].includes(payment.status);
    if (!current || settled || !['paid', 'refunded'].includes(current.status)) paymentByBooking.set(key, payment);
  }

  return bookings.map((booking) => {
    const showtime = showtimeById.get(idOf(booking.showtime));
    const movie = showtime && movieById.get(idOf(showtime.movie));
    const auditorium = showtime && auditoriumById.get(idOf(showtime.auditorium));
    const customer = customerById.get(idOf(booking.user));
    return {
      _id: booking._id,
      bookingCode: booking.bookingCode,
      status: booking.status,
      seats: booking.seats,
      unitPrice: booking.unitPrice,
      totalAmount: booking.totalAmount,
      bookedAt: booking.bookedAt,
      cancelledAt: booking.cancelledAt,
      // 'paid' for bookings made before payments existed
      paymentStatus: booking.paymentStatus || (booking.status === 'confirmed' ? 'paid' : null),
      holdExpiresAt: booking.status === 'pending' ? booking.holdExpiresAt : null,
      payment: payments.publicPayment(paymentByBooking.get(idOf(booking))),
      paymentMode: payments.PAYMENT_MODE,
      cancellation: cancellationInfo(booking, showtime, paymentByBooking.get(idOf(booking))),
      showtime: showtime
        ? {
          _id: showtime._id,
          startTime: showtime.startTime,
          endTime: showtime.endTime,
          status: showtime.status,
          rescheduledAt: showtime.rescheduledAt || null,
          originalStartTime: showtime.originalStartTime || null,
        }
        : { _id: booking.showtime },
      movie: movie
        ? { _id: movie._id, title: movie.title, posterUrl: movie.posterUrl, rating: movie.rating, duration: movie.duration }
        : null,
      auditorium: auditorium ? { _id: auditorium._id, name: auditorium.name } : null,
      ...(admin ? { user: customer ? { _id: customer._id, name: customer.name, email: customer.email } : { _id: booking.user } } : {}),
    };
  });
}

module.exports = { createBooking, cancelBooking, describeBookings, canAccess, MAX_SEATS_PER_BOOKING };
