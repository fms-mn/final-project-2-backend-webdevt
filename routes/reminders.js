const express = require('express');
const Movie = require('../models/Movie');
const MovieReminder = require('../models/MovieReminder');
const { auth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { requireId } = require('../utils/validate');
const { manilaDay } = require('../utils/manila');

const router = express.Router();

// "Email me before this movie opens." Customers only: the reminder goes to the email on their account.
const customer = (req) => {
  if (req.user.role !== 'user') throw new HttpError(403, 'Only customer accounts can set movie reminders');
};

// The movies this customer has a reminder for that are still waiting to be sent.
router.get('/', auth, wrap(async (req, res) => {
  customer(req);
  const reminders = await MovieReminder.find({ user: req.user._id, remindedAt: null });
  res.json({ movieIds: reminders.map((reminder) => String(reminder.movie)) });
}));

// Turn a reminder on. Only a published movie that has not opened yet can have one.
router.put('/:movieId', auth, wrap(async (req, res) => {
  customer(req);
  requireId(req.params.movieId, 'Movie');
  const movie = await Movie.findOne({ _id: req.params.movieId, status: 'published' });
  if (!movie) throw new HttpError(404, 'Movie not found');
  if (manilaDay(movie.releaseDate) <= manilaDay(new Date())) {
    throw new HttpError(409, 'This movie has already opened, so there is nothing to be reminded about.');
  }
  const existing = await MovieReminder.findOne({ user: req.user._id, movie: movie._id });
  if (!existing) await new MovieReminder({ user: req.user._id, movie: movie._id }).save();
  else if (existing.remindedAt) await MovieReminder.updateOne({ _id: existing._id }, { $set: { remindedAt: null } });
  res.json({ reminding: true });
}));

// Turn it off again.
router.delete('/:movieId', auth, wrap(async (req, res) => {
  customer(req);
  requireId(req.params.movieId, 'Movie');
  await MovieReminder.deleteOne({ user: req.user._id, movie: req.params.movieId });
  res.json({ reminding: false });
}));

module.exports = router;
