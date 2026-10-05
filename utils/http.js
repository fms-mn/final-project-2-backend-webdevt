// An error that already knows which HTTP status and message to answer with.
//   400 invalid input · 401 invalid authentication · 403 forbidden · 404 missing record
//   409 conflict · 429 too many attempts
class HttpError extends Error {
  constructor(status, message, { errors, retryAfter } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.errors = errors; // optional per-field messages
    this.retryAfter = retryAfter; // seconds, for 429
  }
}

// Express 4 does not catch rejected promises, so wrap async handlers with this.
const wrap = (handler) => (req, res, next) => {
  Promise.resolve().then(() => handler(req, res, next)).catch(next);
};

module.exports = { HttpError, wrap };
