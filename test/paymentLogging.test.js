const test = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler } = require('../middleware/errorHandler');

test('unexpected payment errors never log payment inputs', () => {
  const originalLogger = console.error;
  const originalEnvironment = process.env.NODE_ENV;
  const logs = [];
  const res = { status() { return this; }, json(value) { this.body = value; } };
  try {
    process.env.NODE_ENV = 'production';
    console.error = (...args) => logs.push(args);
    for (const originalUrl of ['/api/bookings/example/pay', '/api/payments/example/authorize']) {
      errorHandler(new Error('4242424242424242 cvc=123 mobile=09171234567'), { originalUrl }, res);
      assert.deepEqual(res.body, { message: 'Server error' });
    }
    assert.deepEqual(logs, [
      [{ message: 'Payment request failed', name: 'Error' }],
      [{ message: 'Payment request failed', name: 'Error' }],
    ]);
  } finally {
    console.error = originalLogger;
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
  }
});
