/**
 * Start the catalogue from zero: removes every movie and everything that hangs off movies, and
 * keeps the people and the cinema's set-up.
 *
 *   npm run clear-movies            (preview: shows what would be deleted, deletes nothing)
 *   npm run clear-movies:confirm    (actually deletes)
 *
 * Deleted:  movies, showtimes, bookings, seat claims and payments. A booking cannot exist without
 *           its showing and a showing cannot exist without its movie, so they have to go together.
 * Kept:     users (customers and admins, with their passwords and roles), auditoriums (the rooms
 *           and their seat layouts), and the cinema's settings.
 *
 * It uses the database in server/.env (MONGODB_URI). Check the database name it prints first: it
 * is the same database your deployed site uses if the two addresses match. This cannot be undone.
 */
const path = require('path');
const mongoose = require('mongoose');
const Movie = require('../models/Movie');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');
const Payment = require('../models/Payment');

// Order matters only for the report: everything is removed.
const REMOVED = [Payment, SeatClaim, Booking, Showtime, Movie];
const label = (Model) => Model.collection.name;

// Counts what is there and, unless `dryRun`, deletes it. Returns [{ name, count }].
async function clearMovies({ dryRun = true } = {}) {
  const report = [];
  for (const Model of REMOVED) {
    const count = await Model.countDocuments({});
    if (!dryRun && count > 0) await Model.deleteMany({});
    report.push({ name: label(Model), count });
  }
  return report;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (!process.env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI. Copy server/.env.example to server/.env and update the value.');
  }
  const confirmed = process.argv.includes('--yes');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Database: "${mongoose.connection.name}"\n`);

  const report = await clearMovies({ dryRun: !confirmed });
  for (const { name, count } of report) console.log(`  ${name}: ${count} document(s) ${confirmed ? 'removed' : 'would be removed'}`);
  console.log('\nKept as they are: users, auditoria (rooms), settings.');
  if (!confirmed) {
    console.log('\nNothing was deleted. If this is the right database, run:');
    console.log('  npm run clear-movies:confirm');
  } else {
    console.log('\nDone. The catalogue is empty: add your first movie from the admin page.');
  }
}

module.exports = { clearMovies };

if (require.main === module) {
  main()
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}
