const mongoose = require('mongoose');

// "Email me when this movie is about to open": one row per customer and coming-soon movie.
// `remindedAt` is set once the email has gone out, so nobody is reminded twice.
const movieReminderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  movie: { type: mongoose.Schema.Types.ObjectId, ref: 'Movie', required: true, index: true },
  remindedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

movieReminderSchema.index({ user: 1, movie: 1 }, { unique: true });

module.exports = mongoose.model('MovieReminder', movieReminderSchema);
