const express = require('express');
const Movie = require('../models/Movie');
const Showtime = require('../models/Showtime');
const { adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { requireId, badRequest } = require('../utils/validate');

const router = express.Router();

// Only these fields may be set through the API.
const EDITABLE_FIELDS = [
  'title', 'synopsis', 'genre', 'rating', 'posterUrl', 'duration', 'releaseDate', 'status', 'trailerUrl',
];
const pickEditable = (body = {}) => Object.fromEntries(
  EDITABLE_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]),
);

const hasFutureShowtime = (movieId) => Showtime.exists({
  movie: movieId, status: 'scheduled', startTime: { $gt: new Date() },
});

// Every movie, whatever its status, so drafts and archived movies can be managed.
router.get('/', adminAuth, wrap(async (req, res) => {
  const filter = {};
  if (req.query.status !== undefined) {
    if (!['draft', 'published', 'archived'].includes(req.query.status)) {
      throw badRequest({ status: 'status must be draft, published or archived' });
    }
    filter.status = req.query.status;
  }
  res.json(await Movie.find(filter).sort({ createdAt: -1 }));
}));

router.post('/', adminAuth, wrap(async (req, res) => {
  const movie = new Movie(pickEditable(req.body));
  await movie.save();
  res.status(201).json(movie);
}));

router.patch('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Movie');
  const changes = pickEditable(req.body);
  if (Object.keys(changes).length === 0) {
    throw badRequest({ body: `Send at least one of: ${EDITABLE_FIELDS.join(', ')}` });
  }

  const movie = await Movie.findById(req.params.id);
  if (!movie) throw new HttpError(404, 'Movie not found');

  // A showtime needs a published movie of a known length, so neither may change under it.
  const leavesPublished = movie.status === 'published'
    && changes.status !== undefined && changes.status !== 'published';
  if (leavesPublished && await hasFutureShowtime(movie._id)) {
    throw new HttpError(409, 'This movie has upcoming showtimes. Cancel them before archiving or unpublishing it.');
  }
  const durationChanges = changes.duration !== undefined && Number(changes.duration) !== movie.duration;
  if (durationChanges && await hasFutureShowtime(movie._id)) {
    throw new HttpError(409, 'The duration cannot change while the movie has upcoming showtimes.');
  }

  movie.set(changes);
  await movie.save(); // runs every schema rule again, not only on the changed fields
  res.json(movie);
}));

module.exports = router;
