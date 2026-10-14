const express = require('express');
const Movie = require('../models/Movie');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const { adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { requireId, dayRange, badRequest } = require('../utils/validate');
const { youtubeId } = require('../models/validators');
const { withShowingInfo } = require('../services/movieShowings');
const { withTransaction } = require('../utils/transaction');

const router = express.Router();

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Public responses carry only what browsing and booking need.
const publicMovie = (movie) => ({
  _id: movie._id,
  title: movie.title,
  synopsis: movie.synopsis,
  genre: movie.genre,
  rating: movie.rating,
  posterUrl: movie.posterUrl,
  duration: movie.duration,
  releaseDate: movie.releaseDate,
  // The YouTube video id of the trailer (or null). The website embeds it in the home banner.
  trailerId: youtubeId(movie.trailerUrl),
});

// Get published movies (public). Optional: ?search=text&genre=Drama&releaseFrom=2026-10-01&releaseTo=2026-12-31
router.get('/', wrap(async (req, res) => {
  const { genre, search, releaseFrom, releaseTo } = req.query;
  const filter = { status: 'published' };

  if (typeof genre === 'string' && genre) {
    filter.genre = { $regex: `^${escapeRegex(genre)}$`, $options: 'i' };
  }
  if (typeof search === 'string' && search) {
    filter.title = { $regex: escapeRegex(search), $options: 'i' };
  }
  if (releaseFrom !== undefined || releaseTo !== undefined) {
    const from = releaseFrom === undefined ? null : dayRange(releaseFrom);
    const to = releaseTo === undefined ? null : dayRange(releaseTo);
    if (releaseFrom !== undefined && !from) throw badRequest({ releaseFrom: 'releaseFrom must look like 2026-10-31' });
    if (releaseTo !== undefined && !to) throw badRequest({ releaseTo: 'releaseTo must look like 2026-10-31' });
    filter.releaseDate = {
      ...(from ? { $gte: from.start } : {}),
      ...(to ? { $lt: to.end } : {}),
    };
  }

  const movies = await Movie.find(filter).sort({ createdAt: -1 });
  res.json(await withShowingInfo(movies.map(publicMovie)));
}));

// Get single published movie (public). Drafts and archived movies answer 404.
router.get('/:id', wrap(async (req, res) => {
  requireId(req.params.id, 'Movie');
  const movie = await Movie.findOne({ _id: req.params.id, status: 'published' });
  if (!movie) throw new HttpError(404, 'Movie not found');
  res.json((await withShowingInfo([publicMovie(movie)]))[0]);
}));

// Delete a movie (admin only). A movie can go when nobody has a ticket history with it: its
// showings that were never booked (past, cancelled or unsold) are removed together with it. Coming
// showings must be cancelled first, and a movie whose showings have bookings (even cancelled ones)
// stays in the records so customers keep their ticket history. Archive that one instead.
router.delete('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Movie');
  await withTransaction(async (session) => {
    const movie = await Movie.findById(req.params.id).session(session);
    if (!movie) throw new HttpError(404, 'Movie not found');
    const now = new Date();
    const showings = await Showtime.find({ movie: movie._id }).session(session);
    if (showings.some((showing) => showing.status === 'scheduled' && showing.startTime > now)) {
      throw new HttpError(409, 'This movie still has coming showings. Take it off sale first (that cancels them), then delete it.');
    }
    const ids = showings.map((showing) => showing._id);
    if (ids.length) {
      const booked = await Booking.exists({ showtime: { $in: ids }, status: { $in: ['confirmed', 'cancelled'] } }).session(session);
      const held = await Booking.exists({ showtime: { $in: ids }, status: 'pending', holdExpiresAt: { $gt: now } }).session(session);
      if (booked || held) {
        throw new HttpError(409, 'Customers have booked tickets for this movie, so it has to stay in the records to keep their ticket history. Archive it to hide it from customers.');
      }
      await Booking.deleteMany({ showtime: { $in: ids } }, { session }); // only released or timed-out holds are left
      await Showtime.deleteMany({ movie: movie._id }, { session });
    }
    await Movie.deleteOne({ _id: movie._id }, { session });
  });
  res.json({ message: 'Movie deleted' });
}));

module.exports = router;
