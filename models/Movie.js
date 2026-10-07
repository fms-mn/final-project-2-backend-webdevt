const mongoose = require('mongoose');
const { integer, youtubeLink } = require('./validators');

const HTTP_URL = /^https?:\/\/\S+$/i;

const movieSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    synopsis: { type: String, required: true, trim: true },
    genre: { type: String, required: true, trim: true },
    // Age classification, for example G, PG, PG-13 or R.
    rating: { type: String, required: true, trim: true },
    posterUrl: {
      type: String,
      required: true,
      trim: true,
      match: [HTTP_URL, 'posterUrl must be an http or https URL'],
    },
    // Minutes.
    duration: {
      type: Number,
      required: true,
      min: [1, 'duration must be a positive number of minutes'],
      validate: integer,
    },
    releaseDate: { type: Date, required: true },
    // Optional YouTube link. The home page banner plays the featured movie's trailer.
    // An empty text clears it.
    trailerUrl: {
      type: String,
      trim: true,
      set: (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      validate: youtubeLink,
    },
    // Only published movies appear in public listings.
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
  },
  { timestamps: true },
);

movieSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Movie', movieSchema);
