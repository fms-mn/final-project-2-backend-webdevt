// Offline route tests: only requests that are answered before any database access
// (authentication, input checks), so they run without MongoDB.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'offline-test-secret';

const authRoutes = require('../routes/auth');
const movieRoutes = require('../routes/movies');
const bookingRoutes = require('../routes/bookings');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/movies', movieRoutes);
  app.use('/api/bookings', bookingRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, route, { token, body } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { /* no body */ }
  return { status: response.status, data };
}

test('protected routes answer 401 without a token', async () => {
  for (const [method, route] of [
    ['GET', '/auth/me'],
    ['GET', '/bookings/my'],
    ['POST', '/bookings'],
    ['PATCH', '/bookings/abc/cancel'],
    ['POST', '/movies'],
    ['PUT', '/movies/abc'],
    ['DELETE', '/movies/abc'],
  ]) {
    const res = await call(method, route, { body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${route}`);
  }
});

test('garbage, wrongly signed and expired tokens answer 401', async () => {
  for (const token of [
    'not.a.token',
    jwt.sign({ id: 'x' }, 'some-other-secret'),
    jwt.sign({ id: 'x' }, process.env.JWT_SECRET, { expiresIn: -10 }),
  ]) {
    assert.equal((await call('GET', '/auth/me', { token })).status, 401);
  }
});

test('register rejects bad input before touching the database', async () => {
  const good = { name: 'Ann', email: 'ann@example.com', password: 'long-enough-1' };
  const cases = [
    [{ ...good, password: 'short' }, /at least 8/],
    [{ ...good, password: undefined }, /required/],
    [{ ...good, password: 'x'.repeat(73) }, /at most 72/],
    [{ ...good, email: { $gt: '' } }, /required/],
    [{ ...good, name: { $ne: null } }, /required/],
    [{ ...good, phone: 123 }, /Phone/],
  ];
  for (const [body, message] of cases) {
    const res = await call('POST', '/auth/register', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.data.message, message);
  }
});

test('login rejects non-string credentials (no query operators)', async () => {
  for (const body of [
    { email: { $gt: '' }, password: 'whatever-1' },
    { email: 'a@b.c', password: { $ne: '' } },
    { email: 'a@b.c' },
    {},
  ]) {
    const res = await call('POST', '/auth/login', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('a malformed movie id is a 404, not a server error', async () => {
  assert.equal((await call('GET', '/movies/not-an-object-id')).status, 404);
});
