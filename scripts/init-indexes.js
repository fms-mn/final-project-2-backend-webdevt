/**
 * Creates every collection and index the app relies on, then checks that MongoDB can run
 * transactions (the booking flow needs a replica set; MongoDB Atlas qualifies).
 *
 *   npm run init-indexes
 *
 * Safe to run any number of times. It never drops or changes existing data. If an index
 * cannot be built (for example duplicate emails already exist) the script says so and exits 1.
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
const Setting = require('../models/Setting');
const LoginAttempt = require('../models/LoginAttempt');
const AuthToken = require('../models/AuthToken');
const Payment = require('../models/Payment');

const MODELS = [User, Movie, Auditorium, Showtime, Booking, SeatClaim, Setting, LoginAttempt, Payment, AuthToken];

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI. Copy server/.env.example to server/.env and update the value.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB database "${mongoose.connection.name}"`);

  for (const Model of MODELS) {
    await Model.init(); // creates the collection and builds the schema's indexes
    const indexes = await Model.listIndexes();
    const summary = indexes
      .filter((index) => index.name !== '_id_')
      .map((index) => `${index.name}${index.unique ? ' (unique)' : ''}`);
    console.log(`${Model.collection.name}: ${summary.length ? summary.join(', ') : 'no extra indexes'}`);
  }

  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  const supportsTransactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  if (supportsTransactions) {
    console.log('Transactions: supported (replica set / sharded cluster)');
  } else {
    console.warn(
      'WARNING: this MongoDB is a standalone server, so transactions will fail. '
      + 'Use MongoDB Atlas or a local replica set before building the booking flow.',
    );
  }
  console.log('Indexes are ready.');
}

main()
  .catch((error) => {
    console.error('Index setup failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
