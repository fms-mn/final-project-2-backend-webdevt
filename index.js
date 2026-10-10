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
    setInterval(() => { expireHolds().catch((error) => console.error('Releasing holds failed:', error.message)); }, 30 * 1000).unref();
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
