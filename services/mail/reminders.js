const Booking = require('../../models/Booking');
const Showtime = require('../../models/Showtime');
const Movie = require('../../models/Movie');
const MovieReminder = require('../../models/MovieReminder');
const { manilaDay } = require('../../utils/manila');
const config = require('../../config');
const { sendReminder, sendMovieReminder } = require('./notifications');

const HOUR = 60 * 60 * 1000;
const MAX_PER_SWEEP = 200;

// Finds the confirmed bookings whose showing starts within the next REMINDER_HOURS and sends each
// customer one reminder. Run every few minutes (see index.js). A booking made shortly before the
// showing is not reminded about something they only just chose.
async function sendDueReminders(now = new Date()) {
  const until = new Date(now.getTime() + config.mail.reminderHours * HOUR);
  const showings = await Showtime.find({ status: 'scheduled', startTime: { $gt: now, $lte: until } });
  if (showings.length === 0) return { sent: 0, checked: 0 };

  const bookings = await Booking.find({ showtime: { $in: showings.map((showing) => showing._id) }, status: 'confirmed' });
  const recent = new Date(now.getTime() - HOUR);
  const due = bookings
    .filter((booking) => !booking.emailReminderAt && new Date(booking.bookedAt || 0) <= recent)
    .slice(0, MAX_PER_SWEEP);

  let sent = 0;
  for (const booking of due) {
    try {
      if (await sendReminder(booking._id, now)) sent += 1;
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') console.error('[mail] reminder failed:', error.message);
    }
  }
  return { sent, checked: due.length };
}

// Customers who asked to be reminded about a coming-soon movie get one email when it opens within
// RELEASE_REMINDER_DAYS (the day before, by default). Someone who asks on the last day is
// reminded at the next sweep. Run with the showing reminders (see index.js).
async function sendDueReleaseReminders(now = new Date()) {
  const pending = await MovieReminder.find({ remindedAt: null });
  if (pending.length === 0) return { sent: 0, checked: 0 };

  const movies = await Movie.find({ _id: { $in: [...new Set(pending.map((reminder) => String(reminder.movie)))] }, status: 'published' });
  const today = manilaDay(now);
  const last = manilaDay(new Date(now.getTime() + config.mail.releaseReminderDays * 24 * HOUR));
  const soon = new Set(movies.filter((movie) => { const day = manilaDay(movie.releaseDate); return day >= today && day <= last; }).map((movie) => String(movie._id)));
  const due = pending.filter((reminder) => soon.has(String(reminder.movie))).slice(0, MAX_PER_SWEEP);

  let sent = 0;
  for (const reminder of due) {
    try {
      if (await sendMovieReminder(reminder._id, now)) sent += 1;
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') console.error('[mail] movie reminder failed:', error.message);
    }
  }
  return { sent, checked: due.length };
}

module.exports = { sendDueReminders, sendDueReleaseReminders };
