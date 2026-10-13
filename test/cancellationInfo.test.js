const test = require('node:test');
const assert = require('node:assert/strict');
const { cancellationInfo } = require('../services/cancellationInfo');
const now = new Date('2026-10-13T12:00:00Z');
const future = { startTime: new Date('2026-10-14T12:00:00Z') };
const booking = { status: 'confirmed', paymentStatus: 'paid', totalAmount: 90000 };
const paid = { status: 'paid', amount: 80000 };

test('refund preview uses the full payment amount, not a client or ticket total', () => {
  const result = cancellationInfo(booking, future, paid, now);
  assert.equal(result.eligible, true);
  assert.equal(result.refund.status, 'available');
  assert.equal(result.refund.amount, 80000);
  assert.equal(result.refund.mode, 'simulated');
});
test('unpaid and pending bookings have no payment to refund', () => {
  const result = cancellationInfo({ status: 'pending', paymentStatus: 'unpaid' }, { startTime: now }, null, now);
  assert.equal(result.eligible, true, 'a pending hold can be released');
  assert.equal(result.refund.status, 'none');
});
test('started bookings cannot be cancelled or promised refunds', () => {
  const result = cancellationInfo(booking, { startTime: now }, paid, now);
  assert.equal(result.eligible, false);
  assert.equal(result.refund.status, 'non_refundable');
  assert.match(result.reason, /already started/);
});
test('already refunded payments do not produce an additional refund', () => {
  const result = cancellationInfo({ ...booking, status: 'cancelled', paymentStatus: 'refunded' }, future, { status: 'refunded', amount: 80000, refundReference: 'RF-EXAMPLE' }, now);
  assert.equal(result.refund.status, 'refunded');
  assert.equal(result.refund.amount, 80000);
  assert.equal(result.refund.reference, 'RF-EXAMPLE');
  assert.match(result.refund.reason, /No additional refund/);
});
test('legacy, missing and inconsistent payment records remain unavailable', () => {
  for (const payment of [null, { status: 'failed', amount: 80000 }, { status: 'paid' }]) {
    assert.equal(cancellationInfo(booking, future, payment, now).refund.status, 'unavailable');
  }
  assert.equal(cancellationInfo({ status: 'confirmed' }, future, null, now).refund.status, 'unavailable');
  const cancelled = cancellationInfo({ ...booking, status: 'cancelled' }, future, paid, now);
  assert.equal(cancelled.refund.status, 'unavailable', 'cancellation alone cannot prove a refund');
});
