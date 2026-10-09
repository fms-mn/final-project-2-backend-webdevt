const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const { startSession, endSession } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { HttpError, wrap } = require('../utils/http');

const router = express.Router();

// Failed sign-ins are limited per IP + email, and per IP overall.
const limits = { windowMs: config.loginRateWindowMs };
const failuresByEmail = createRateLimiter({ ...limits, name: 'email', max: config.loginRateMax });
const failuresByIp = createRateLimiter({ ...limits, name: 'ip', max: config.loginRateMax * 5 });

// Compared against when the email is unknown, so a wrong email and a wrong password take
// about as long and cannot be told apart by timing.
let dummyHash;
const unknownUserCompare = async (password) => {
  dummyHash = dummyHash || await bcrypt.hash('not-a-real-password', 12);
  await bcrypt.compare(password, dummyHash);
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
  });
  try {
    await user.save();
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, 'Email already registered');
    throw error;
  }

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
  const csrfToken = startSession(res, user);
  res.json({ user, csrfToken });
}));

// Logout: always clears the cookie, even when the session has already expired.
router.post('/logout', (req, res) => {
  endSession(res);
  res.json({ message: 'Logged out' });
});

module.exports = router;
