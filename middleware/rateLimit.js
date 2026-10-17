const { HttpError } = require('../utils/http');
const LoginAttempt = require('../models/LoginAttempt');

// A limiter for failed attempts, kept in the database (see models/LoginAttempt.js) so the count
// survives a restart and is shared by every server process.
//
//   await limiter.check(key)  throws a 429 HttpError when the key has used up its failures
//   await limiter.fail(key)   records one failed attempt
//   await limiter.clear(key)  forgets the key (call after a success)
//
// `name` keeps different limiters apart inside the one collection.
function createRateLimiter({ name, windowMs, max, message }) {
  const rowKey = (key) => `${name}|${key}`;

  return {
    async check(key) {
      const now = new Date();
      const entry = await LoginAttempt.findOne({ key: rowKey(key), expiresAt: { $gt: now } });
      if (entry && entry.failures >= max) {
        const retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
        const minutes = Math.ceil(retryAfter / 60);
        throw new HttpError(
          429,
          message ? message(minutes) : `Too many failed sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} before trying again. Even the right password is refused until then.`,
          { retryAfter },
        );
      }
    },
    async fail(key) {
      const now = new Date();
      const filter = { key: rowKey(key), expiresAt: { $gt: now } };
      // The common case: a live count exists, so add one to it (atomic in MongoDB).
      if ((await LoginAttempt.updateOne(filter, { $inc: { failures: 1 } })).modifiedCount) return;
      // First failure, or the old count has run out: start a new one.
      await LoginAttempt.deleteMany({ key: rowKey(key), expiresAt: { $lte: now } });
      try {
        await new LoginAttempt({ key: rowKey(key), failures: 1, expiresAt: new Date(now.getTime() + windowMs) }).save();
      } catch (error) {
        if (error.code !== 11000) throw error;
        // Another request created it a moment ago; count this failure on that row.
        await LoginAttempt.updateOne(filter, { $inc: { failures: 1 } });
      }
    },
    async clear(key) {
      await LoginAttempt.deleteOne({ key: rowKey(key) });
    },
  };
}

module.exports = { createRateLimiter };
