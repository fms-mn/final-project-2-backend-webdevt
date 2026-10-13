const express = require('express');
const Movie = require('../models/Movie');
const Showtime = require('../models/Showtime');
const { adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const Booking = require('../models/Booking');
const { requireId, badRequest } = require('../utils/validate');
const { cancelShowtime } = require('../services/showtimes');
const { withShowingInfo } = require('../services/movieShowings');
const { assertCanPublish } = require('../services/moviePublishing');
const { staleMovies, archiveStaleMovies, describeCandidates } = require('../services/movieArchive');
const { manilaDay, manilaLabel, manilaDateLabel } = require('../utils/manila');

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
  const movies = await Movie.find(filter).sort({ createdAt: -1 });
  res.json(await withShowingInfo(movies.map((movie) => movie.toJSON())));
}));

router.post('/', adminAuth, wrap(async (req, res) => {
  const movie = new Movie(pickEditable(req.body));
  await movie.validate(); // a bad request is a 400 before the publish rule is looked at
  if (movie.status === 'published') await assertCanPublish(movie);
  await movie.save();
  res.status(201).json(movie);
}));

// Movies the automatic archive rule would archive right now (changes nothing), and a button to
// run the rule at once. The same rule also runs by itself every hour (see index.js).
router.get('/auto-archive', adminAuth, wrap(async (req, res) => {
  res.json(describeCandidates(await staleMovies()));
}));
router.post('/auto-archive', adminAuth, wrap(async (req, res) => {
  const result = await archiveStaleMovies();
  res.json({ enabled: result.enabled, days: result.days, archived: result.archived });
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
  // Archiving is refused from draft too: an archived movie's showings would still hold the room.
  const leavesPublished = movie.status === 'published'
    && changes.status !== undefined && changes.status !== 'published';
  const archives = changes.status === 'archived' && movie.status !== 'archived';
  if ((leavesPublished || archives) && await hasFutureShowtime(movie._id)) {
    throw new HttpError(409, 'This movie has upcoming showtimes. Cancel them before archiving or unpublishing it.');
  }
  const durationChanges = changes.duration !== undefined && Number(changes.duration) !== movie.duration;
  if (durationChanges && await hasFutureShowtime(movie._id)) {
    throw new HttpError(409, 'The duration cannot change while the movie has upcoming showtimes.');
  }

  // A new release date may not leave a coming showing before the release.
  if (changes.releaseDate !== undefined) {
    const release = new Date(changes.releaseDate);
    if (!Number.isNaN(release.getTime())) {
      const first = await Showtime.findOne({
        movie: movie._id, status: 'scheduled', startTime: { $gt: new Date() },
      }).sort({ startTime: 1 });
      if (first && manilaDay(first.startTime) < manilaDay(release)) {
        throw new HttpError(409, `The release date cannot be ${manilaDateLabel(release)}: a showing is already scheduled for ${manilaLabel(first.startTime)}. Move or cancel the earlier showings first.`);
      }
    }
  }

  if (changes.status !== undefined && changes.status !== movie.status) movie.autoArchivedAt = undefined;
  const wasPublished = movie.status === 'published';
  const oldRelease = new Date(movie.releaseDate).getTime();
  movie.set(changes);
  // Checked again when a published movie's release date moves: once released it must have showings.
  const releaseMoved = wasPublished && new Date(movie.releaseDate).getTime() !== oldRelease;
  if (movie.status === 'published' && (!wasPublished || releaseMoved)) await assertCanPublish(movie);
  await movie.save(); // runs every schema rule again, not only on the changed fields
  res.json(movie);
}));

// Takes a movie off sale in one step: cancels every coming showing (and the confirmed bookings on
// them, freeing the seats), then archives the movie (or moves it back to draft). With
// { dryRun: true } nothing changes and the answer says how many showings and bookings it would
// cancel, so the screen can ask "are you sure?". Safe to repeat: it carries on where it stopped.
router.post('/:id/withdraw', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Movie');
  const { dryRun = false, status = 'archived' } = req.body || {};
  if (typeof dryRun !== 'boolean') throw badRequest({ dryRun: 'dryRun must be true or false' });
  if (!['archived', 'draft'].includes(status)) throw badRequest({ status: 'status must be archived or draft' });

  const movie = await Movie.findById(req.params.id);
  if (!movie) throw new HttpError(404, 'Movie not found');

  const now = new Date();
  const showings = await Showtime.find({ movie: movie._id, status: 'scheduled', startTime: { $gt: now } });
  const bookings = showings.length
    ? await Booking.countDocuments({ showtime: { $in: showings.map((showing) => showing._id) }, status: 'confirmed' })
    : 0;
  if (dryRun) return res.json({ dryRun: true, status, showings: showings.length, bookings });

  // Unpublish first: nothing new can be scheduled for the movie while its showings are cancelled.
  if (movie.status !== status) {
    movie.status = status;
    movie.autoArchivedAt = undefined;
    await movie.save();
  }
  let cancelledBookings = 0;
  for (const showing of showings) {
    cancelledBookings += (await cancelShowtime(showing._id, now)).cancelledBookings;
  }
  res.json({ dryRun: false, status, showings: showings.length, bookings: cancelledBookings, movie });
}));

module.exports = router;
