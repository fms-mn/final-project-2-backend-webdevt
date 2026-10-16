/**
 * Writes every email the app sends to server/.mail-preview/ as web pages, with made-up data, so the
 * design can be looked at in a browser without sending anything:
 *
 *   npm run mail:preview      then open server/.mail-preview/index.html
 */
const fs = require('fs');
const path = require('path');
process.env.APP_URL = process.env.APP_URL || 'https://filme.example';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const templates = require('../services/mail/templates');
const { ticketOf } = require('../services/mail/notifications');

const OUT = path.join(__dirname, '..', '.mail-preview');
const LOGO = path.join(__dirname, '..', '..', 'client', 'public', 'email-logo.png');

// A plain blue poster. Real emails link to the movie's poster on the web; the preview swaps this for
// an inline image so it works without the internet.
const POSTER_URL = 'https://filme.example/poster.svg';
const posterImage = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#3b6fb6"/><text x="200" y="310" font-family="Georgia" font-size="46" fill="#fff" text-anchor="middle">Toy Story</text></svg>')}`;

// 2:00 PM cinema time (Manila), two days from now.
const day = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const start = new Date(`${day}T14:00:00+08:00`);
const sample = ticketOf({
  booking: { bookingCode: 'FLM-7K3QX9PD', seats: ['C4', 'C5'], unitPrice: 40000, totalAmount: 80000 },
  showtime: { startTime: start },
  movie: { _id: '507f1f77bcf86cd799439011', title: 'Toy Story', posterUrl: POSTER_URL, rating: 'G', genre: 'Animation', duration: 81 },
  auditorium: { name: 'Auditorium 1' },
  payment: { method: 'card', cardBrand: 'Visa', cardLast4: '4242', reference: 'PAY-9XJ4M2KD', refundReference: 'RF-3QH7T8LA' },
});
const before = { dateShort: 'Thu, Oct 15', time: '10:00 AM', room: 'Auditorium 2' };
const name = 'Ann Reyes';

const emails = [
  ['welcome', 'Welcome', templates.welcome({ name })],
  ['booking-confirmed', 'Booking confirmed + receipt', templates.bookingConfirmed(sample, { name })],
  ['booking-cancelled', 'Booking cancelled by the customer (refund)', templates.bookingCancelled(sample, { name, byCinema: false, refunded: true })],
  ['booking-cancelled-cinema', 'Booking cancelled by the cinema', templates.bookingCancelled(sample, { name, byCinema: true, refunded: true })],
  ['showing-cancelled', 'Showing cancelled by the cinema', templates.showingCancelled(sample, { name, refunded: true })],
  ['showing-moved', 'Showing moved', templates.showingMoved(sample, { name, before })],
  ['reminder', 'Reminder before the showing', templates.reminder(sample, { name, when: 'tomorrow at 2:00 PM' })],
  ['test', 'Test email from the admin page', templates.testEmail({ to: 'boss@example.com', providerLabel: 'Brevo', at: 'Oct 16, 2026, 1:30 PM' })],
];

fs.mkdirSync(OUT, { recursive: true });
const logo = fs.existsSync(LOGO) ? `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}` : '';
for (const [file, , mail] of emails) {
  const page = mail.html.split(POSTER_URL).join(posterImage.replace(/"/g, '&quot;'));
  fs.writeFileSync(path.join(OUT, `${file}.html`), logo ? page.split('https://filme.example/email-logo.png').join(logo) : page);
}
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Email previews</title>
<body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h1>Email previews</h1>
<ul>${emails.map(([file, title, mail]) => `<li style="margin:10px 0"><a href="${file}.html">${title}</a><br><small style="color:#666">Subject: ${mail.subject.replace(/</g, '&lt;')}</small></li>`).join('')}</ul></body>`);
console.log(`Wrote ${emails.length} emails to ${OUT}\nOpen ${path.join(OUT, 'index.html')} in your browser.`);
