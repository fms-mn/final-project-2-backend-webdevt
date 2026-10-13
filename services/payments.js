const Booking = require('../models/Booking');
const Showtime = require('../models/Showtime');
const SeatClaim = require('../models/SeatClaim');
const Payment = require('../models/Payment');
const config = require('../config');
const PAYMENT_MODE = 'simulated';
const { HttpError } = require('../utils/http');
const { withTransaction } = require('../utils/transaction');
const { badRequest, collectErrors } = require('../utils/validate');

// A SIMULATED payment gateway. No real money moves and no card is ever contacted, but the flow is
// the one a real gateway has:
//
//   1. choosing seats holds them for HOLD_MINUTES (the booking is "pending", see services/bookings.js)
//   2. the customer pays: a card is charged at once, a wallet (GCash / Maya) is "approved" in a
//      second step, like a redirect to the wallet app
//   3. only a successful payment confirms the booking; a failed one leaves the hold in place so the
//      customer can try again; an expired or abandoned hold puts the seats back on sale
//   4. cancelling a paid booking refunds the payment
//
// Test cards (any future expiry, any 3-digit security code):
//   4242 4242 4242 4242  Visa, succeeds           5555 5555 5555 4444  Mastercard, succeeds
//   4000 0000 0000 0002  declined                 4000 0000 0000 9995  insufficient funds
//   4000 0000 0000 0069  expired card             4000 0000 0000 0127  wrong security code
//   4000 0000 0000 0119  processing error
// Any other number that passes the standard card-number check also succeeds.
const CARD_FAILURES = {
  '4000000000000002': ['card_declined', 'Your card was declined.'],
  '4000000000009995': ['insufficient_funds', 'Your card has insufficient funds.'],
  '4000000000000069': ['expired_card', 'Your card has expired.'],
  '4000000000000127': ['incorrect_cvc', "Your card's security code is incorrect."],
  '4000000000000119': ['processing_error', 'An error occurred while processing your card. Please try again.'],
};
const WALLET_NAMES = { gcash: 'GCash', maya: 'Maya' };
const EXPIRED_MESSAGE = 'Your seats were released because the payment time ran out. Please choose your seats again.';

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const idOf = (value) => String(value?._id ?? value);

// The standard card-number check (Luhn): catches a mistyped digit.
function passesLuhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

function cardBrand(digits) {
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'American Express';
  return 'Card';
}

// Reads and checks what the customer typed. Returns what the gateway needs.
function readPaymentInput(body = {}, now = new Date()) {
  return collectErrors((fail) => {
    const input = {};
    if (!['card', 'gcash', 'maya'].includes(body.method)) {
      fail('method', 'Choose how to pay: card, gcash or maya');
      return input;
    }
    input.method = body.method;

    if (body.method === 'card') {
      const digits = typeof body.number === 'string' ? body.number.replace(/[\s-]/g, '') : '';
      if (!/^\d{13,19}$/.test(digits) || !passesLuhn(digits)) fail('number', 'That card number is not valid');
      else input.digits = digits;

      let month = Number(body.expMonth);
      let year = Number(body.expYear);
      if (typeof body.expiry === 'string') {
        const match = body.expiry.trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
        if (match) { month = Number(match[1]); year = Number(match[2]); }
        else { month = NaN; year = NaN; }
      }
      if (year < 100) year += 2000;
      if (!Number.isInteger(month) || !Number.isInteger(year) || month < 1 || month > 12) {
        fail('expiry', 'Enter the expiry date as MM/YY');
      } else if (new Date(Date.UTC(year, month, 1)) <= now) {
        fail('expiry', 'That card has expired');
      }

      const amex = input.digits && /^3[47]/.test(input.digits);
      const cvc = typeof body.cvc === 'string' ? body.cvc.trim() : '';
      if (!(amex ? /^\d{4}$/.test(cvc) : /^\d{3}$/.test(cvc))) fail('cvc', `Enter the ${amex ? '4' : '3'}-digit security code`);
    } else {
      const mobile = typeof body.mobile === 'string' ? body.mobile.replace(/[\s-]/g, '') : '';
      const match = mobile.match(/^(?:\+?63|0)(9\d{9})$/);
      if (!match) fail('mobile', `Enter the mobile number linked to your ${WALLET_NAMES[body.method]} account, like 09171234567`);
      else input.mobile = `0${match[1]}`;
    }
    return input;
  });
}

function publicPayment(payment) {
  if (!payment) return null;
  return {
    _id: payment._id,
    mode: PAYMENT_MODE,
    reference: payment.reference,
    method: payment.method,
    status: payment.status,
    amount: payment.amount,
    cardBrand: payment.cardBrand || null,
    cardLast4: payment.cardLast4 || null,
    walletLast4: payment.walletLast4 || null,
    failureMessage: payment.failureMessage || null,
    paidAt: payment.paidAt || null,
    refundedAt: payment.refundedAt || null,
    refundReference: payment.refundReference || null,
  };
}

// ---- holds ---------------------------------------------------------------------------------
// Puts the seats of a pending booking back on sale. Safe to repeat: only a pending booking changes.
async function releaseHold(bookingId, reason, { session: outer } = {}) {
  const work = async (session) => {
    const booking = await Booking.findById(bookingId).session(session);
    if (!booking || booking.status !== 'pending') return false;
    booking.status = 'expired';
    booking.holdExpiresAt = undefined;
    await booking.save({ session });
    await SeatClaim.deleteMany({ booking: booking._id }, { session });
    await Payment.updateMany(
      { booking: booking._id, status: 'awaiting_approval' },
      { $set: { status: 'failed', failureCode: reason, failureMessage: 'The payment was not completed.' } },
      { session },
    );
    return true;
  };
  return outer ? work(outer) : withTransaction(work);
}

// Releases every hold whose time has run out (optionally only for one showtime). Called before
// seats are shown or taken, and by a timer on the server, so a hold never outlives its time.
async function expireHolds({ showtimeId, now = new Date() } = {}) {
  const filter = { status: 'pending', holdExpiresAt: { $lte: now } };
  if (showtimeId) filter.showtime = showtimeId;
  const expired = await Booking.find(filter);
  let released = 0;
  for (const booking of expired) {
    if (await releaseHold(booking._id, 'expired')) released += 1;
  }
  return released;
}

// A customer who starts over on a showtime replaces their own earlier, unpaid hold.
async function releaseUserHolds(userId, showtimeId) {
  const mine = await Booking.find({ user: userId, showtime: showtimeId, status: 'pending' });
  for (const booking of mine) await releaseHold(booking._id, 'replaced');
}

// ---- paying --------------------------------------------------------------------------------
async function loadPayableBooking(userId, bookingId, now) {
  const booking = await Booking.findById(bookingId);
  // Someone else's booking looks exactly like one that does not exist.
  if (!booking || idOf(booking.user) !== idOf(userId)) throw new HttpError(404, 'Booking not found');
  if (booking.status === 'confirmed') return { booking, alreadyPaid: true };
  if (booking.status !== 'pending') throw new HttpError(409, EXPIRED_MESSAGE);
  if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) {
    await releaseHold(booking._id, 'expired');
    throw new HttpError(409, EXPIRED_MESSAGE);
  }
  return { booking, alreadyPaid: false };
}

// Marks a payment paid and confirms its booking in ONE transaction.
async function settlePaid(paymentId, now = new Date()) {
  return withTransaction(async (session) => {
    const payment = await Payment.findById(paymentId).session(session);
    if (!payment) throw new HttpError(404, 'Payment not found');
    const booking = await Booking.findById(payment.booking).session(session);
    if (!booking) throw new HttpError(404, 'Booking not found');
    if (booking.status === 'confirmed' && payment.status === 'paid') return { booking, payment };
    if (booking.status !== 'pending' || !booking.holdExpiresAt || booking.holdExpiresAt <= now) {
      throw new HttpError(409, EXPIRED_MESSAGE);
    }
    const showtime = await Showtime.findById(booking.showtime).session(session);
    if (!showtime || showtime.status !== 'scheduled' || showtime.startTime <= now) {
      throw new HttpError(409, 'This showtime is no longer available, so the payment was not taken.');
    }

    payment.status = 'paid';
    payment.paidAt = now;
    await payment.save({ session });
    booking.status = 'confirmed';
    booking.paymentStatus = 'paid';
    booking.holdExpiresAt = undefined;
    booking.bookedAt = now; // revenue counts on the day it was paid
    await booking.save({ session });
    // Written last, like a booking: a concurrent cancellation of this showtime conflicts with it.
    await Showtime.updateOne({ _id: showtime._id }, { $inc: { bookingRevision: 1 } }, { session });
    return { booking, payment };
  });
}

async function recordFailure(payment, code, message) {
  payment.status = 'failed';
  payment.failureCode = code;
  payment.failureMessage = message;
  await payment.save();
  return new HttpError(402, message);
}

// Starts a payment for a pending booking. Cards are decided at once; a wallet payment waits for
// the customer to approve it (see authorizeWallet).
async function startPayment(userId, bookingId, body, now = new Date()) {
  const input = readPaymentInput(body, now);
  const { booking, alreadyPaid } = await loadPayableBooking(userId, bookingId, now);
  if (alreadyPaid) { // pressing Pay twice never charges twice
    const paid = await Payment.findOne({ booking: booking._id, status: 'paid' });
    return { booking, payment: paid, awaitingApproval: false };
  }

  // One open payment at a time: an earlier unfinished wallet payment is superseded.
  await Payment.updateMany(
    { booking: booking._id, status: 'awaiting_approval' },
    { $set: { status: 'failed', failureCode: 'replaced', failureMessage: 'A newer payment was started.' } },
  );
  const payment = new Payment({
    booking: booking._id,
    user: booking.user,
    amount: booking.totalAmount,
    method: input.method,
    reference: Payment.generateReference(),
    ...(input.method === 'card'
      ? { cardBrand: cardBrand(input.digits), cardLast4: input.digits.slice(-4) }
      : { walletLast4: input.mobile.slice(-4) }),
  });
  await payment.save();

  if (config.paymentDelayMs) await pause(config.paymentDelayMs);
  if (input.method !== 'card') return { booking, payment, awaitingApproval: true };

  const failure = CARD_FAILURES[input.digits];
  if (failure) throw await recordFailure(payment, failure[0], failure[1]);
  const settled = await settlePaid(payment._id, new Date());
  return { ...settled, awaitingApproval: false };
}

// The simulated wallet app: the customer approves or declines a wallet payment.
async function authorizeWallet(userId, paymentId, approve, now = new Date()) {
  if (typeof approve !== 'boolean') throw badRequest({ approve: 'approve must be true or false' });
  const payment = await Payment.findById(paymentId);
  if (!payment || idOf(payment.user) !== idOf(userId)) throw new HttpError(404, 'Payment not found');
  if (payment.status === 'paid') {
    return { booking: await Booking.findById(payment.booking), payment };
  }
  if (payment.status !== 'awaiting_approval') throw new HttpError(409, 'This payment is no longer waiting for approval.');
  await loadPayableBooking(userId, payment.booking, now);

  if (config.paymentDelayMs) await pause(config.paymentDelayMs);
  if (!approve) {
    throw await recordFailure(payment, 'declined_by_customer', `The payment was declined in ${WALLET_NAMES[payment.method]}.`);
  }
  return settlePaid(payment._id, new Date());
}

// ---- refunds -------------------------------------------------------------------------------
// Refunds the paid payment of a booking (inside the caller's transaction). Returns the payment.
async function refundBooking(booking, now, session) {
  if (booking.paymentStatus !== 'paid') return null;
  const payment = await Payment.findOne({ booking: booking._id, status: 'paid' }).session(session);
  if (payment) {
    payment.status = 'refunded';
    payment.refundedAt = now;
    payment.refundReference = Payment.generateRefundReference();
    await payment.save({ session });
  }
  booking.paymentStatus = 'refunded';
  return payment;
}

module.exports = {
  PAYMENT_MODE,
  startPayment,
  authorizeWallet,
  settlePaid,
  releaseHold,
  expireHolds,
  releaseUserHolds,
  refundBooking,
  publicPayment,
  readPaymentInput,
  passesLuhn,
  EXPIRED_MESSAGE,
};
