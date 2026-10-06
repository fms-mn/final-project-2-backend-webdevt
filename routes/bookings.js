const express = require('express');
const Booking = require('../models/Booking');
const Showtime = require('../models/Showtime');
const { auth, adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { isObjectId, requireId, dayRange, badRequest } = require('../utils/validate');
const service = require('../services/bookings');

const router = express.Router();

const pageOptions = (query) => ({
  limit: Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50)),
  page: Math.max(1, parseInt(query.page, 10) || 1),
});

function statusFilter(query) {
  if (query.status === undefined) return {};
  if (!['confirmed', 'cancelled'].includes(query.status)) {
    throw badRequest({ status: 'status must be confirmed or cancelled' });
  }
  return { status: query.status };
}

// Book seats. The body only needs { showtime, seats: ["A1", "A2"] }: the owner, price, total and
// booking code are set by the server.
router.post('/', auth, wrap(async (req, res) => {
  const booking = await service.createBooking(req.user._id, req.body);
  const [described] = await service.describeBookings([booking]);
  res.status(201).json(described);
}));

// The signed-in customer's own bookings, newest first. Cancelled ones stay in the list.
router.get('/my', auth, wrap(async (req, res) => {
  const { limit, page } = pageOptions(req.query);
  const bookings = await Booking.find({ user: req.user._id, ...statusFilter(req.query) })
    .sort({ bookedAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.json(await service.describeBookings(bookings));
}));

// Admin: every booking. Filters: status, showtime (id), date (the showtime's day in Asia/Manila).
router.get('/', adminAuth, wrap(async (req, res) => {
  const filter = statusFilter(req.query);
  const { showtime, date } = req.query;
  if (showtime !== undefined && !isObjectId(showtime)) throw badRequest({ showtime: 'showtime must be a showtime id' });
  if (date !== undefined) {
    const range = dayRange(date);
    if (!range) throw badRequest({ date: 'date must look like 2026-10-31' });
    const onThatDay = await Showtime.find({
      startTime: { $gte: range.start, $lt: range.end },
      ...(showtime ? { _id: showtime } : {}),
    });
    filter.showtime = { $in: onThatDay.map((s) => s._id) };
  } else if (showtime) {
    filter.showtime = showtime;
  }
  const { limit, page } = pageOptions(req.query);
  const bookings = await Booking.find(filter).sort({ bookedAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.json(await service.describeBookings(bookings, { admin: true }));
}));

// One booking: its owner or an admin. Anyone else gets 404, so ids reveal nothing.
router.get('/:id', auth, wrap(async (req, res) => {
  requireId(req.params.id, 'Booking');
  const booking = await Booking.findById(req.params.id);
  if (!booking || !service.canAccess(req.user, booking)) throw new HttpError(404, 'Booking not found');
  const [described] = await service.describeBookings([booking], { admin: req.user.role === 'admin' });
  res.json(described);
}));

router.patch('/:id/cancel', auth, wrap(async (req, res) => {
  requireId(req.params.id, 'Booking');
  const booking = await service.cancelBooking(req.params.id, req.user);
  const [described] = await service.describeBookings([booking], { admin: req.user.role === 'admin' });
  res.json(described);
}));

module.exports = router;
