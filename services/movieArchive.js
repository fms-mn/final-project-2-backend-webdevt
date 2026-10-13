const Movie = require('../models/Movie');
const Showtime = require('../models/Showtime');
const { getSettings } = require('./settings');
const { manilaDay } = require('../utils/manila');

const DAY = 24 * 60 * 60 * 1000;

// A movie that was released but has no showings left slowly turns into clutter: it still sits in
// the "all movies" list marked "No showings". This archives such movies by themselves.
//
// A published movie is archived when ALL of these hold:
//   - its release day has passed,
//   - it has no showing still to come (hidden ones count: they are plans),
//   - and its quiet time is over: the latest of (its last showing, its release date, the last time
//     an admin edited it) is at least `autoArchiveDays` days ago.
// Cancelled showings never happened, so they do not count as a showing. Editing a movie, for
// example publishing it again, restarts its clock, so an admin is never fighting the rule.
// autoArchiveDays = 0 switches the rule off.

// The movies that qualify now, with the date their quiet time started. Changes nothing.
async function staleMovies(now = new Date()) {
  const { autoArchiveDays } = await getSettings();
  if (!autoArchiveDays) return { enabled: false, days: 0, movies: [] };
  const cutoff = now.getTime() - autoArchiveDays * DAY;

  const published = (await Movie.find({ status: 'published' }))
    .filter((movie) => manilaDay(movie.releaseDate) <= manilaDay(now));
  if (published.length === 0) return { enabled: true, days: autoArchiveDays, movies: [] };

  const showings = await Showtime.find({ movie: { $in: published.map((movie) => movie._id) }, status: 'scheduled' }).select('movie startTime');
  const upcoming = new Set();
  const lastStart = new Map();
  for (const showing of showings) {
    const key = String(showing.movie);
    const start = new Date(showing.startTime).getTime();
    if (start > now.getTime()) upcoming.add(key);
    else if (start > (lastStart.get(key) ?? 0)) lastStart.set(key, start);
  }

  const movies = [];
  for (const movie of published) {
    const key = String(movie._id);
    if (upcoming.has(key)) continue;
    const quietSince = Math.max(
      lastStart.get(key) ?? 0,
      new Date(movie.releaseDate).getTime(),
      movie.updatedAt ? new Date(movie.updatedAt).getTime() : 0,
    );
    if (quietSince <= cutoff) movies.push({ _id: movie._id, title: movie.title, quietSince: new Date(quietSince), doc: movie });
  }
  return { enabled: true, days: autoArchiveDays, movies };
}

// Archives every movie that qualifies. Returns what it did.
async function archiveStaleMovies(now = new Date()) {
  const { enabled, days, movies } = await staleMovies(now);
  const archived = [];
  for (const { doc, title, _id, quietSince } of movies) {
    doc.status = 'archived';
    doc.autoArchivedAt = now;
    await doc.save();
    archived.push({ _id, title, quietSince });
  }
  return { enabled, days, archived };
}

// What the admin screen shows: the candidates without the documents.
const describeCandidates = (result) => ({
  enabled: result.enabled,
  days: result.days,
  movies: result.movies.map(({ _id, title, quietSince }) => ({ _id, title, quietSince })),
});

module.exports = { staleMovies, archiveStaleMovies, describeCandidates };
