/**
 * Adds sample catalog data: movies, two auditoriums and a few upcoming showtimes.
 *
 *   npm run seed
 *
 * It only ADDS what is missing and never deletes or edits existing records, so it is safe to
 * run again and again. It creates no user accounts: create the first administrator with
 * `npm run create-admin`, and regular users register through the app.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');
const Auditorium = require('./models/Auditorium');
const Showtime = require('./models/Showtime');

if (!process.env.MONGODB_URI) {
  console.error(
    'Missing MONGODB_URI. Copy server/.env.example to server/.env and update the value.',
  );
  process.exit(1);
}

// price is in pesos here and stored as centavos on each showtime.
const movies = [
  {
    title: 'Dune: Part Three',
    synopsis:
      'Paul Atreides unites with the Fremen to take on the galactic emperor in the epic conclusion of the Dune saga. As ancient prophecies collide with political machinations, the fate of the universe hangs in the balance.',
    genre: 'Sci-Fi',
    duration: 166,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/d5NXSklXo0qyIYkgV94XAgMIckC.jpg',
    releaseDate: new Date('2026-11-15'),
    status: 'published',
    price: 400,
  },
  {
    title: 'Spider-Man: Beyond the Spider-Verse',
    synopsis:
      'Miles Morales embarks on his most dangerous journey yet across the multiverse, facing impossible choices that will redefine what it means to be Spider-Man.',
    genre: 'Animation',
    duration: 140,
    rating: 'PG',
    posterUrl: 'https://image.tmdb.org/t/p/w500/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg',
    releaseDate: new Date('2026-10-01'),
    status: 'published',
    price: 380,
  },
  {
    title: 'The Batman: Part II',
    synopsis:
      'Bruce Wayne continues his crusade against Gotham\'s criminal underworld, uncovering a conspiracy that threatens the very soul of the city.',
    genre: 'Action',
    duration: 175,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/74xTEgt7R36Fpooo50r9T25onhq.jpg',
    releaseDate: new Date('2026-10-20'),
    status: 'published',
    price: 420,
  },
  {
    title: 'Avatar 3: Fire and Ash',
    synopsis:
      'Jake Sully and the Omaticaya clan face a new elemental threat as the volcanic regions of Pandora awaken, bringing fire tribes and ancient dangers.',
    genre: 'Sci-Fi',
    duration: 190,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/aosm8NMQ34FzvFpsb7AO0m1VGlS.jpg',
    releaseDate: new Date('2026-12-19'),
    status: 'published',
    price: 450,
  },
  {
    title: 'Oppenheimer: The Aftermath',
    synopsis:
      'A gripping follow-up exploring the political fallout and moral reckoning in the years following the creation of the atomic bomb.',
    genre: 'Drama',
    duration: 152,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
    releaseDate: new Date('2026-11-08'),
    status: 'published',
    price: 380,
  },
  {
    // Left as a draft on purpose: drafts must not appear in public listings.
    title: 'Blade Runner 2099',
    synopsis:
      'In a dystopian future, a new blade runner uncovers a secret that could reshape the boundaries between humans and replicants forever.',
    genre: 'Thriller',
    duration: 145,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg',
    releaseDate: new Date('2027-01-15'),
    status: 'draft',
    price: 400,
  },
];

const auditoriums = [
  { name: 'Auditorium 1', rows: 8, seatsPerRow: 10 },
  { name: 'Auditorium 2', rows: 6, seatsPerRow: 8 },
];

// Showtimes start at these Asia/Manila hours, four hours apart, so the longest sample movie
// (190 minutes) never overlaps the next one in the same auditorium.
const SLOT_HOURS_MANILA = [10, 14, 18];
const SHOWTIME_DAYS = [1, 2, 3];
const MANILA_OFFSET_HOURS = 8; // Asia/Manila is UTC+8 all year

function manilaStart(dayOffset, hour) {
  const manilaNow = new Date(Date.now() + MANILA_OFFSET_HOURS * 3600 * 1000);
  return new Date(Date.UTC(
    manilaNow.getUTCFullYear(),
    manilaNow.getUTCMonth(),
    manilaNow.getUTCDate() + dayOffset,
    hour - MANILA_OFFSET_HOURS,
  ));
}

const seedDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    let addedMovies = 0;
    for (const { price, ...movie } of movies) {
      const result = await Movie.updateOne(
        { title: movie.title },
        { $setOnInsert: movie },
        { upsert: true, runValidators: true },
      );
      addedMovies += result.upsertedCount;
    }
    console.log(`Added ${addedMovies} missing sample movies`);

    let addedAuditoriums = 0;
    for (const sample of auditoriums) {
      if (!await Auditorium.exists({ name: sample.name })) {
        await new Auditorium(sample).save();
        addedAuditoriums += 1;
      }
    }
    console.log(`Added ${addedAuditoriums} missing sample auditoriums`);

    // Showtimes for published sample movies that have none yet. Skips any slot that would
    // overlap a showtime that already exists in that auditorium.
    const rooms = await Auditorium.find({ name: { $in: auditoriums.map((a) => a.name) } }).sort({ name: 1 });
    const published = movies.filter((movie) => movie.status === 'published');
    let addedShowtimes = 0;
    if (rooms.length > 0) {
      for (const [index, sample] of published.entries()) {
        const movie = await Movie.findOne({ title: sample.title });
        if (!movie || movie.status !== 'published') continue;
        if (await Showtime.exists({ movie: movie._id })) continue;

        const room = rooms[index % rooms.length];
        const hour = SLOT_HOURS_MANILA[Math.floor(index / rooms.length) % SLOT_HOURS_MANILA.length];
        for (const day of SHOWTIME_DAYS) {
          const startTime = manilaStart(day, hour);
          const endTime = Showtime.computeEndTime(startTime, movie.duration);
          const overlapping = await Showtime.exists({
            auditorium: room._id,
            status: 'scheduled',
            startTime: { $lt: endTime },
            endTime: { $gt: startTime },
          });
          if (overlapping) continue;
          await new Showtime({
            movie: movie._id,
            auditorium: room._id,
            startTime,
            endTime,
            ticketPrice: sample.price * 100,
          }).save();
          addedShowtimes += 1;
        }
      }
    }
    console.log(`Added ${addedShowtimes} missing sample showtimes`);
    console.log('Database seeded successfully!');
  } catch (error) {
    console.error('Seed error:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

seedDB();
