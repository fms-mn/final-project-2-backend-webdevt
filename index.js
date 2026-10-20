const mongoose = require('mongoose');
require('dotenv').config();

const requiredEnvironmentVariables = ['MONGODB_URI', 'JWT_SECRET'];
const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
  (name) => !process.env[name],
);

if (missingEnvironmentVariables.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missingEnvironmentVariables.join(', ')}.\n` +
      'Copy server/.env.example to server/.env and update the values.',
  );
  process.exit(1);
}

// Sessions are signed with this secret, so a guessable one lets anyone forge a login.
const weakSecret =
  process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.includes('replace-this');
if (weakSecret) {
  const advice = 'JWT_SECRET is short or still the example value. Use a long random string (32+ characters).';
  if (process.env.NODE_ENV === 'production') {
    console.error(`${advice} Refusing to start in production.`);
    process.exit(1);
  }
  console.warn(`WARNING: ${advice}`);
}

if (process.env.NODE_ENV === 'production') {
  if (!process.env.TRUST_PROXY) {
    console.warn(
      'WARNING: TRUST_PROXY is not set. Behind a host such as Render or Railway set TRUST_PROXY=1, '
      + 'otherwise every visitor looks like the same IP (login rate limits) and HTTPS is not detected.',
    );
  }
}

const { createApp } = require('./app');

const app = createApp();

// Connect to MongoDB and start server
const PORT = process.env.PORT || 5000;

// Some Windows setups (VPN adapters, Pi-hole) leave Node's own resolver unable to look up the
// mongodb+srv:// address even though the browser works. DNS_SERVERS points Node at resolvers that do.
if (process.env.DNS_SERVERS) {
  require('dns').setServers(process.env.DNS_SERVERS.split(',').map((server) => server.trim()).filter(Boolean));
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    // Seats held for an unpaid booking go back on sale when the hold runs out. They are also
    // released whenever seats are shown or booked; this timer just keeps the database tidy.
    const { expireHolds } = require('./services/payments');
    // Released movies that have had no showings for a while are archived (see services/movieArchive.js
    // and the "Archive quiet movies" rule in the admin Settings). Checked an hour after start, then hourly.
    const { archiveStaleMovies } = require('./services/movieArchive');
    const sweepMovies = () => archiveStaleMovies()
      .then(({ archived }) => { if (archived.length) console.log(`Archived ${archived.length} quiet movie(s): ${archived.map((movie) => movie.title).join(', ')}`); })
      .catch((error) => console.error('Archiving quiet movies failed:', error.message));
    setTimeout(() => { sweepMovies(); setInterval(sweepMovies, 60 * 60 * 1000).unref(); }, 60 * 60 * 1000).unref();
    // Customers get one reminder email a few hours before their showing (see services/mail/reminders.js).
    // The same sweep can also be started from outside (POST /api/internal/sweep-reminders), which is
    // how reminders still go out when the host puts an idle server to sleep.
    const { sweepReminders: runReminderSweep } = require('./services/mail/reminders');
    const sweepReminders = async () => {
      const { showings, releases } = await runReminderSweep();
      if (showings.sent) console.log(`Sent ${showings.sent} showing reminder email(s)`);
      if (releases.sent) console.log(`Sent ${releases.sent} coming-soon reminder email(s)`);
    };
    setTimeout(() => { sweepReminders(); setInterval(sweepReminders, 10 * 60 * 1000).unref(); }, 60 * 1000).unref();
    setInterval(() => { expireHolds().catch((error) => console.error('Releasing holds failed:', error.message)); }, 30 * 1000).unref();
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
