const Booking = require('../../models/Booking');
const Showtime = require('../../models/Showtime');
const Movie = require('../../models/Movie');
const Auditorium = require('../../models/Auditorium');
const Payment = require('../../models/Payment');
const User = require('../../models/User');
const { manilaDay } = require('../../utils/manila');
const { sendMail, notify, status } = require('./index');
const templates = require('./templates');

// The moments an email goes out. Each function is called from the code that causes the event (a
// payment settles, a booking is cancelled, ...) AFTER its database work is done, and returns at
// once: the email is prepared and sent in the background, so a slow or broken email service can
// never hold up or undo a booking. Every one is safe to call for a booking that has gone missing.

const ZONE = 'Asia/Manila';
const idOf = (value) => String(value?._id ?? value);

// ---- turning records into the words an email shows -----------------------------------------
const money = (centavos) => new Intl.NumberFormat('en-PH', {
  style: 'currency', currency: 'PHP', minimumFractionDigits: Number(centavos) % 100 ? 2 : 0, maximumFractionDigits: 2,
}).format((Number(centavos) || 0) / 100);

const tidy = (value) => value.replace(/[\u00A0\u202F]/g, ' ').replace(/\b(am|pm)\b/i, (part) => part.toUpperCase());
const dayShort = (date) => new Date(date).toLocaleDateString('en-PH', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric' });
const dayLong = (date) => new Date(date).toLocaleDateString('en-PH', { timeZone: ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const clock = (date) => tidy(new Date(date).toLocaleTimeString('en-PH', { timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true }));
const lengthOf = (minutes) => (Number(minutes) > 0 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : '');

const METHODS = { gcash: 'GCash', maya: 'Maya' };
function methodOf(payment) {
  if (!payment) return '';
  if (payment.method === 'card') return `${payment.cardBrand || 'Card'} •••• ${payment.cardLast4 || ''}`.trim();
  return `${METHODS[payment.method] || payment.method} •••• ${payment.walletLast4 || ''}`.trim();
}

// Everything about one booking, loaded together. Returns null when a piece is missing.
async function loadBooking(bookingId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;
  const [user, showtime] = await Promise.all([User.findById(booking.user), Showtime.findById(booking.showtime)]);
  if (!user || !showtime) return null;
  const [movie, auditorium, attempts] = await Promise.all([
    Movie.findById(showtime.movie), Auditorium.findById(showtime.auditorium), Payment.find({ booking: booking._id }),
  ]);
  const settled = [...attempts].filter((payment) => ['paid', 'refunded'].includes(payment.status));
  const payment = settled.sort((a, b) => new Date(b.updatedAt || b.paidAt || 0) - new Date(a.updatedAt || a.paidAt || 0))[0] || null;
  return { booking, user, showtime, movie, auditorium, payment };
}

// The view of a booking that every template uses.
function ticketOf({ booking, showtime, movie, auditorium, payment }) {
  const genre = Array.isArray(movie?.genre) ? movie.genre[0] : movie?.genre;
  return {
    code: booking.bookingCode,
    movieId: movie ? idOf(movie) : '',
    movieTitle: movie?.title || 'Your movie',
    posterUrl: movie?.posterUrl || '',
    rating: movie?.rating || '',
    genre: genre || '',
    durationLabel: lengthOf(movie?.duration),
    startsAt: showtime.startTime,
    dateShort: dayShort(showtime.startTime),
    dateLong: dayLong(showtime.startTime),
    time: clock(showtime.startTime),
    room: auditorium?.name || 'Cinema',
    seats: [...booking.seats],
    quantity: booking.seats.length,
    unitPriceText: money(booking.unitPrice),
    totalText: money(booking.totalAmount),
    method: methodOf(payment),
    paymentReference: payment?.reference || '',
    refundReference: payment?.refundReference || '',
    simulated: require('../payments').PAYMENT_MODE === 'simulated',
  };
}

const deliver = async (data, mail) => sendMail({ to: data.user.email, toName: data.user.name, ...mail });

// ---- the notifications ----------------------------------------------------------------------

// A new account.
const welcome = (userId) => notify(async () => {
  const user = await User.findById(userId);
  if (!user || user.role === 'admin') return;
  await sendMail({ to: user.email, toName: user.name, ...templates.welcome({ name: user.name }) });
});

// A booking was paid for (or booked with payments switched off). Sent once per booking.
const bookingConfirmed = (bookingId) => notify(async () => {
  const data = await loadBooking(bookingId);
  if (!data || data.booking.status !== 'confirmed' || data.booking.emailConfirmedAt) return;
  const result = await deliver(data, templates.bookingConfirmed(ticketOf(data), { name: data.user.name }));
  if (result.ok) await Booking.updateOne({ _id: data.booking._id }, { $set: { emailConfirmedAt: new Date() } });
});

// A booking was cancelled by its owner (or by an admin, with `byCinema`).
const bookingCancelled = (bookingId, { byCinema = false } = {}) => notify(async () => {
  const data = await loadBooking(bookingId);
  if (!data || data.booking.status !== 'cancelled') return;
  await deliver(data, templates.bookingCancelled(ticketOf(data), {
    name: data.user.name, byCinema, refunded: data.booking.paymentStatus === 'refunded',
  }));
});

// The cinema cancelled a showing: one email to every customer who had a ticket for it.
const showingCancelled = (bookingIds) => notify(async () => {
  for (const bookingId of bookingIds) {
    try {
      const data = await loadBooking(bookingId);
      if (!data) continue;
      await deliver(data, templates.showingCancelled(ticketOf(data), { name: data.user.name, refunded: data.booking.paymentStatus === 'refunded' }));
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') console.error('[mail] showing-cancelled failed for one booking:', error.message);
    }
  }
});

// The cinema moved a showing to another time or room. `before` is { startTime, auditoriumId }.
const showingMoved = (showtimeId, before) => notify(async () => {
  const bookings = await Booking.find({ showtime: showtimeId, status: 'confirmed' });
  const oldRoom = before.auditoriumId ? await Auditorium.findById(before.auditoriumId) : null;
  const was = { dateShort: dayShort(before.startTime), time: clock(before.startTime), room: oldRoom?.name || 'Cinema' };
  for (const booking of bookings) {
    try {
      const data = await loadBooking(booking._id);
      if (!data) continue;
      await deliver(data, templates.showingMoved(ticketOf(data), { name: data.user.name, before: was }));
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') console.error('[mail] showing-moved failed for one booking:', error.message);
    }
  }
});

// "today at 2:00 PM", "tomorrow at 10:00 AM", or "on Fri, Oct 16 at 2:00 PM".
function whenPhrase(startsAt, now = new Date()) {
  const day = manilaDay(startsAt);
  const today = manilaDay(now);
  const tomorrow = manilaDay(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const at = clock(startsAt);
  if (day === today) return `today at ${at}`;
  if (day === tomorrow) return `tomorrow at ${at}`;
  return `on ${dayShort(startsAt)} at ${at}`;
}

// A reminder shortly before the showing. Sent once per booking; returns whether it went out.
async function sendReminder(bookingId, now = new Date()) {
  const data = await loadBooking(bookingId);
  if (!data || data.booking.status !== 'confirmed' || data.booking.emailReminderAt) return false;
  const mail = templates.reminder(ticketOf(data), { name: data.user.name, when: whenPhrase(data.showtime.startTime, now) });
  const result = await deliver(data, mail);
  if (result.ok) await Booking.updateOne({ _id: data.booking._id }, { $set: { emailReminderAt: new Date() } });
  return Boolean(result.ok);
}

// The admin's "send me a test email" button. Answers with what happened, so the page can show it.
async function sendTest(to) {
  const info = status();
  const result = await sendMail({
    to, ...templates.testEmail({
      to, providerLabel: info.label, at: new Date().toLocaleString('en-PH', { timeZone: ZONE, dateStyle: 'medium', timeStyle: 'short' }),
    }),
  });
  return { ...result, label: info.label, simulated: Boolean(result.simulated) };
}

module.exports = {
  welcome, bookingConfirmed, bookingCancelled, showingCancelled, showingMoved, sendReminder, sendTest,
  // exposed for the preview script and tests
  ticketOf, money, whenPhrase,
};
