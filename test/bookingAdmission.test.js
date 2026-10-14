const test = require('node:test');
const assert = require('node:assert/strict');
const { createBookingAdmission } = require('../services/bookingAdmission');

const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

test('booking admission runs the same screening in order, including equivalent id casing', async () => {
  const admit = createBookingAdmission();
  const held = gate(), events = [];
  const first = admit('ABC', async () => { events.push('first'); await held.promise; events.push('finished'); });
  const second = admit('abc', async () => { events.push('second'); return 42; });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  held.release();
  assert.equal(await second, 42);
  await first;
  assert.deepEqual(events, ['first', 'finished', 'second']);
});

test('unrelated screenings proceed independently and failure releases the queue', async () => {
  const admit = createBookingAdmission();
  const held = gate();
  const first = admit('one', async () => { await held.promise; throw new Error('cancelled screening'); });
  const rejected = assert.rejects(first, /cancelled screening/);
  const next = admit('one', () => 'retry');
  assert.equal(await admit('two', () => 'independent'), 'independent');
  held.release();
  await rejected;
  assert.equal(await next, 'retry');
  assert.equal(await admit('one', () => 'new queue'), 'new queue');
});

test('per-screening admission is bounded and recovers its capacity', async () => {
  const admit = createBookingAdmission({ maxPerShowtime: 2 });
  const held = gate();
  const first = admit('one', () => held.promise);
  const second = admit('one', () => 'second');
  await assert.rejects(admit('one', () => assert.fail('must not run')), error => error.status === 503 && error.retryAfter === 1);
  assert.equal(await admit('two', () => 'independent'), 'independent');
  held.release();
  await Promise.all([first, second]);
  assert.equal(await admit('one', () => 'recovered'), 'recovered');
});

test('total admission is bounded across screenings and failure frees total capacity', async () => {
  const admit = createBookingAdmission({ maxTotal: 1 });
  const held = gate();
  const first = admit('one', async () => { await held.promise; throw new Error('failed'); });
  const rejected = assert.rejects(first, /failed/);
  await assert.rejects(admit('two', () => assert.fail('must not run')), error => error.status === 503);
  held.release();
  await rejected;
  assert.equal(await admit('two', () => 'recovered'), 'recovered');
});
