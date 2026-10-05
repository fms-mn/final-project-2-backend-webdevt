// Offline API tests. They run the REAL app (middleware, routes, error handling) but replace the
// User model's database calls with an in-memory list, so no MongoDB is needed.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.LOGIN_RATE_MAX = '3';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { createApp } = require('../app');
const User = require('../models/User');
const { resetAllLimiters } = require('../middleware/rateLimit');

const PASSWORD = 'correct-horse-1';
const COOKIE = 'filme_session';
let store = [];
let server;
let base;
let passwordHash;

// ---- fake database -------------------------------------------------------------------------
const thenable = (getValue, extra = {}) => ({
  ...extra,
  then: (resolve, reject) => Promise.resolve().then(getValue).then(resolve, reject),
});

function installFakeDatabase() {
  test.mock.method(User, 'findOne', async (filter) => store.find((u) => u.email === filter.email) || null);
  test.mock.method(User, 'findById', (id) => {
    const find = () => store.find((u) => String(u._id) === String(id)) || null;
    return thenable(find, { select: async () => find() });
  });
  test.mock.method(User, 'find', () => {
    let skip = 0;
    let limit = Infinity;
    const query = thenable(() => store.slice(skip, skip + limit));
    query.select = () => query;
    query.sort = () => query;
    query.skip = (n) => { skip = n; return query; };
    query.limit = (n) => { limit = n; return query; };
    return query;
  });
  test.mock.method(User, 'countDocuments', async () => store.length);
  test.mock.method(User.prototype, 'save', async function save() {
    if (!store.includes(this)) {
      if (store.some((u) => u.email === this.email)) {
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      store.push(this);
    }
    return this;
  });
}

function addUser({ email, role = 'user', isActive = true, name = 'Test Person' }) {
  const doc = new User({ name, email, passwordHash, role, isActive });
  doc.$isNew = false;
  store.push(doc);
  return doc;
}

// ---- tiny HTTP client that keeps a session -------------------------------------------------
async function call(method, path, { body, session, headers = {}, raw } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (session && session.cookie) requestHeaders.Cookie = session.cookie;
  if (session && session.csrf) requestHeaders['X-CSRF-Token'] = session.csrf;
  const response = await fetch(base + path, {
    method,
    headers: requestHeaders,
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try { data = await response.json(); } catch { /* no body */ }
  return { status: response.status, data, headers: response.headers, setCookies: response.headers.getSetCookie() };
}

const sessionFrom = (res) => ({
  cookie: res.setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE}=`)),
  csrf: res.data && res.data.csrfToken,
});

async function login(email, password = PASSWORD) {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return sessionFrom(res);
}

test.before(async () => {
  passwordHash = await User.hashPassword(PASSWORD);
  installFakeDatabase();
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  store = [];
  resetAllLimiters();
});

// ---- registration --------------------------------------------------------------------------
test('register: creates a regular user, starts a session, leaks no hash or token', async () => {
  const res = await call('POST', '/api/auth/register', {
    body: { name: 'Ann', email: ' ANN@Example.com ', password: PASSWORD, phone: '09171234567', role: 'admin' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.role, 'user', 'a submitted role must be ignored');
  assert.equal(res.data.user.email, 'ann@example.com');
  assert.equal(res.data.user.phone, '09171234567');
  assert.equal(typeof res.data.csrfToken, 'string');
  const text = JSON.stringify(res.data);
  assert.ok(!/passwordHash|"token"/.test(text) && !text.includes(PASSWORD));
  assert.equal(store.length, 1);
  assert.ok(store[0].passwordHash.startsWith('$2'));
  const cookie = res.setCookies.find((c) => c.startsWith(`${COOKIE}=`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /Secure/i, 'Secure is for production/HTTPS only');
});

test('register: bad input is a 400, a duplicate email is a 409', async () => {
  const ok = { name: 'Ann', email: 'ann@example.com', password: PASSWORD };
  for (const body of [
    { ...ok, password: 'short' },
    { ...ok, password: undefined },
    { ...ok, password: 'x'.repeat(73) },
    { ...ok, email: { $gt: '' } },
    { ...ok, name: ['a'] },
    { ...ok, phone: 42 },
  ]) {
    const res = await call('POST', '/api/auth/register', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof res.data.message, 'string');
  }
  assert.equal((await call('POST', '/api/auth/register', { body: ok })).status, 201);
  const duplicate = await call('POST', '/api/auth/register', { body: { ...ok, email: 'ANN@example.com' } });
  assert.equal(duplicate.status, 409);
  assert.equal(store.length, 1);
});

test('register: a database duplicate-key error (a race) is also a 409', async () => {
  test.mock.method(User, 'findOne', async () => null, { times: 1 });
  addUser({ email: 'race@example.com' });
  const res = await call('POST', '/api/auth/register', {
    body: { name: 'Race', email: 'race@example.com', password: PASSWORD },
  });
  assert.equal(res.status, 409);
});

// ---- login / logout ------------------------------------------------------------------------
test('login: success sets the cookie and returns the user and CSRF token', async () => {
  addUser({ email: 'ann@example.com' });
  const res = await call('POST', '/api/auth/login', { body: { email: 'ANN@example.com', password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, 'ann@example.com');
  assert.ok(res.data.csrfToken && !('token' in res.data));
  assert.ok(!JSON.stringify(res.data).includes('passwordHash'));
  const cookie = res.setCookies.find((c) => c.startsWith(`${COOKIE}=`));
  assert.match(cookie, /HttpOnly/i);
  const token = decodeURIComponent(cookie.split(';')[0].slice(COOKIE.length + 1));
  const claims = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(claims.csrf, res.data.csrfToken);
  assert.ok(claims.exp - claims.iat <= 2 * 3600 + 1, 'sessions should be short-lived');
});

test('login: wrong password and unknown email are both 401 with the same message', async () => {
  addUser({ email: 'ann@example.com' });
  const wrongPassword = await call('POST', '/api/auth/login', { body: { email: 'ann@example.com', password: 'nope-nope-1' } });
  const unknownEmail = await call('POST', '/api/auth/login', { body: { email: 'who@example.com', password: PASSWORD } });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(wrongPassword.data.message, unknownEmail.data.message);
  assert.equal(wrongPassword.setCookies.length, 0);
});

test('login: non-string credentials are a 400 (no query operators)', async () => {
  for (const body of [
    { email: { $gt: '' }, password: PASSWORD },
    { email: 'a@b.c', password: { $ne: '' } },
    { email: 'a@b.c' },
    {},
  ]) {
    assert.equal((await call('POST', '/api/auth/login', { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/api/auth/login', { raw: '{bad json', headers: { 'Content-Type': 'application/json' } })).status, 400);
});

test('login: a deactivated account is refused (403), but only after the right password', async () => {
  addUser({ email: 'off@example.com', isActive: false });
  const right = await call('POST', '/api/auth/login', { body: { email: 'off@example.com', password: PASSWORD } });
  assert.equal(right.status, 403);
  assert.equal(right.setCookies.length, 0);
  const wrong = await call('POST', '/api/auth/login', { body: { email: 'off@example.com', password: 'wrong-wrong-1' } });
  assert.equal(wrong.status, 401, 'a wrong password must not reveal that the account is deactivated');
});

test('login: too many failures -> 429 with Retry-After; other emails unaffected; success resets', async () => {
  addUser({ email: 'a@example.com' });
  addUser({ email: 'b@example.com' });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'wrong-wrong-1' } })).status, 401);
  }
  const blocked = await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: PASSWORD } });
  assert.equal(blocked.status, 429, 'even the right password is refused while blocked');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'b@example.com', password: PASSWORD } })).status, 200);

  resetAllLimiters();
  for (let i = 0; i < 2; i += 1) {
    await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'wrong-wrong-1' } });
  }
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: PASSWORD } })).status, 200);
  for (let i = 0; i < 2; i += 1) {
    await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'wrong-wrong-1' } });
  }
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: PASSWORD } })).status, 200,
    'a success clears the failure count');
});

test('logout: clears the cookie, with or without a session', async () => {
  addUser({ email: 'ann@example.com' });
  const session = await login('ann@example.com');
  for (const s of [session, undefined]) {
    const res = await call('POST', '/api/auth/logout', { session: s });
    assert.equal(res.status, 200);
    const cleared = res.setCookies.find((c) => c.startsWith(`${COOKIE}=`));
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  }
});

// ---- sessions ------------------------------------------------------------------------------
test('session: /users/me needs a valid cookie', async () => {
  const ann = addUser({ email: 'ann@example.com' });
  const session = await login('ann@example.com');
  const me = await call('GET', '/api/users/me', { session });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'ann@example.com');
  assert.equal(me.data.csrfToken, session.csrf, 'a reloaded app can recover its CSRF token');
  assert.ok(!JSON.stringify(me.data).includes('passwordHash'));

  assert.equal((await call('GET', '/api/users/me')).status, 401);
  assert.equal((await call('GET', '/api/users/me', { session: { cookie: `${COOKIE}=garbage` } })).status, 401);
  const forge = (secret, options) => `${COOKIE}=${jwt.sign({ id: String(ann._id), csrf: 'x' }, secret, options)}`;
  assert.equal((await call('GET', '/api/users/me', { session: { cookie: forge('some-other-secret') } })).status, 401);
  assert.equal((await call('GET', '/api/users/me', { session: { cookie: forge(process.env.JWT_SECRET, { expiresIn: -10 }) } })).status, 401);
  const noneToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id: String(ann._id) })).toString('base64url')}.`;
  assert.equal((await call('GET', '/api/users/me', { session: { cookie: `${COOKIE}=${noneToken}` } })).status, 401);
});

test('session: a Bearer header alone is not a session', async () => {
  const ann = addUser({ email: 'ann@example.com' });
  const token = jwt.sign({ id: String(ann._id), csrf: 'x' }, process.env.JWT_SECRET);
  assert.equal((await call('GET', '/api/users/me', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test('session: deactivating an account cuts off its existing session (403)', async () => {
  const ann = addUser({ email: 'ann@example.com' });
  const session = await login('ann@example.com');
  assert.equal((await call('GET', '/api/users/me', { session })).status, 200);
  ann.isActive = false;
  assert.equal((await call('GET', '/api/users/me', { session })).status, 403);
});

test('session: a session for a user that no longer exists is a 401', async () => {
  addUser({ email: 'ann@example.com' });
  const session = await login('ann@example.com');
  store = [];
  assert.equal((await call('GET', '/api/users/me', { session })).status, 401);
});

// ---- CSRF and origin -----------------------------------------------------------------------
test('csrf: writes need the matching X-CSRF-Token; reads do not', async () => {
  addUser({ email: 'ann@example.com' });
  const session = await login('ann@example.com');
  const body = { name: 'New Name' };

  assert.equal((await call('PATCH', '/api/users/me', { body, session: { cookie: session.cookie } })).status, 403);
  assert.equal((await call('PATCH', '/api/users/me', { body, session: { cookie: session.cookie, csrf: 'wrong' } })).status, 403);
  assert.equal((await call('PATCH', '/api/users/me', { body, session: { cookie: session.cookie, csrf: session.csrf.slice(0, -1) } })).status, 403);
  assert.equal((await call('PATCH', '/api/users/me', { body, session })).status, 200);
  assert.equal((await call('GET', '/api/users/me', { session: { cookie: session.cookie } })).status, 200);
});

test('csrf: a token from one session does not work for another', async () => {
  addUser({ email: 'a@example.com' });
  addUser({ email: 'b@example.com' });
  const a = await login('a@example.com');
  const b = await login('b@example.com');
  const res = await call('PATCH', '/api/users/me', { body: { name: 'X' }, session: { cookie: a.cookie, csrf: b.csrf } });
  assert.equal(res.status, 403);
});

test('origin: writes from an unlisted origin are refused, listed and same-host origins pass', async () => {
  addUser({ email: 'ann@example.com' });
  const login1 = (origin) => call('POST', '/api/auth/login', {
    body: { email: 'ann@example.com', password: PASSWORD },
    headers: origin ? { Origin: origin } : {},
  });
  assert.equal((await login1('https://evil.example')).status, 403);
  assert.equal((await login1('null')).status, 403);
  assert.equal((await login1('http://localhost:3000')).status, 200);
  assert.equal((await login1(base)).status, 200, 'the API\'s own origin is always accepted');
  assert.equal((await login1(undefined)).status, 200, 'non-browser clients send no Origin');
  // reads are not blocked by origin, but get no CORS headers
  const read = await call('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('access-control-allow-origin'), null);
  const allowed = await call('GET', '/api/health', { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
});

// ---- profile -------------------------------------------------------------------------------
test('profile: only name and phone change; role and the rest are ignored', async () => {
  const ann = addUser({ email: 'ann@example.com' });
  const session = await login('ann@example.com');
  const res = await call('PATCH', '/api/users/me', {
    session,
    body: { name: 'Anna', phone: '0917', role: 'admin', email: 'x@y.z', isActive: false, passwordHash: 'x' },
  });
  assert.equal(res.status, 200);
  assert.equal(ann.name, 'Anna');
  assert.equal(ann.phone, '0917');
  assert.equal(ann.role, 'user');
  assert.equal(ann.email, 'ann@example.com');
  assert.equal(ann.isActive, true);
  assert.equal(ann.passwordHash, passwordHash);

  assert.equal((await call('PATCH', '/api/users/me', { session, body: { phone: null } })).status, 200);
  assert.equal(ann.phone, undefined, 'null clears the phone');
  for (const body of [{}, { name: '  ' }, { name: 5 }, { phone: 5 }, { role: 'admin' }]) {
    assert.equal((await call('PATCH', '/api/users/me', { session, body })).status, 400, JSON.stringify(body));
  }
  assert.equal(ann.role, 'user');
});

// ---- admin ---------------------------------------------------------------------------------
test('admin: account list is admin-only and never contains hashes', async () => {
  addUser({ email: 'ann@example.com' });
  addUser({ email: 'boss@example.com', role: 'admin' });
  const user = await login('ann@example.com');
  const admin = await login('boss@example.com');

  assert.equal((await call('GET', '/api/users')).status, 401);
  assert.equal((await call('GET', '/api/users', { session: user })).status, 403);
  const res = await call('GET', '/api/users?limit=1&page=2', { session: admin });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 2);
  assert.equal(res.data.users.length, 1);
  assert.equal(res.data.page, 2);
  assert.equal(res.data.limit, 1);
  assert.ok(!JSON.stringify(res.data).includes('passwordHash'));
});

test('admin: activate/deactivate regular users only', async () => {
  const ann = addUser({ email: 'ann@example.com' });
  const boss = addUser({ email: 'boss@example.com', role: 'admin' });
  const other = addUser({ email: 'other@example.com', role: 'admin' });
  const user = await login('ann@example.com');
  const admin = await login('boss@example.com');
  const patch = (id, body, session) => call('PATCH', `/api/users/${id}/status`, { body, session });

  assert.equal((await patch(ann._id, { isActive: false })).status, 401);
  assert.equal((await patch(ann._id, { isActive: false }, user)).status, 403);
  assert.equal(ann.isActive, true);

  const off = await patch(ann._id, { isActive: false }, admin);
  assert.equal(off.status, 200);
  assert.equal(off.data.user.isActive, false);
  assert.equal(ann.isActive, false);
  assert.equal((await call('GET', '/api/users/me', { session: user })).status, 403, 'their session stops working');
  assert.equal((await patch(ann._id, { isActive: true }, admin)).status, 200);
  assert.equal((await call('GET', '/api/users/me', { session: user })).status, 200);

  assert.equal((await patch(other._id, { isActive: false }, admin)).status, 403, 'other admins are protected');
  assert.equal((await patch(boss._id, { isActive: false }, admin)).status, 403, 'and so is the admin themselves');
  assert.equal(other.isActive, true);
  assert.equal((await patch(ann._id, { isActive: 'false' }, admin)).status, 400);
  assert.equal((await patch(ann._id, {}, admin)).status, 400);
  assert.equal((await patch('not-an-id', { isActive: false }, admin)).status, 404);
  assert.equal((await patch(new mongoose.Types.ObjectId(), { isActive: false }, admin)).status, 404);
});

test('admin: movie writes need an admin session and a CSRF token', async () => {
  addUser({ email: 'ann@example.com' });
  addUser({ email: 'boss@example.com', role: 'admin' });
  const user = await login('ann@example.com');
  const admin = await login('boss@example.com');
  for (const [method, path] of [['POST', '/api/movies'], ['PUT', '/api/movies/abc'], ['DELETE', '/api/movies/abc']]) {
    assert.equal((await call(method, path, { body: {} })).status, 401, `${method} anonymous`);
    assert.equal((await call(method, path, { body: {}, session: user })).status, 403, `${method} user`);
    assert.equal((await call(method, path, { body: {}, session: { cookie: admin.cookie } })).status, 403, `${method} admin without csrf`);
  }
});

// ---- bookings placeholder, errors ----------------------------------------------------------
test('bookings: protected, and 501 until the booking engine is rebuilt', async () => {
  addUser({ email: 'ann@example.com' });
  const session = await login('ann@example.com');
  assert.equal((await call('GET', '/api/bookings/my')).status, 401);
  assert.equal((await call('POST', '/api/bookings', { body: {} })).status, 401);
  assert.equal((await call('GET', '/api/bookings/my', { session })).status, 501);
  assert.equal((await call('POST', '/api/bookings', { body: {}, session })).status, 501);
});

test('errors: one JSON shape for 404s, malformed ids and bad JSON; nothing leaks', async () => {
  const unknown = await call('GET', '/api/nope');
  assert.equal(unknown.status, 404);
  assert.deepEqual(Object.keys(unknown.data), ['message']);
  assert.equal((await call('GET', '/api/movies/not-an-object-id')).status, 404);
  const tooBig = await call('POST', '/api/auth/login', { body: { email: 'a@b.c', password: 'x'.repeat(200 * 1024) } });
  assert.equal(tooBig.status, 413);
  const res = await call('GET', '/api/health');
  assert.equal(res.headers.get('x-powered-by'), null);
});
