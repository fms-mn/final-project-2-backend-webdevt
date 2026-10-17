const mongoose = require('mongoose');

// A one-time secret that proves someone controls an account's email address: a password reset link
// or an emailed sign-in code. Only a keyed hash of the secret is stored, so reading the database
// does not give anyone a working link or code. MongoDB removes expired rows by itself (TTL index).
const authTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  purpose: { type: String, enum: ['password-reset', 'login-code'], required: true },
  // The link secret (password reset) or the opaque challenge id the browser holds (sign-in code).
  tokenHash: { type: String, required: true, index: true },
  // The hashed 6-digit code (sign-in code only).
  codeHash: { type: String },
  attempts: { type: Number, default: 0 },
  sentCount: { type: Number, default: 1 },
  lastSentAt: { type: Date, default: Date.now },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

module.exports = mongoose.model('AuthToken', authTokenSchema);
