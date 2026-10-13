const Showtime = require('../models/Showtime');
const { HttpError } = require('../utils/http');
const { manilaDay } = require('../utils/manila');
const { getSettings } = require('./settings');

// A movie goes live (published) in one of two honest states:
//   - "coming soon": its release day is still ahead, so customers see the announcement, or
//   - "now showing": it is released and has at least one showing customers can still book.
// A released movie with nothing to book would just say "No showings", so it cannot be published.
// Showings can be scheduled while the movie is still a draft (customers cannot see them yet), so
// the admin schedules first and publishes second.
//
// `movie` needs a `title`, a `releaseDate` and an `_id` (a movie that has not been saved yet is fine).
async function assertCanPublish(movie, now = new Date()) {
  if (manilaDay(movie.releaseDate) > manilaDay(now)) return;
  // "Bookable" means what customers see: online sales close salesCutoffMinutes before the start.
  const { salesCutoffMinutes } = await getSettings();
  const bookable = await Showtime.exists({
    movie: movie._id, status: 'scheduled', isPublished: { $ne: false },
    startTime: { $gt: new Date(now.getTime() + salesCutoffMinutes * 60 * 1000) },
  });
  if (!bookable) {
    throw new HttpError(
      409,
      `"${movie.title}" is already released, so customers would see "No showings". Schedule at least one showing for it first, then publish it.`,
    );
  }
}

module.exports = { assertCanPublish };
