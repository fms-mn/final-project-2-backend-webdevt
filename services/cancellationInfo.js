const { PAYMENT_MODE } = require('./payments');

function cancellationInfo(booking, showtime, payment, now = new Date()) {
  const finished = ['cancelled', 'expired'].includes(booking.status);
  const started = booking.status !== 'pending' && showtime && showtime.startTime <= now;
  const eligible = !finished && !started;
  const reason = finished ? 'This booking has already been cancelled or released.'
    : started ? 'This showtime has already started, so the booking can no longer be cancelled.' : null;
  const paymentStatus = booking.paymentStatus || (booking.status === 'confirmed' ? 'paid' : null);
  const amount = Number.isInteger(payment?.amount) && payment.amount >= 0 ? payment.amount : null;
  const refund = { mode: PAYMENT_MODE, amount: null, reference: null, status: 'unavailable', reason: 'Refund information is unavailable. The payment record could not be verified.' };
  if (paymentStatus === 'refunded' || payment?.status === 'refunded') {
    Object.assign(refund, { status: 'refunded', amount: payment?.status === 'refunded' ? amount : null, reference: payment?.status === 'refunded' ? payment.refundReference || null : null, reason: 'This payment is already refunded. No additional refund will be issued.' });
  } else if (!eligible && !finished) {
    Object.assign(refund, { status: 'non_refundable', reason });
  } else if (paymentStatus === 'unpaid') {
    Object.assign(refund, { status: 'none', reason: 'There is no payment to refund.' });
  } else if (paymentStatus === 'paid' && payment?.status === 'paid' && amount !== null && !finished) {
    Object.assign(refund, { status: 'available', amount, reason: null });
  }
  return { eligible, reason, paymentStatus, refund };
}

module.exports = { cancellationInfo };
