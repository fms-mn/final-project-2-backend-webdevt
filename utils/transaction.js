const mongoose = require('mongoose');

// Runs `work(session)` inside a MongoDB transaction. The driver retries the whole callback when
// MongoDB reports a transient conflict (for example two admins changing the same auditorium's
// schedule at once), so everything the callback reads, including overlap checks, is evaluated
// again on the retry. A thrown error (such as an HttpError 409) rolls everything back.
async function withTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { withTransaction };
