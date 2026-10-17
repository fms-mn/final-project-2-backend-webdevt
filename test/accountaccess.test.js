// Offline tests for getting back into an account: the forgot-password email, the reset itself,
// and the emailed code asked for after a long time away. Real app and models, in-memory database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.BOOKING_RETRY_PAUSE_MS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const User = require('../models/User');
const AuthToken = require('../models/AuthToken');
const LoginAttempt = require('../models/LoginAttempt');
const { sent } = require('../services/mail/transports');
const { idle } = require('../services/mail');
const { fakeModel, fakeTransactions } = require('./fakeDb');

const PASSWORD = 'correct-horse-1';
const COOKIE = 'filme_session';
const DAY = 24 * 60 * 60 * 1000;

const users = [];
const tokens = [];
let attempts = [];
let server;
let base;
let passwordHash;

const addUser = (fields = {}) => {
  const doc = new User({ name: 'Ann Reyes', email: 'ann@example.com', passwordHash, role: 'user', ...fields });
  doc.$isNew = false;
  users.push(doc);
  return doc;
};

async function post(path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch { /* no body */ }
  const cookieHeader = response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE}=`));
  return { status: response.status, data, cookie: cookieHeader };
}
const login = (email = 'ann@example.com', password = PASSWORD) => post('/api/auth/login', { email, password });
const me = async (cookie) => (await fetch(`${base}/api/users/me`, { headers: { Cookie: cookie } })).status;

const mailTo = (address, tag) => sent.filter((mail) => mail.to === address && (!tag || mail.tags.includes(tag)));
const lastResetToken = () => {
  const mail = mailTo('ann@example.com', 'password-reset').at(-1);
  return decodeURIComponent(/reset-password\?token=([^\s&"<]+)/.exec(mail.text)[1]);
};
const lastCode = () => /sign-in code: (\d{6})/.exec(mailTo('ann@example.com', 'login-code').at(-1).subject)[1];

test.before(async () => {
  passwordHash = await User.hashPassword(PASSWORD);
  fakeModel(User, users, { uniqueOn: 'email' });
  fakeModel(AuthToken, tokens);
  fakeModel(LoginAttempt, attempts, { uniqueOn: 'key' });
  fakeTransactions({ stores: [users, tokens] });
  server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  users.length = 0; tokens.length = 0; attempts.length = 0; sent.length = 0;
  delete process.env.VERIFY_AFTER_DAYS; delete process.env.MAIL_PROVIDER;
});

// ---- forgot password --------------------------------------------------------------------------
test('forgot password: the answer is the same for any email, and only a real account gets mail', async () => {
  addUser();
  const real = await post('/api/auth/forgot-password', { email: 'Ann@Example.com' });
  const unknown = await post('/api/auth/forgot-password', { email: 'nobody@example.com' });
  await idle();
  assert.equal(real.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(real.data, unknown.data, 'nothing tells the two apart');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ann@example.com');
  assert.match(sent[0].text, /reset-password\?token=/);
  assert.equal(tokens.length, 1);
  assert.ok(!JSON.stringify(tokens[0]).includes(lastResetToken()), 'only a hash is stored, never the link secret');

  assert.equal((await post('/api/auth/forgot-password', {})).status, 400);
  addUser({ email: 'off@example.com', isActive: false });
  await post('/api/auth/forgot-password', { email: 'off@example.com' });
  await idle();
  assert.equal(mailTo('off@example.com').length, 0, 'a deactivated account gets nothing');
});

test('forgot password: a newer link replaces the older one, and an account gets only three an hour', async () => {
  addUser();
  await post('/api/auth/forgot-password', { email: 'ann@example.com' }); await idle();
  const first = lastResetToken();
  await post('/api/auth/forgot-password', { email: 'ann@example.com' }); await idle();
  const second = lastResetToken();
  assert.notEqual(first, second);
  assert.equal((await post('/api/auth/reset-password/check', { token: first })).data.valid, false, 'the older link stopped working');
  assert.equal((await post('/api/auth/reset-password/check', { token: second })).data.valid, true);
  await post('/api/auth/forgot-password', { email: 'ann@example.com' });
  await post('/api/auth/forgot-password', { email: 'ann@example.com' });
  await idle();
  assert.equal(mailTo('ann@example.com', 'password-reset').length, 3, 'the fourth request in an hour sends nothing');
});

test('forgot password: one IP cannot ask without end', async () => {
  for (let i = 0; i < 10; i += 1) assert.equal((await post('/api/auth/forgot-password', { email: `x${i}@example.com` })).status, 200);
  const blocked = await post('/api/auth/forgot-password', { email: 'x@example.com' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.message, /Too many requests/);
});

// ---- reset ------------------------------------------------------------------------------------
test('reset: a new password works once, signs everyone out, and tells the owner', async () => {
  addUser();
  const before = await login();
  assert.equal(await me(before.cookie), 200);
  await new Promise((resolve) => { setTimeout(resolve, 1100); }); // the old session was issued in an earlier second
  await post('/api/auth/forgot-password', { email: 'ann@example.com' }); await idle();
  const token = lastResetToken();

  const weak = await post('/api/auth/reset-password', { token, password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal((await post('/api/auth/reset-password/check', { token })).data.valid, true, 'a refused password does not use up the link');
  assert.equal((await post('/api/auth/reset-password', { token: 'not-a-real-link', password: 'a-new-password-1' })).status, 400);

  const ok = await post('/api/auth/reset-password', { token, password: 'a-new-password-1' });
  assert.equal(ok.status, 200);
  assert.equal((await login('ann@example.com', PASSWORD)).status, 401, 'the old password stopped working');
  assert.equal((await login('ann@example.com', 'a-new-password-1')).status, 200);
  assert.equal(await me(before.cookie), 401, 'a session from before the reset is signed out');
  assert.equal((await post('/api/auth/reset-password', { token, password: 'another-password-2' })).status, 400, 'a link works once');
  await idle();
  assert.equal(mailTo('ann@example.com', 'password-changed').length, 1);
  assert.ok(!JSON.stringify(users[0].toJSON()).includes('passwordChangedAt'), 'never shown in an API response');
});

test('reset: an expired link is refused', async () => {
  addUser();
  await post('/api/auth/forgot-password', { email: 'ann@example.com' }); await idle();
  tokens[0].expiresAt = new Date(Date.now() - 1000);
  const response = await post('/api/auth/reset-password', { token: lastResetToken(), password: 'a-new-password-1' });
  assert.equal(response.status, 400);
  assert.match(response.data.message, /expired or was already used/);
});

// ---- a code after a long time away -----------------------------------------------------------
test('sign-in: recent and brand-new accounts go straight in, and the sign-in is recorded', async () => {
  const recent = addUser({ lastLoginAt: new Date(Date.now() - 5 * DAY) });
  const first = await login();
  assert.equal(first.status, 200);
  assert.ok(first.cookie);
  assert.ok(new Date(recent.lastLoginAt) > new Date(Date.now() - 60000), 'the last sign-in moved up');

  const old = addUser({ email: 'old@example.com' }); // no sign-in on record: an account from before this existed
  assert.equal((await login('old@example.com')).status, 200);
  assert.ok(old.lastLoginAt, 'its next sign-in starts the record');
  assert.equal(sent.filter((mail) => mail.tags.includes('login-code')).length, 0);

  const register = await post('/api/auth/register', { name: 'New Person', email: 'new@example.com', password: PASSWORD });
  assert.equal(register.status, 201);
  assert.ok(users.find((user) => user.email === 'new@example.com').lastLoginAt, 'registering counts as a sign-in');
});

test('sign-in: after a long time away a code is emailed and must be entered', async () => {
  const user = addUser({ lastLoginAt: new Date(Date.now() - 45 * DAY) });
  const step = await login();
  assert.equal(step.status, 202);
  assert.equal(step.data.verificationRequired, true);
  assert.equal(step.cookie, undefined, 'no session yet');
  assert.equal(step.data.email, 'a***@example.com');
  assert.ok(step.data.challenge);
  const code = lastCode();
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(tokens).includes(code), 'the code is stored hashed');

  const wrong = await post('/api/auth/login/verify', { challenge: step.data.challenge, code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.message, /4 tries left/);
  assert.equal((await post('/api/auth/login/verify', { challenge: 'made-up', code })).status, 400);

  const ok = await post('/api/auth/login/verify', { challenge: step.data.challenge, code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });
  assert.equal(ok.status, 200, 'spaces in the code are ignored');
  assert.ok(ok.cookie);
  assert.ok(ok.data.csrfToken);
  assert.equal(await me(ok.cookie), 200);
  assert.ok(new Date(user.lastLoginAt) > new Date(Date.now() - 60000));
  assert.equal((await post('/api/auth/login/verify', { challenge: step.data.challenge, code })).status, 400, 'a code works once');
  assert.equal((await login()).status, 200, 'the next sign-in is direct again');
});

test('sign-in code: five wrong tries end it, and a resend gives a fresh code after a wait', async () => {
  addUser({ lastLoginAt: new Date(Date.now() - 60 * DAY) });
  const step = await login();
  const code = lastCode();
  const bad = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) await post('/api/auth/login/verify', { challenge: step.data.challenge, code: bad });
  const locked = await post('/api/auth/login/verify', { challenge: step.data.challenge, code });
  assert.equal(locked.status, 429, 'even the right code is refused after five wrong ones');

  const again = await login();
  assert.equal(again.status, 202, 'signing in again starts over');
  const tooSoon = await post('/api/auth/login/resend', { challenge: again.data.challenge });
  assert.equal(tooSoon.status, 429);
  assert.match(tooSoon.data.message, /Please wait/);

  tokens.at(-1).lastSentAt = new Date(Date.now() - 61000);
  const firstCode = lastCode();
  const resend = await post('/api/auth/login/resend', { challenge: again.data.challenge });
  assert.equal(resend.status, 200);
  const secondCode = lastCode();
  assert.equal(mailTo('ann@example.com', 'login-code').length, 3);
  if (firstCode !== secondCode) assert.equal((await post('/api/auth/login/verify', { challenge: again.data.challenge, code: firstCode })).status, 400, 'the older code stopped working');
  assert.equal((await post('/api/auth/login/verify', { challenge: again.data.challenge, code: secondCode })).status, 200);

  const third = await login(); // not needed now (just signed in), so check the cap on a fresh challenge
  assert.equal(third.status, 200);
});

test('sign-in code: three emails per sign-in at most', async () => {
  addUser({ lastLoginAt: new Date(Date.now() - 60 * DAY) });
  const step = await login();
  for (let i = 0; i < 2; i += 1) {
    tokens.at(-1).lastSentAt = new Date(Date.now() - 61000);
    assert.equal((await post('/api/auth/login/resend', { challenge: step.data.challenge })).status, 200);
  }
  tokens.at(-1).lastSentAt = new Date(Date.now() - 61000);
  const capped = await post('/api/auth/login/resend', { challenge: step.data.challenge });
  assert.equal(capped.status, 429);
  assert.match(capped.data.message, /No more codes/);
});

test('sign-in code: switched off by VERIFY_AFTER_DAYS=0, and never asked for when email cannot be sent', async () => {
  addUser({ lastLoginAt: new Date(Date.now() - 90 * DAY) });
  process.env.VERIFY_AFTER_DAYS = '0';
  assert.equal((await login()).status, 200);

  users[0].lastLoginAt = new Date(Date.now() - 90 * DAY);
  delete process.env.VERIFY_AFTER_DAYS;
  process.env.MAIL_PROVIDER = 'brevo'; // chosen, but BREVO_API_KEY is not set: no email can leave
  assert.equal((await login()).status, 200, 'no code when it could never arrive, or everyone would be locked out');
  assert.equal(sent.filter((mail) => mail.tags.includes('login-code')).length, 0);
});

test('sign-in: a wrong password never reveals or starts a code', async () => {
  addUser({ lastLoginAt: new Date(Date.now() - 90 * DAY) });
  const response = await login('ann@example.com', 'wrong-password-1');
  assert.equal(response.status, 401);
  assert.equal(sent.length, 0);
});
