const { HttpError } = require('../utils/http');

function createBookingAdmission({ maxPerShowtime = 256, maxTotal = 1024 } = {}) {
  const screenings = new Map();
  let pending = 0;

  return async function admit(showtimeId, work) {
    const key = String(showtimeId).toLowerCase();
    const queue = screenings.get(key) || { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= maxPerShowtime || pending >= maxTotal) {
      throw new HttpError(503, 'Booking requests are busy right now. Please try again in a moment.', { retryAfter: 1 });
    }

    const previous = queue.tail;
    let release;
    queue.tail = new Promise(resolve => { release = resolve; });
    queue.pending += 1;
    pending += 1;
    screenings.set(key, queue);

    try {
      await previous;
      return await work();
    } finally {
      queue.pending -= 1;
      pending -= 1;
      release();
      if (queue.pending === 0) screenings.delete(key);
    }
  };
}

// Process-local admission avoids retry storms; MongoDB still arbitrates other processes and edits.
module.exports = { createBookingAdmission, admitBooking: createBookingAdmission() };
