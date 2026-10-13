const { HttpError } = require('../utils/http');

// Unknown /api routes.
const notFound = (req, res) => {
  res.status(404).json({ message: 'Not found' });
};

// Every error ends up here, so every error response has the same shape:
//   { "message": "...", "errors": { field: "..." } }   (errors only when there are field errors)
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err instanceof HttpError) {
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    return res.status(err.status).json({
      message: err.message,
      ...(err.errors ? { errors: err.errors } : {}),
    });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large' });
  }

  // Mongoose: a field failed its schema rules.
  if (err.name === 'ValidationError' && err.errors) {
    const errors = Object.fromEntries(
      Object.entries(err.errors).map(([path, problem]) => [path, problem.message]),
    );
    return res.status(400).json({ message: 'Validation failed', errors });
  }
  // Mongoose: a value could not be converted (for example a malformed id).
  if (err.name === 'CastError') {
    return res.status(400).json({ message: `Invalid value for ${err.path}` });
  }
  // MongoDB: a unique index rejected a duplicate.
  if (err.code === 11000) {
    return res.status(409).json({ message: 'That record already exists' });
  }

  if (process.env.NODE_ENV !== 'test') {
    const paymentRequest = /^\/api\/(bookings\/[^/]+\/pay|payments\/[^/]+\/authorize)(\?|$)/.test(req.originalUrl);
    console.error(paymentRequest ? { message: 'Payment request failed', name: err.name } : err);
  }
  return res.status(500).json({ message: 'Server error' });
};

module.exports = { notFound, errorHandler };
