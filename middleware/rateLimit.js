const { HttpError } = require('../utils/http');

const registry = [];

// A small in-memory limiter for failed attempts. It is per server process, which is fine for
// the single Node host the proposal describes.
//
//   limiter.check(key)  throws a 429 HttpError when the key has used up its failures
//   limiter.fail(key)   records one failed attempt
//   limiter.clear(key)  forgets the key (call after a success)
function createRateLimiter({ windowMs, max }) {
  const entries = new Map(); // key -> { failures, resetAt }

  const live = (key) => {
    const entry = entries.get(key);
    if (entry && entry.resetAt > Date.now()) return entry;
    entries.delete(key);
    return null;
  };

  const limiter = {
    check(key) {
      const entry = live(key);
      if (entry && entry.failures >= max) {
        const retryAfter = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
        throw new HttpError(
          429,
          `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          { retryAfter },
        );
      }
    },
    fail(key) {
      const entry = live(key) || { failures: 0, resetAt: Date.now() + windowMs };
      entry.failures += 1;
      entries.set(key, entry);
    },
    clear(key) {
      entries.delete(key);
    },
    reset() {
      entries.clear();
    },
  };

  // Drop expired entries now and then so the map cannot grow forever.
  const timer = setInterval(() => {
    for (const key of entries.keys()) live(key);
  }, Math.max(windowMs, 60 * 1000));
  timer.unref();

  registry.push(limiter);
  return limiter;
}

// For tests: forget every limiter's state.
const resetAllLimiters = () => registry.forEach((limiter) => limiter.reset());

module.exports = { createRateLimiter, resetAllLimiters };
