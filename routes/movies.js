const express = require('express');
const Movie = require('../models/Movie');
const Showtime = require('../models/Showtime');
const { adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { requireId, dayRange, badRequest } = require('../utils/validate');

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
  res.json(movies.map(publicMovie));
}));

// Get single published movie (public). Drafts and archived movies answer 404.
router.get('/:id', wrap(async (req, res) => {
  requireId(req.params.id, 'Movie');
  const movie = await Movie.findOne({ _id: req.params.id, status: 'published' });
  if (!movie) throw new HttpError(404, 'Movie not found');
  res.json(publicMovie(movie));
}));

// Delete a movie (admin only). Only a movie no showtime has ever used can be deleted, so
// customers' bookings never lose their movie. Everything else should be archived instead.
router.delete('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Movie');
  const movie = await Movie.findById(req.params.id);
  if (!movie) throw new HttpError(404, 'Movie not found');
  if (await Showtime.exists({ movie: movie._id })) {
    throw new HttpError(409, 'This movie has showtimes, so it cannot be deleted. Archive it instead.');
  }
  await Movie.deleteOne({ _id: movie._id });
  res.json({ message: 'Movie deleted' });
}));

module.exports = router;
