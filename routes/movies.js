const express = require('express');
const mongoose = require('mongoose');
const Movie = require('../models/Movie');
const { adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');

const router = express.Router();

// Only these fields may be set through the API.
const EDITABLE_FIELDS = [
  'title',
  'synopsis',
  'genre',
  'rating',
  'posterUrl',
  'duration',
  'releaseDate',
  'status',
];

const pickEditable = (body = {}) => Object.fromEntries(
  EDITABLE_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]),
);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const requireValidId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Movie not found');
};

// Get published movies (public)
router.get('/', wrap(async (req, res) => {
  const { genre, search } = req.query;
  const filter = { status: 'published' };

  if (typeof genre === 'string' && genre) {
    filter.genre = { $regex: `^${escapeRegex(genre)}$`, $options: 'i' };
  }
  if (typeof search === 'string' && search) {
    filter.title = { $regex: escapeRegex(search), $options: 'i' };
  }

  res.json(await Movie.find(filter).sort({ createdAt: -1 }));
}));

// Every movie including drafts and archived ones (admin only). Registered before /:id.
router.get('/manage/all', adminAuth, wrap(async (req, res) => {
  res.json(await Movie.find().sort({ createdAt: -1 }));
}));

// Get single published movie (public)
router.get('/:id', wrap(async (req, res) => {
  requireValidId(req.params.id);
  const movie = await Movie.findOne({ _id: req.params.id, status: 'published' });
  if (!movie) throw new HttpError(404, 'Movie not found');
  res.json(movie);
}));

// Create movie (admin only)
router.post('/', adminAuth, wrap(async (req, res) => {
  const movie = new Movie(pickEditable(req.body));
  await movie.save();
  res.status(201).json(movie);
}));

// Update movie (admin only)
router.put('/:id', adminAuth, wrap(async (req, res) => {
  requireValidId(req.params.id);
  const movie = await Movie.findByIdAndUpdate(req.params.id, pickEditable(req.body), {
    new: true,
    runValidators: true,
  });
  if (!movie) throw new HttpError(404, 'Movie not found');
  res.json(movie);
}));

// Delete movie (admin only)
router.delete('/:id', adminAuth, wrap(async (req, res) => {
  requireValidId(req.params.id);
  const movie = await Movie.findByIdAndDelete(req.params.id);
  if (!movie) throw new HttpError(404, 'Movie not found');
  res.json({ message: 'Movie deleted' });
}));

module.exports = router;
