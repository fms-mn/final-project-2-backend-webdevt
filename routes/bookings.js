const express = require('express');
const Booking = require('../models/Booking');
const Showtime = require('../models/Showtime');
const { auth, adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { isObjectId, requireId, dayRange, badRequest } = require('../utils/validate');
const service = require('../services/bookings');
const payments = require('../services/payments');

const router = express.Router();

const pageOptions = (query) => ({
  limit: Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50)),
  page: Math.max(1, parseInt(query.page, 10) || 1),
});

// Customers see their tickets (confirmed or cancelled); an unpaid hold or an expired one is not a ticket.
const TICKET_STATUSES = ['confirmed', 'cancelled'];
const ALL_STATUSES = ['pending', 'confirmed', 'cancelled', 'expired'];

function statusFilter(query, { allowed = TICKET_STATUSES, fallback = TICKET_STATUSES } = {}) {
  if (query.status === undefined) return { status: { $in: fallback } };
  if (!allowed.includes(query.status)) {
    throw badRequest({ status: `status must be ${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]}` });
  }
  return { status: query.status };
}

// Book seats. The body only needs { showtime, seats: ["A1", "A2"] }: the owner, price, total and
// booking code are set by the server. With payments on, the answer is a pending booking that holds
// the seats until `holdExpiresAt`; pay for it with POST /:id/pay.
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
  const filter = statusFilter(req.query, { allowed: ALL_STATUSES, fallback: ['pending', 'confirmed', 'cancelled'] });
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

// Pay for a pending booking (simulated gateway, see services/payments.js).
//   card:          { method: "card", number, expiry: "MM/YY", cvc, name? }  -> 200 confirmed, or 402
//   gcash / maya:  { method: "gcash", mobile }  -> 202 with the payment to approve (POST /api/payments/:id/authorize)
router.post('/:id/pay', auth, wrap(async (req, res) => {
  requireId(req.params.id, 'Booking');
  const result = await payments.startPayment(req.user._id, req.params.id, req.body);
  const [described] = await service.describeBookings([result.booking]);
  res.status(result.awaitingApproval ? 202 : 200).json({ booking: described, payment: payments.publicPayment(result.payment), awaitingApproval: result.awaitingApproval });
}));

// Give up an unpaid hold: the seats go back on sale at once.
router.post('/:id/release', auth, wrap(async (req, res) => {
  requireId(req.params.id, 'Booking');
  const booking = await Booking.findById(req.params.id);
  if (!booking || !service.canAccess(req.user, booking)) throw new HttpError(404, 'Booking not found');
  if (booking.status === 'confirmed') throw new HttpError(409, 'This booking is already paid. Cancel it to get a refund.');
  await payments.releaseHold(booking._id, 'abandoned');
  const [described] = await service.describeBookings([await Booking.findById(booking._id)]);
  res.json(described);
}));

router.patch('/:id/cancel', auth, wrap(async (req, res) => {
  requireId(req.params.id, 'Booking');
  const booking = await service.cancelBooking(req.params.id, req.user);
  const [described] = await service.describeBookings([booking], { admin: req.user.role === 'admin' });
  res.json(described);
}));

module.exports = router;
