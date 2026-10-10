const Showtime = require('../models/Showtime');
const { getSettings } = require('./settings');
const { manilaDay } = require('../utils/manila');

// What customers need to know about a movie beyond the movie itself: does it have showings they
// can still book, when is the next one, and what is the cheapest ticket.
//
//   upcomingShowings  how many showings can still be booked (visible, not cancelled, and the
//                     sales cutoff has not passed)
//   nextShowing       the start time of the earliest of them, or null
//   fromPrice         the cheapest ticket price among them in centavos, or null
//   showStatus        'coming_soon'  release day is still ahead
//                     'now_showing'  released and it has showings that can still be booked
//                     'not_showing'  released but nothing to book right now
//
// It is the showings, not the release date alone, that decide "now showing": a released movie
// with no showings must not look bookable.
function showStatusOf(movie, upcomingShowings, now) {
  if (manilaDay(movie.releaseDate) > manilaDay(now)) return 'coming_soon';
  return upcomingShowings > 0 ? 'now_showing' : 'not_showing';
}

// `movies` are plain objects with an `_id` and a `releaseDate`; returns copies with the fields added.
async function withShowingInfo(movies, now = new Date()) {
  if (movies.length === 0) return [];
  const { salesCutoffMinutes } = await getSettings();
  const bookableFrom = new Date(now.getTime() + salesCutoffMinutes * 60 * 1000);
  const showings = await Showtime.find({
    movie: { $in: movies.map((movie) => movie._id) },
    status: 'scheduled',
    isPublished: { $ne: false },
    startTime: { $gt: bookableFrom },
  }).select('movie startTime ticketPrice');

  const byMovie = new Map();
  for (const showing of showings) {
    const key = String(showing.movie);
    const entry = byMovie.get(key) || { count: 0, next: null, cheapest: null };
    entry.count += 1;
    if (!entry.next || showing.startTime < entry.next) entry.next = showing.startTime;
    if (entry.cheapest === null || showing.ticketPrice < entry.cheapest) entry.cheapest = showing.ticketPrice;
    byMovie.set(key, entry);
  }

  return movies.map((movie) => {
    const entry = byMovie.get(String(movie._id)) || { count: 0, next: null, cheapest: null };
    return {
      ...movie,
      upcomingShowings: entry.count,
      nextShowing: entry.next,
      fromPrice: entry.cheapest,
      showStatus: showStatusOf(movie, entry.count, now),
    };
  });
}

module.exports = { withShowingInfo, showStatusOf };
