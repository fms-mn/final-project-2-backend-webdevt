const express = require('express');
const passwords = require('../services/passwords');
const access = require('../services/accountAccess');
const config = require('../config');
const notifications = require('../services/mail/notifications');
const User = require('../models/User');
const { startSession, endSession } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { HttpError, wrap } = require('../utils/http');

const router = express.Router();

// Failed sign-ins are limited per IP + email, and per IP overall.
const limits = { windowMs: config.loginRateWindowMs };
const failuresByEmail = createRateLimiter({ ...limits, name: 'email', max: config.loginRateMax });
const failuresByIp = createRateLimiter({ ...limits, name: 'ip', max: config.loginRateMax * 5 });

// Asking for reset emails is limited per IP (every request counts, found account or not).
const resetByIp = createRateLimiter({ name: 'forgot', windowMs: 60 * 60 * 1000, max: 10, message: (minutes) => `Too many requests. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.` });

// Compared against when the email is unknown, so a wrong email and a wrong password take
// about as long and cannot be told apart by timing.
let dummyHash;
const unknownUserCompare = async (password) => {
  dummyHash ||= passwords.hashPassword('not-a-real-password').catch(error => { dummyHash = undefined; throw error; });
  await passwords.comparePassword(password, await dummyHash);
};

// Register
router.post('/register', wrap(async (req, res) => {
  const { name, email, password, phone } = req.body || {};

  // Reject non-strings so a request body cannot smuggle query operators into the lookup.
  if (typeof name !== 'string' || typeof email !== 'string') {
    throw new HttpError(400, 'Name, email and password are required');
  }
  if (phone !== undefined && phone !== null && typeof phone !== 'string') {
    throw new HttpError(400, 'Phone must be text');
  }
  const passwordError = User.validatePassword(password);
  if (passwordError) throw new HttpError(400, passwordError);

  if (await User.findOne({ email: email.trim().toLowerCase() })) {
    throw new HttpError(409, 'Email already registered');
  }

  // Public registration always creates a regular user, whatever role the request names.
  const user = new User({
    name,
    email,
    phone: phone || undefined,
    passwordHash: await User.hashPassword(password),
    role: 'user',
    lastLoginAt: new Date(), // registering is a sign-in
  });
  try {
    await user.save();
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, 'Email already registered');
    throw error;
  }

  notifications.welcome(user._id); // sent in the background; a failure never stops the sign-up
  const csrfToken = startSession(res, user);
  res.status(201).json({ user, csrfToken });
}));

// Login
router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw new HttpError(400, 'Email and password are required');
  }

  const emailKey = `${req.ip}|${email.trim().toLowerCase()}`;
  await failuresByIp.check(req.ip);
  await failuresByEmail.check(emailKey);

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  const matches = user ? await user.comparePassword(password) : await unknownUserCompare(password);
  if (!user || !matches) {
    await failuresByIp.fail(req.ip);
    await failuresByEmail.fail(emailKey);
    throw new HttpError(401, 'Invalid email or password');
  }
  if (!user.isActive) throw new HttpError(403, 'Account is deactivated');

  await failuresByEmail.clear(emailKey);

  // An account that stayed away for a long time proves it is the owner with a code sent by email.
  if (access.needsLoginCode(user)) {
    const challenge = await access.startLoginChallenge(user);
    if (challenge) return res.status(202).json({ verificationRequired: true, ...challenge });
  }
  await access.markSignedIn(user);
  const csrfToken = startSession(res, user);
  res.json({ user, csrfToken });
}));

// Second step of a sign-in that asked for a code.
router.post('/login/verify', wrap(async (req, res) => {
  const { challenge, code } = req.body || {};
  await failuresByIp.check(req.ip);
  let user;
  try {
    user = await access.verifyLoginCode(challenge, code);
  } catch (error) {
    if (error.status === 400) await failuresByIp.fail(req.ip);
    throw error;
  }
  await access.markSignedIn(user);
  const csrfToken = startSession(res, user);
  res.json({ user, csrfToken });
}));

router.post('/login/resend', wrap(async (req, res) => {
  res.json(await access.resendLoginCode((req.body || {}).challenge));
}));

// Forgot password: always the same answer, so it cannot be used to find out who has an account.
router.post('/forgot-password', wrap(async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.trim()) throw new HttpError(400, 'Enter your email address');
  await resetByIp.check(req.ip);
  await resetByIp.fail(req.ip);
  await access.requestPasswordReset(email);
  res.json({ message: 'If that email belongs to an account, a reset link is on its way. It works for a limited time.' });
}));

// Lets the reset page say a link is dead before asking for a new password.
router.post('/reset-password/check', wrap(async (req, res) => {
  res.json({ valid: await access.checkResetToken((req.body || {}).token) });
}));

router.post('/reset-password', wrap(async (req, res) => {
  const { token, password } = req.body || {};
  await access.resetPassword(token, password);
  res.json({ message: 'Your password was changed. Sign in with the new one.' });
}));

// Logout: always clears the cookie, even when the session has already expired.
router.post('/logout', (req, res) => {
  endSession(res);
  res.json({ message: 'Logged out' });
});

module.exports = router;
