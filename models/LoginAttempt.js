const mongoose = require('mongoose');

// Failed sign-ins, counted per key (IP, or IP + email) until `expiresAt`. They live in the
// database, so a server restart or a second server does not give an attacker a fresh count.
// MongoDB removes expired rows by itself (TTL index).
const loginAttemptSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  failures: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

module.exports = mongoose.model('LoginAttempt', loginAttemptSchema);
