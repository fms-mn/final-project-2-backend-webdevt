// The admin's tools for running the schedule: scheduling many showings at once, copying a day,
// moving a showing that already has bookings, hiding a showing from customers, and blocking seats.
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const { HttpError } = require('../utils/http');
const { withTransaction } = require('../utils/transaction');
const { isObjectId, dayRange, badRequest, collectErrors } = require('../utils/validate');
const { atManila, daysBetween, manilaClock, manilaLabel, weekdayOf } = require('../utils/manila');
const { getSettings } = require('./settings');
const payments = require('./payments');
const notifications = require('./mail/notifications');
const {
  idOf, blockedSet, loadReferences, lockAuditorium, findClash, clashError, assertFuture, assertReleased, beforeRelease, releaseMessage,
} = require('./showtimes');

const MAX_DAYS = 31;
const MAX_SLOTS = 200;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

// A slot that cannot be scheduled. Carries the reason an admin reads, never reaches the client as 500.
class SlotProblem extends Error {}

// ---- scheduling many showings -------------------------------------------------------------
function readBulk(body = {}) {
  return collectErrors((fail) => {
    const input = {};
    if (!isObjectId(body.movie)) fail('movie', 'movie must be a movie id'); else input.movie = body.movie;
    if (!isObjectId(body.auditorium)) fail('auditorium', 'auditorium must be an auditorium id'); else input.auditorium = body.auditorium;
    if (!dayRange(body.startDate)) fail('startDate', 'startDate must look like 2026-10-31'); else input.startDate = body.startDate;
    const endDate = body.endDate === undefined ? body.startDate : body.endDate;
    if (!dayRange(endDate)) fail('endDate', 'endDate must look like 2026-10-31'); else input.endDate = endDate;
    if (input.startDate && input.endDate) {
      if (input.endDate < input.startDate) fail('endDate', 'endDate must not be before startDate');
      else if (daysBetween(input.startDate, input.endDate).length > MAX_DAYS) fail('endDate', `Schedule at most ${MAX_DAYS} days at a time`);
    }
    if (!Array.isArray(body.times) || body.times.length === 0 || body.times.length > 20
      || !body.times.every((time) => typeof time === 'string' && CLOCK.test(time))) {
      fail('times', 'times must be 1 to 20 start times such as "13:30" (cinema time)');
    } else if (new Set(body.times).size !== body.times.length) {
      fail('times', 'Each start time can only be listed once');
    } else {
      input.times = [...body.times].sort();
    }
    if (body.weekdays !== undefined) {
      if (!Array.isArray(body.weekdays) || !body.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
        fail('weekdays', 'weekdays must be numbers from 0 (Sunday) to 6 (Saturday)');
      } else {
        input.weekdays = body.weekdays;
      }
    }
    if (!Number.isInteger(body.ticketPrice) || body.ticketPrice < 0) {
      fail('ticketPrice', 'ticketPrice must be a whole number of centavos (400.00 pesos is 40000)');
    } else {
      input.ticketPrice = body.ticketPrice;
    }
    for (const flag of ['published', 'skipConflicts', 'dryRun']) {
      if (body[flag] !== undefined && typeof body[flag] !== 'boolean') fail(flag, `${flag} must be true or false`);
    }
    Object.assign(input, {
      published: body.published ?? true, skipConflicts: body.skipConflicts ?? false, dryRun: body.dryRun ?? false,
    });
    if (input.startDate && input.endDate && input.times) {
      const days = daysBetween(input.startDate, input.endDate)
        .filter((day) => !input.weekdays || input.weekdays.includes(weekdayOf(day)));
      if (days.length * input.times.length > MAX_SLOTS) fail('times', `That is more than ${MAX_SLOTS} showings. Pick fewer days or times`);
      input.slots = days.flatMap((day) => input.times.map((time) => atManila(day, time)));
      if (input.slots.length === 0) fail('weekdays', 'None of the chosen days fall on those weekdays');
    }
    return input;
  });
}

// Tries every slot inside ONE transaction. A slot that cannot be scheduled (past, clashing with
// another showing or with the turnaround gap, movie unpublished, room inactive) is either listed
// as skipped (skipConflicts / dryRun) or makes the whole request fail with nothing saved.
async function scheduleSlots(slots, { skipConflicts, dryRun, now = new Date() }) {
  return withTransaction(async (session) => {
    const { turnaroundMinutes } = await getSettings(session);
    const movies = new Map();
    const rooms = new Map();
    const locked = new Set();
    const planned = []; // [{ auditorium, start, end }] decided earlier in this request
    const created = [];
    const skipped = [];

    const cached = async (cache, model, id) => {
      if (!cache.has(id)) cache.set(id, await model.findById(id).session(session));
      return cache.get(id);
    };

    for (const slot of [...slots].sort((a, b) => a.startTime - b.startTime)) {
      try {
        if (slot.startTime <= now) throw new SlotProblem('That time has already passed');
        const movie = await cached(movies, Movie, slot.movie);
        if (!movie) throw new SlotProblem('The movie no longer exists');
        if (movie.status === 'archived') throw new SlotProblem(`"${movie.title}" is archived`);
        if (beforeRelease(movie, slot.startTime)) throw new SlotProblem(releaseMessage(movie));
        const room = await cached(rooms, Auditorium, slot.auditorium);
        if (!room) throw new SlotProblem('The auditorium no longer exists');
        if (!room.isActive) throw new SlotProblem(`${room.name} is not active`);

        const endTime = Showtime.computeEndTime(slot.startTime, movie.duration);
        const gap = turnaroundMinutes * 60 * 1000;
        const near = planned.find((other) => other.auditorium === slot.auditorium
          && other.start < endTime.getTime() + gap && other.end > slot.startTime.getTime() - gap);
        if (near) throw new SlotProblem(`Clashes with another showing in this same request (${manilaLabel(near.start)})`);
        const clash = await findClash({
          auditoriumId: slot.auditorium, startTime: slot.startTime, endTime, turnaroundMinutes, session,
        });
        if (clash) throw new SlotProblem(clashError(clash, slot.startTime, endTime, turnaroundMinutes).message);

        planned.push({ auditorium: slot.auditorium, start: slot.startTime.getTime(), end: endTime.getTime() });
        if (dryRun) {
          created.push({ movie: slot.movie, auditorium: slot.auditorium, startTime: slot.startTime, endTime });
          continue;
        }
        if (!locked.has(slot.auditorium)) {
          await lockAuditorium(slot.auditorium, session);
          locked.add(slot.auditorium);
        }
        const showtime = new Showtime({
          movie: slot.movie,
          auditorium: slot.auditorium,
          startTime: slot.startTime,
          endTime,
          ticketPrice: slot.ticketPrice,
          isPublished: slot.published,
        });
        await showtime.save({ session });
        created.push({ _id: showtime._id, movie: slot.movie, auditorium: slot.auditorium, startTime: showtime.startTime, endTime });
      } catch (error) {
        if (!(error instanceof SlotProblem)) throw error;
        skipped.push({ startTime: slot.startTime, label: manilaLabel(slot.startTime), reason: error.message });
      }
    }

    if (skipped.length && !skipConflicts && !dryRun) {
      throw new HttpError(409, `${skipped.length} of ${slots.length} showings cannot be scheduled, so none were saved`, {
        errors: Object.fromEntries(skipped.map((item) => [item.label, item.reason])),
      });
    }
    return {
      dryRun, requested: slots.length, createdCount: created.length, skippedCount: skipped.length, created, skipped,
    };
  });
}

async function bulkSchedule(body, now = new Date()) {
  const input = readBulk(body);
  // A wrong movie or room is a mistake in the request, not a slot problem.
  await withTransaction((session) => loadReferences({ movieId: input.movie, auditoriumId: input.auditorium, session }));
  return scheduleSlots(
    input.slots.map((startTime) => ({
      movie: input.movie, auditorium: input.auditorium, startTime, ticketPrice: input.ticketPrice, published: input.published,
    })),
    { skipConflicts: input.skipConflicts, dryRun: input.dryRun, now },
  );
}

// Copies every scheduled showing of one day (same movie, room, clock time and price) to other days.
async function copyDay(body = {}, now = new Date()) {
  const input = collectErrors((fail) => {
    const found = {};
    const range = dayRange(body.fromDate);
    if (!range) fail('fromDate', 'fromDate must look like 2026-10-31'); else found.range = range;
    found.fromDate = body.fromDate;
    if (!Array.isArray(body.toDates) || body.toDates.length === 0 || body.toDates.length > MAX_DAYS
      || !body.toDates.every((day) => dayRange(day))) {
      fail('toDates', `toDates must be 1 to ${MAX_DAYS} days such as "2026-10-31"`);
    } else if (new Set(body.toDates).size !== body.toDates.length || body.toDates.includes(body.fromDate)) {
      fail('toDates', 'List each target day once, and not the day being copied');
    } else {
      found.toDates = [...body.toDates].sort();
    }
    for (const field of ['movie', 'auditorium']) {
      if (body[field] !== undefined && !isObjectId(body[field])) fail(field, `${field} must be an id`);
    }
    for (const flag of ['published', 'skipConflicts', 'dryRun']) {
      if (body[flag] !== undefined && typeof body[flag] !== 'boolean') fail(flag, `${flag} must be true or false`);
    }
    return { ...found, movie: body.movie, auditorium: body.auditorium, published: body.published, skipConflicts: body.skipConflicts ?? false, dryRun: body.dryRun ?? false };
  });

  const filter = { status: 'scheduled', startTime: { $gte: input.range.start, $lt: input.range.end } };
  if (input.movie) filter.movie = input.movie;
  if (input.auditorium) filter.auditorium = input.auditorium;
  const sources = await Showtime.find(filter).sort({ startTime: 1 });
  if (sources.length === 0) throw badRequest({ fromDate: 'There are no scheduled showings on that day to copy' });

  const slots = input.toDates.flatMap((day) => sources.map((source) => ({
    movie: idOf(source.movie),
    auditorium: idOf(source.auditorium),
    startTime: atManila(day, manilaClock(source.startTime)),
    ticketPrice: source.ticketPrice,
    published: input.published ?? source.isPublished !== false,
  })));
  if (slots.length > MAX_SLOTS) throw badRequest({ toDates: `That is more than ${MAX_SLOTS} showings. Pick fewer days` });
  return scheduleSlots(slots, { skipConflicts: input.skipConflicts, dryRun: input.dryRun, now });
}

// ---- moving a showing that already has bookings --------------------------------------------
// The customers' bookings stay attached and keep their seats and price. The new time must be in
// the future and free in the room; a new room must have every booked seat unblocked.
async function rescheduleShowtime(id, body = {}, now = new Date()) {
  const input = collectErrors((fail) => {
    const found = {};
    if (body.startTime !== undefined) {
      const start = typeof body.startTime === 'string' ? new Date(body.startTime) : null;
      if (!start || Number.isNaN(start.getTime())) fail('startTime', 'startTime must be a valid date and time'); else found.startTime = start;
    }
    if (body.auditorium !== undefined) {
      if (!isObjectId(body.auditorium)) fail('auditorium', 'auditorium must be an auditorium id'); else found.auditorium = body.auditorium;
    }
    if (body.startTime === undefined && body.auditorium === undefined) fail('body', 'Send startTime, auditorium or both');
    return found;
  });
  if (isObjectId(id)) await payments.expireHolds({ showtimeId: id }); // timed-out holds hold no seats

  let before = null; // where the showing was, for the email to customers who already booked it
  const moved = await withTransaction(async (session) => {
    before = null;
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (showtime.status !== 'scheduled') throw new HttpError(409, 'A cancelled showtime cannot be moved');
    if (showtime.startTime <= now) throw new HttpError(409, 'A showtime that has started cannot be moved');

    const movie = await Movie.findById(showtime.movie).session(session);
    if (!movie) throw new HttpError(409, 'This showtime has no movie');
    const nextStart = input.startTime ?? showtime.startTime;
    const nextRoomId = input.auditorium ?? idOf(showtime.auditorium);
    assertFuture(nextStart, now);
    assertReleased(movie, nextStart);
    const room = await Auditorium.findById(nextRoomId).session(session);
    if (!room) throw badRequest({ auditorium: 'Auditorium not found' });
    if (!room.isActive) throw badRequest({ auditorium: 'Auditorium is not active' });

    if (nextRoomId !== idOf(showtime.auditorium)) {
      const claims = await SeatClaim.find({ showtime: showtime._id }).session(session);
      const blocked = blockedSet(room, showtime);
      const unusable = claims.map((claim) => claim.seatLabel)
        .filter((label) => !room.seatLabels.includes(label) || blocked.has(label));
      if (unusable.length) {
        throw new HttpError(409, `${room.name} cannot take these booked seats: ${unusable.join(', ')}`);
      }
    }

    const { turnaroundMinutes } = await getSettings(session);
    const endTime = Showtime.computeEndTime(nextStart, movie.duration);
    for (const roomId of new Set([idOf(showtime.auditorium), nextRoomId])) await lockAuditorium(roomId, session);
    const clash = await findClash({
      auditoriumId: nextRoomId, startTime: nextStart, endTime, excludeId: showtime._id, turnaroundMinutes, session,
    });
    if (clash) throw clashError(clash, nextStart, endTime, turnaroundMinutes);

    before = { startTime: showtime.startTime, auditoriumId: idOf(showtime.auditorium) };
    showtime.originalStartTime = showtime.originalStartTime || showtime.startTime;
    showtime.rescheduledAt = now;
    // Seats blocked for this showing that the new room does not have are dropped with the move.
    const blockedSeats = (showtime.blockedSeats || []).filter((label) => room.seatLabels.includes(label));
    showtime.set({ auditorium: nextRoomId, startTime: nextStart, endTime, blockedSeats });
    await showtime.save({ session });
    return showtime;
  });
  // Customers who already booked it hear about the change (only when the time or the room changed).
  const changed = before && (new Date(before.startTime).getTime() !== new Date(moved.startTime).getTime()
    || before.auditoriumId !== idOf(moved.auditorium));
  if (changed) notifications.showingMoved(moved._id, before);
  return moved;
}

// ---- hiding a showing from customers --------------------------------------------------------
// A showing with confirmed bookings cannot be hidden: those customers hold tickets for it.
async function setVisibility(id, body = {}, now = new Date()) {
  if (typeof body.published !== 'boolean') throw badRequest({ published: 'published must be true or false' });
  return withTransaction(async (session) => {
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (showtime.status !== 'scheduled') throw new HttpError(409, 'A cancelled showtime cannot be shown or hidden');
    if (showtime.startTime <= now) throw new HttpError(409, 'A showtime that has started cannot be shown or hidden');
    if (!body.published && await Booking.exists({ showtime: showtime._id, status: 'confirmed' }).session(session)) {
      throw new HttpError(409, 'Customers already hold tickets for this showtime, so it cannot be hidden. Cancel it instead');
    }
    showtime.isPublished = body.published;
    await showtime.save({ session }); // written, so a booking made at the same moment conflicts
    return showtime;
  });
}

// ---- blocking seats -------------------------------------------------------------------------
function readSeats(body, labels) {
  return collectErrors((fail) => {
    if (!Array.isArray(body.seats) || !body.seats.every((seat) => typeof seat === 'string' && seat.trim())) {
      fail('seats', 'seats must be a list of seat labels such as ["A1", "A2"] (an empty list unblocks everything)');
      return [];
    }
    const seats = [...new Set(body.seats.map((seat) => seat.trim().toUpperCase()))].sort();
    const unknown = seats.filter((seat) => !labels.includes(seat));
    if (unknown.length) fail('seats', `Not a seat in this auditorium: ${unknown.join(', ')}`);
    return seats;
  });
}

const sameSeats = (a, b) => a.length === b.length && a.every((seat, index) => seat === b[index]);

// Replaces the auditorium's blocked seats. A seat cannot be newly blocked while a customer holds
// it at a coming showing.
async function setRoomBlockedSeats(id, body = {}, now = new Date()) {
  return withTransaction(async (session) => {
    const room = await Auditorium.findById(id).session(session);
    if (!room) throw new HttpError(404, 'Auditorium not found');
    const seats = readSeats(body, room.seatLabels);
    const newly = seats.filter((seat) => !(room.blockedSeats || []).includes(seat));
    const coming = await Showtime.find({ auditorium: room._id, status: 'scheduled', startTime: { $gt: now } }).session(session);
    if (newly.length) {
      const held = await SeatClaim.find({ showtime: { $in: coming.map((s) => s._id) }, seatLabel: { $in: newly } }).session(session);
      if (held.length) {
        const labels = [...new Set(held.map((claim) => claim.seatLabel))].sort();
        throw new HttpError(409, `Customers hold ${labels.join(', ')} at coming showings, so those seats cannot be blocked. Cancel or move those bookings first`);
      }
    }
    if (!sameSeats(seats, [...(room.blockedSeats || [])].sort())) {
      // Written on every coming showing, so a booking made at the same moment conflicts and re-checks.
      await Showtime.updateMany({ _id: { $in: coming.map((s) => s._id) } }, { $inc: { bookingRevision: 1 } }, { session });
      room.blockedSeats = seats;
      await room.save({ session });
    }
    return room;
  });
}

// Replaces the seats blocked for this one showing.
async function setShowtimeBlockedSeats(id, body = {}, now = new Date()) {
  if (isObjectId(id)) await payments.expireHolds({ showtimeId: id }); // timed-out holds hold nothing
  return withTransaction(async (session) => {
    const showtime = await Showtime.findById(id).session(session);
    if (!showtime) throw new HttpError(404, 'Showtime not found');
    if (showtime.status !== 'scheduled') throw new HttpError(409, 'A cancelled showtime cannot change its blocked seats');
    if (showtime.startTime <= now) throw new HttpError(409, 'A showtime that has started cannot change its blocked seats');
    const room = await Auditorium.findById(showtime.auditorium).session(session);
    if (!room) throw new HttpError(409, 'This showtime has no auditorium');
    const seats = readSeats(body, room.seatLabels);
    const newly = seats.filter((seat) => !(showtime.blockedSeats || []).includes(seat));
    if (newly.length) {
      const held = await SeatClaim.find({ showtime: showtime._id, seatLabel: { $in: newly } }).session(session);
      if (held.length) {
        throw new HttpError(409, `Customers hold ${held.map((claim) => claim.seatLabel).sort().join(', ')}, so those seats cannot be blocked. Cancel those bookings first`);
      }
    }
    showtime.blockedSeats = seats;
    await showtime.save({ session });
    return showtime;
  });
}

module.exports = {
  bulkSchedule, copyDay, rescheduleShowtime, setVisibility, setRoomBlockedSeats, setShowtimeBlockedSeats,
};
