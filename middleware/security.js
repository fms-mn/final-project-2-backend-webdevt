const cors = require('cors');
const config = require('../config');
const { HttpError } = require('../utils/http');

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Browsers on an allowed origin may call the API with the session cookie. Everyone else gets
// no CORS headers, so the browser refuses to hand the response to the page.
const corsMiddleware = cors({
  origin(origin, callback) {
    callback(null, !origin || config.allowedOrigins.includes(origin));
  },
  credentials: true,
});

// A browser always sends `Origin` on cross-site writes. For any write, an Origin that is not
// on the allowlist (and not this server's own host) is refused before anything else runs.
// Requests without an Origin header (curl, scripts) are not browser cross-site requests;
// authenticated ones still need the CSRF token (see middleware/auth.js).
function originCheck(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const origin = req.get('Origin');
  if (!origin) return next();
  if (config.allowedOrigins.includes(origin)) return next();
  try {
    if (new URL(origin).host === req.get('Host')) return next();
  } catch {
    // unparseable origin, handled below
  }
  return next(new HttpError(403, 'Origin not allowed'));
}

// Baseline response headers for the API and the website.
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Only over HTTPS (req.secure needs TRUST_PROXY behind a reverse proxy): tell browsers to
  // keep using HTTPS for this site.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
}

module.exports = { corsMiddleware, originCheck, securityHeaders, UNSAFE_METHODS };
