/**
 * ONE-TIME helper for moving a development database to the new schema.
 *
 * Older versions of this project stored users with a `password` field, movies with
 * `description`/`now_showing` and bookings by movie. Those records do not fit the new
 * models, so the simplest fix on a development database is to remove them and run the
 * seed again:
 *
 *   npm run db:reset            (preview: shows what would be deleted, deletes nothing)
 *   npm run db:reset:confirm    (actually deletes)
 *   npm run seed
 *   npm run create-admin
 *
 * It deletes ONLY the collections of this app's six models: users, movies, auditoria, showtimes,
 * bookings and seatclaims. The preview command deletes nothing, and it refuses when NODE_ENV=production.
 * Never run it against a database that holds data you want to keep.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const Movie = require('../models/Movie');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const Booking = require('../models/Booking');
const SeatClaim = require('../models/SeatClaim');

// Taken from the models so the names always match what Mongoose really uses
// (for example Auditorium is stored in "auditoria").
const COLLECTIONS = [User, Movie, Auditorium, Showtime, Booking, SeatClaim].map((Model) => Model.collection.name);

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset a production database.');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI. Copy server/.env.example to server/.env and update the value.');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(`Database: "${mongoose.connection.name}"`);

  if (!process.argv.includes('--yes')) {
    for (const name of COLLECTIONS) {
      const count = await db.collection(name).countDocuments();
      console.log(`  ${name}: ${count} document(s) would be deleted`);
    }
    console.log('\nNothing was deleted. To delete them, run:');
    console.log('  npm run db:reset:confirm');
    return;
  }

  for (const name of COLLECTIONS) {
    const { deletedCount } = await db.collection(name).deleteMany({});
    // Indexes from the previous schema would conflict with the new ones, so drop the collection.
    await db.collection(name).drop().catch(() => {});
    console.log(`  ${name}: removed ${deletedCount} document(s)`);
  }
  console.log('Done. Now run: npm run seed   and   npm run create-admin');
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
