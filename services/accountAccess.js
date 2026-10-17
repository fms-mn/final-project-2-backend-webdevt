// Getting back into an account: the forgot-password link, and the emailed code asked for when an
// account has not signed in for a long time. Both prove the person controls the email address.
//
// Secrets are never stored: AuthToken keeps a keyed hash. Every answer to a stranger is the same
// whether or not the email belongs to an account, so the forms cannot be used to find out who has one.

const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const AuthToken = require('../models/AuthToken');
const { HttpError } = require('../utils/http');
const { sendMail } = require('./mail');
const { transportFor } = require('./mail/transports');
const templates = require('./mail/templates');
const notifications = require('./mail/notifications');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const RESETS_PER_HOUR = 3;       // reset emails per account
const MAX_CODE_TRIES = 5;        // wrong codes per sign-in
const MAX_CODE_SENDS = 3;        // emails per sign-in (the first plus two resends)
const RESEND_WAIT_SECONDS = 60;

const digest = (value) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(value)).digest('hex');
const same = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// "b***@gmail.com": enough for the person to recognise their own address.
const maskEmail = (email) => String(email).replace(/^(.).*(@.*)$/, '$1***$2');

// ---- forgot password ------------------------------------------------------------------------

// Sends a reset link when the email belongs to an active account. Says nothing either way.
async function requestPasswordReset(email, now = new Date()) {
  if (typeof email !== 'string') return;
  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user || !user.isActive) return;

  const recent = await AuthToken.countDocuments({
    user: user._id, purpose: 'password-reset', createdAt: { $gt: new Date(now.getTime() - 60 * MINUTE) },
  });
  if (recent >= RESETS_PER_HOUR) return;

  await AuthToken.updateMany({ user: user._id, purpose: 'password-reset', usedAt: null }, { $set: { usedAt: now } }); // older links stop working
  const secret = crypto.randomBytes(32).toString('base64url');
  await new AuthToken({
    user: user._id, purpose: 'password-reset', tokenHash: digest(secret), createdAt: now, expiresAt: new Date(now.getTime() + config.resetMinutes * MINUTE),
  }).save();
  notifications.passwordReset(user._id, secret);
}

const BAD_LINK = 'This link has expired or was already used. Ask for a new one.';

// Whether a reset link can still be used, so the page can say so before asking for a password.
async function checkResetToken(token, now = new Date()) {
  if (typeof token !== 'string' || !token) return false;
  return Boolean(await AuthToken.findOne({ purpose: 'password-reset', tokenHash: digest(token), usedAt: null, expiresAt: { $gt: now } }));
}

// Sets the new password, uses up the link, and signs the account out everywhere.
async function resetPassword(token, password, now = new Date()) {
  if (typeof token !== 'string' || !token) throw new HttpError(400, BAD_LINK);
  const passwordError = User.validatePassword(password);
  if (passwordError) throw new HttpError(400, passwordError);

  const tokenHash = digest(token);
  const record = await AuthToken.findOne({ purpose: 'password-reset', tokenHash, usedAt: null, expiresAt: { $gt: now } });
  if (!record) throw new HttpError(400, BAD_LINK);
  const claimed = await AuthToken.updateOne({ _id: record._id, usedAt: null }, { $set: { usedAt: now } });
  if (!claimed.modifiedCount) throw new HttpError(400, BAD_LINK); // someone used it a moment ago

  const user = await User.findById(record.user);
  if (!user || !user.isActive) throw new HttpError(400, BAD_LINK);
  user.passwordHash = await User.hashPassword(password);
  user.passwordChangedAt = now;
  await user.save();
  await AuthToken.updateMany({ user: user._id, usedAt: null }, { $set: { usedAt: now } });
  notifications.passwordChanged(user._id);
  return user;
}

// ---- a code after a long time away -----------------------------------------------------------

// Can an email actually leave this server? Without that (production with no provider set up) nobody
// is asked for a code, or everyone would be locked out.
function canEmail() {
  const provider = config.mail.provider;
  if (transportFor(provider).ready()) return true;
  return !config.isProduction && (provider === 'log' || provider === 'memory');
}

// Only an account that has signed in before and then stayed away is asked. An account with no sign-in
// on record yet (made before this existed) is never asked; its next sign-in starts the record.
function needsLoginCode(user, now = new Date()) {
  const days = config.verifyAfterDays;
  if (!days || !user.lastLoginAt || !canEmail()) return false;
  return now.getTime() - new Date(user.lastLoginAt).getTime() > days * DAY;
}

// Recording the time must never get in the way of signing in. Saving the account writes only this field.
async function markSignedIn(user, now = new Date()) {
  try {
    user.lastLoginAt = now;
    await user.save();
  } catch (error) {
    console.error('[auth] could not record the sign-in time:', error.message);
  }
}

async function sendLoginCode(user, code) {
  return sendMail({ to: user.email, toName: user.name, ...templates.loginCode({ name: user.name, code, minutes: config.loginCodeMinutes }) });
}

// Emails a code and returns what the sign-in page needs. When the email cannot be sent (the provider
// is down) it answers null, and the caller signs the person in without a code instead of locking them out.
async function startLoginChallenge(user, now = new Date()) {
  const challenge = crypto.randomBytes(24).toString('base64url');
  const code = newCode();
  const sent = await sendLoginCode(user, code);
  if (!sent.ok) {
    console.error('[auth] could not email a sign-in code, signing in without one:', sent.error);
    return null;
  }
  await new AuthToken({
    user: user._id, purpose: 'login-code', tokenHash: digest(challenge), codeHash: digest(code), createdAt: now, lastSentAt: now,
    expiresAt: new Date(now.getTime() + config.loginCodeMinutes * MINUTE),
  }).save();
  return {
    challenge, email: maskEmail(user.email), expiresInMinutes: config.loginCodeMinutes, resendInSeconds: RESEND_WAIT_SECONDS,
  };
}

const BAD_CHALLENGE = 'This code has expired. Sign in again to get a new one.';
const findChallenge = (challenge, now) => AuthToken.findOne({
  purpose: 'login-code', tokenHash: digest(typeof challenge === 'string' ? challenge : ''), usedAt: null, expiresAt: { $gt: now },
});

// Checks the code and returns the account to sign in. Five wrong tries end the challenge.
async function verifyLoginCode(challenge, code, now = new Date()) {
  const record = await findChallenge(challenge, now);
  if (!record) throw new HttpError(400, BAD_CHALLENGE);
  if (record.attempts >= MAX_CODE_TRIES) throw new HttpError(429, 'Too many wrong codes. Sign in again to get a new one.');

  if (typeof code !== 'string' || !same(digest(code.replace(/\s+/g, '')), record.codeHash)) {
    await AuthToken.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    const left = MAX_CODE_TRIES - record.attempts - 1;
    throw new HttpError(400, left > 0 ? `That code is not right. You have ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code is not right, and you have no tries left. Sign in again to get a new one.');
  }
  const claimed = await AuthToken.updateOne({ _id: record._id, usedAt: null }, { $set: { usedAt: now } });
  if (!claimed.modifiedCount) throw new HttpError(400, BAD_CHALLENGE);
  const user = await User.findById(record.user);
  if (!user || !user.isActive) throw new HttpError(400, BAD_CHALLENGE);
  return user;
}

// Sends the code again (a new one), at most once a minute and three times in all.
async function resendLoginCode(challenge, now = new Date()) {
  const record = await findChallenge(challenge, now);
  if (!record) throw new HttpError(400, BAD_CHALLENGE);
  const wait = RESEND_WAIT_SECONDS - Math.floor((now.getTime() - new Date(record.lastSentAt).getTime()) / 1000);
  if (wait > 0) throw new HttpError(429, `Please wait ${wait} second${wait === 1 ? '' : 's'} before asking for another code.`, { retryAfter: wait });
  if (record.sentCount >= MAX_CODE_SENDS) throw new HttpError(429, 'No more codes can be sent for this sign-in. Sign in again to start over.');
  const user = await User.findById(record.user);
  if (!user || !user.isActive) throw new HttpError(400, BAD_CHALLENGE);

  const code = newCode();
  const sent = await sendLoginCode(user, code);
  if (!sent.ok) throw new HttpError(502, 'We could not send the email right now. Please try again in a moment.');
  await AuthToken.updateOne({ _id: record._id }, {
    $set: { codeHash: digest(code), attempts: 0, lastSentAt: now, expiresAt: new Date(now.getTime() + config.loginCodeMinutes * MINUTE) },
    $inc: { sentCount: 1 },
  });
  return { resendInSeconds: RESEND_WAIT_SECONDS, expiresInMinutes: config.loginCodeMinutes };
}

module.exports = {
  requestPasswordReset, checkResetToken, resetPassword, needsLoginCode, markSignedIn, startLoginChallenge, verifyLoginCode, resendLoginCode, maskEmail, canEmail,
};
