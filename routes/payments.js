const express = require('express');
const { auth } = require('../middleware/auth');
const { wrap } = require('../utils/http');
const { requireId } = require('../utils/validate');
const payments = require('../services/payments');
const bookings = require('../services/bookings');

const router = express.Router();

// The simulated wallet app (GCash / Maya): { approve: true } confirms the booking,
// { approve: false } declines the payment and keeps the hold so the customer can try again.
router.post('/:id/authorize', auth, wrap(async (req, res) => {
  requireId(req.params.id, 'Payment');
  const result = await payments.authorizeWallet(req.user._id, req.params.id, req.body?.approve);
  const [described] = await bookings.describeBookings([result.booking]);
  res.json({ booking: described, payment: payments.publicPayment(result.payment) });
}));

module.exports = router;
