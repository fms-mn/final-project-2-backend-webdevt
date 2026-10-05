const express = require('express');
const mongoose = require('mongoose');
const Movie = require('../models/Movie');
const { adminAuth } = require('../middleware/auth');

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

// Get published movies (public)
router.get('/', async (req, res) => {
  try {
    const { genre, search } = req.query;
    const filter = { status: 'published' };

    if (typeof genre === 'string' && genre) {
      filter.genre = { $regex: `^${escapeRegex(genre)}$`, $options: 'i' };
    }
    if (typeof search === 'string' && search) {
      filter.title = { $regex: escapeRegex(search), $options: 'i' };
    }

    const movies = await Movie.find(filter).sort({ createdAt: -1 });
    res.json(movies);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get single published movie (public)
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Movie not found' });
    }
    const movie = await Movie.findOne({ _id: req.params.id, status: 'published' });
    if (!movie) {
      return res.status(404).json({ message: 'Movie not found' });
    }
    res.json(movie);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create movie (admin only)
router.post('/', adminAuth, async (req, res) => {
  try {
    const movie = new Movie(pickEditable(req.body));
    await movie.save();
    res.status(201).json(movie);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update movie (admin only)
router.put('/:id', adminAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Movie not found' });
    }
    const movie = await Movie.findByIdAndUpdate(req.params.id, pickEditable(req.body), {
      new: true,
      runValidators: true,
    });
    if (!movie) {
      return res.status(404).json({ message: 'Movie not found' });
    }
    res.json(movie);
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete movie (admin only)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Movie not found' });
    }
    const movie = await Movie.findByIdAndDelete(req.params.id);
    if (!movie) {
      return res.status(404).json({ message: 'Movie not found' });
    }
    res.json({ message: 'Movie deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
