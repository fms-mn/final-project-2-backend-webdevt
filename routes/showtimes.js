const express = require('express');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const SeatClaim = require('../models/SeatClaim');
const { adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { isObjectId, requireId, dayRange, badRequest } = require('../utils/validate');
const service = require('../services/showtimes');

const router = express.Router();

const pageOptions = (query) => ({
  limit: Math.min(200, Math.max(1, parseInt(query.limit, 10) || 100)),
  page: Math.max(1, parseInt(query.page, 10) || 1),
});

// Shared by the public and admin listings: ?movie=<id>&date=YYYY-MM-DD (the cinema's local day).
function listFilter(query) {
  const filter = {};
  if (query.movie !== undefined) {
    if (!isObjectId(query.movie)) throw badRequest({ movie: 'movie must be a movie id' });
    filter.movie = query.movie;
  }
  if (query.date !== undefined) {
    const range = dayRange(query.date);
    if (!range) throw badRequest({ date: 'date must look like 2026-10-31' });
    filter.startTime = { $gte: range.start, $lt: range.end };
  }
  return filter;
}

// Public: showtimes that can still be booked.
router.get('/', wrap(async (req, res) => {
  const filter = { ...listFilter(req.query), status: 'scheduled' };
  const now = new Date();
  // Never earlier than now, even when a date filter is also given.
  filter.startTime = { ...(filter.startTime || {}), $gt: now };
  const { limit, page } = pageOptions(req.query);

  const showtimes = await Showtime.find(filter).sort({ startTime: 1 }).skip((page - 1) * limit).limit(limit);
  res.json(await service.describeShowtimes(showtimes, { publicOnly: true }));
}));

// Public: every seat of the showtime's auditorium, with whether it is taken. No customer info.
router.get('/:id/seats', wrap(async (req, res) => {
  requireId(req.params.id, 'Showtime');
  const showtime = await Showtime.findById(req.params.id);
  if (!showtime || showtime.status !== 'scheduled') throw new HttpError(404, 'Showtime not found');
  const [movie, auditorium, claims] = await Promise.all([
    Movie.findById(showtime.movie),
    Auditorium.findById(showtime.auditorium),
    SeatClaim.find({ showtime: showtime._id }).select('seatLabel'),
  ]);
  if (!movie || movie.status !== 'published' || !auditorium) throw new HttpError(404, 'Showtime not found');

  const taken = new Set(claims.map((claim) => claim.seatLabel));
  res.json({
    showtime: {
      _id: showtime._id,
      startTime: showtime.startTime,
      endTime: showtime.endTime,
      ticketPrice: showtime.ticketPrice,
      bookable: showtime.startTime > new Date(),
    },
    auditorium: { _id: auditorium._id, name: auditorium.name, rows: auditorium.rows, seatsPerRow: auditorium.seatsPerRow },
    seats: auditorium.seatLabels.map((label) => ({ label, status: taken.has(label) ? 'booked' : 'available' })),
  });
}));

// ---- Admin ---------------------------------------------------------------------------------
router.post('/', adminAuth, wrap(async (req, res) => {
  res.status(201).json(await service.createShowtime(req.body));
}));

router.patch('/:id/cancel', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Showtime');
  res.json(await service.cancelShowtime(req.params.id));
}));

router.patch('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Showtime');
  res.json(await service.updateShowtime(req.params.id, req.body));
}));

router.delete('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Showtime');
  await service.deleteShowtime(req.params.id);
  res.json({ message: 'Showtime deleted' });
}));

// Mounted at /api/admin/showtimes: every schedule in every status, past and future.
const adminRouter = express.Router();
adminRouter.get('/', adminAuth, wrap(async (req, res) => {
  const filter = listFilter(req.query);
  if (req.query.status !== undefined) {
    if (!['scheduled', 'cancelled'].includes(req.query.status)) {
      throw badRequest({ status: 'status must be scheduled or cancelled' });
    }
    filter.status = req.query.status;
  }
  if (req.query.auditorium !== undefined) {
    if (!isObjectId(req.query.auditorium)) throw badRequest({ auditorium: 'auditorium must be an auditorium id' });
    filter.auditorium = req.query.auditorium;
  }
  const { limit, page } = pageOptions(req.query);
  const showtimes = await Showtime.find(filter).sort({ startTime: -1 }).skip((page - 1) * limit).limit(limit);
  res.json(await service.describeShowtimes(showtimes, { publicOnly: false }));
}));

module.exports = router;
module.exports.adminRouter = adminRouter;
