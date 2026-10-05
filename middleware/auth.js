const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const { HttpError, wrap } = require('../utils/http');
const { UNSAFE_METHODS } = require('./security');

// ---- Session cookie ------------------------------------------------------------------------
// The session is a short-lived JWT in an HttpOnly cookie, so page scripts cannot read it.
// The JWT also carries a random CSRF token. The browser app gets that token from the login /
// profile response body and must send it back in the `X-CSRF-Token` header on every write.
// A forged cross-site request carries the cookie automatically but cannot know the token.

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax',
  path: '/',
});

// Starts a session for `user` and returns the CSRF token the client must echo back.
function startSession(res, user) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const token = jwt.sign({ id: String(user._id), csrf: csrfToken }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: config.sessionSeconds,
  });
  res.cookie(config.cookieName, token, { ...cookieOptions(), maxAge: config.sessionSeconds * 1000 });
  return csrfToken;
}

function endSession(res) {
  res.clearCookie(config.cookieName, cookieOptions());
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name && !(name in cookies)) {
      try {
        cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        // ignore a malformed cookie value
      }
    }
  }
  return cookies;
}

function sameToken(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Middleware ----------------------------------------------------------------------------

// Requires an active, signed-in user. On success `req.user` is the account (without its hash)
// and `req.csrfToken` is the session's CSRF token.
const auth = wrap(async (req, res, next) => {
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  if (!token) throw new HttpError(401, 'Authentication required');

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw new HttpError(401, 'Your session is invalid or has expired. Please sign in again.');
  }

  if (UNSAFE_METHODS.has(req.method) && !sameToken(decoded.csrf, req.get('X-CSRF-Token'))) {
    throw new HttpError(403, 'Missing or invalid CSRF token');
  }

  const user = await User.findById(decoded.id).select('-passwordHash');
  if (!user) throw new HttpError(401, 'Your session is invalid or has expired. Please sign in again.');
  // Checked on every request, so deactivating an account also cuts off sessions already issued.
  if (!user.isActive) throw new HttpError(403, 'Account is deactivated');

  req.user = user;
  req.csrfToken = decoded.csrf;
  next();
});

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  return next(new HttpError(403, 'Admin access required'));
};

// Use as a route's middleware list: router.get('/', adminAuth, handler)
const adminAuth = [auth, requireAdmin];

// For routes on a record that belongs to someone: the owner and any admin may use it.
const isOwnerOrAdmin = (user, ownerId) => (
  Boolean(user) && (user.role === 'admin' || String(user._id) === String(ownerId))
);

module.exports = {
  auth,
  adminAuth,
  requireAdmin,
  isOwnerOrAdmin,
  startSession,
  endSession,
  parseCookies,
};
