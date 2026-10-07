/**
 * Adds sample catalog data: movies, five auditoriums and a few upcoming showtimes.
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
  // ---- Classics that are already showing (released long ago) -----------------------------------
  {
    title: 'The Dark Knight',
    synopsis:
      'Batman, Lieutenant Gordon and District Attorney Harvey Dent set out to dismantle Gotham\'s organized crime, until a chaotic criminal known as the Joker pushes the city to its breaking point.',
    genre: 'Action',
    duration: 152,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
    releaseDate: new Date('2008-07-18'),
    status: 'published',
    price: 400,
  },
  {
    title: 'Inception',
    synopsis:
      'A skilled thief who steals secrets from inside people\'s dreams is offered a final job: plant an idea in a target\'s mind. The deeper the team goes, the less certain reality becomes.',
    genre: 'Sci-Fi',
    duration: 148,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/ljsZTbVsrQSqZgWeep2B1QiDKuh.jpg',
    releaseDate: new Date('2010-07-16'),
    status: 'published',
    price: 400,
  },
  {
    title: 'Interstellar',
    synopsis:
      'With Earth\'s crops failing, a former pilot joins a team of explorers who travel through a wormhole in search of a new home for humanity, at the cost of time with the family they leave behind.',
    genre: 'Sci-Fi',
    duration: 169,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
    releaseDate: new Date('2014-11-07'),
    status: 'published',
    price: 450,
  },
  {
    title: 'Parasite',
    synopsis:
      'A struggling family schemes its way into the lives of a wealthy household, one job at a time, until an unexpected discovery turns the arrangement into something far more dangerous.',
    genre: 'Thriller',
    duration: 132,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg',
    releaseDate: new Date('2019-10-11'),
    status: 'published',
    price: 350,
  },
  {
    title: 'Spirited Away',
    synopsis:
      'On the way to their new home, a ten-year-old girl wanders into a world of spirits and bathhouses where her parents are turned into pigs, and she must work to free them and find her way back.',
    genre: 'Animation',
    duration: 125,
    rating: 'PG',
    posterUrl: 'https://image.tmdb.org/t/p/w500/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg',
    releaseDate: new Date('2001-07-20'),
    status: 'published',
    price: 300,
  },
  {
    title: 'The Godfather',
    synopsis:
      'The aging head of a powerful crime family hands control to his reluctant youngest son, who is drawn deeper into the family business than he ever intended.',
    genre: 'Drama',
    duration: 175,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/3bhkrj58Vtu7enYsRolD1fZdja1.jpg',
    releaseDate: new Date('1972-03-24'),
    status: 'published',
    price: 350,
  },
  {
    title: 'The Matrix',
    synopsis:
      'A computer hacker learns that the world he lives in is a simulation built by machines, and joins a small band of rebels fighting to free humanity from it.',
    genre: 'Sci-Fi',
    duration: 136,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
    releaseDate: new Date('1999-03-31'),
    status: 'published',
    price: 350,
  },
  {
    title: 'Forrest Gump',
    synopsis:
      'A kind-hearted man with a low IQ drifts through decades of American history, unknowingly shaping events along the way while holding on to the one love of his life.',
    genre: 'Drama',
    duration: 142,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/arw2vcBveWOVZr6pxd9XTd1TdQa.jpg',
    releaseDate: new Date('1994-07-06'),
    status: 'published',
    price: 350,
  },
  {
    title: 'Pulp Fiction',
    synopsis:
      'The lives of two hitmen, a boxer, a gangster and his wife, and a pair of diner bandits intertwine in four tales of violence and redemption in Los Angeles.',
    genre: 'Crime',
    duration: 154,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg',
    releaseDate: new Date('1994-10-14'),
    status: 'published',
    price: 350,
  },
  {
    title: 'Toy Story',
    synopsis:
      'A cowboy doll feels threatened when a flashy new space ranger toy becomes his owner\'s favorite, and the two rivals must work together after they are lost far from home.',
    genre: 'Animation',
    duration: 81,
    rating: 'G',
    posterUrl: 'https://image.tmdb.org/t/p/w500/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg',
    trailerUrl: 'https://www.youtube.com/watch?v=c51ND9Hdbw0',
    releaseDate: new Date('1995-11-22'),
    status: 'published',
    price: 300,
  },
];

const auditoriums = [
  { name: 'Auditorium 1', rows: 8, seatsPerRow: 10 },
  { name: 'Auditorium 2', rows: 6, seatsPerRow: 8 },
  { name: 'Auditorium 3', rows: 6, seatsPerRow: 10 },
  { name: 'Auditorium 4', rows: 5, seatsPerRow: 8 },
  { name: 'Auditorium 5', rows: 8, seatsPerRow: 12 },
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
    let addedTrailers = 0;
    for (const { price, trailerUrl, ...movie } of movies) {
      const result = await Movie.updateOne(
        { title: movie.title },
        { $setOnInsert: { ...movie, ...(trailerUrl ? { trailerUrl } : {}) } },
        { upsert: true, runValidators: true },
      );
      addedMovies += result.upsertedCount;
      // A movie that already exists keeps everything it has, but gets a sample trailer when it has
      // none. A trailer an admin already saved is never replaced.
      if (trailerUrl && !result.upsertedCount) {
        const filled = await Movie.updateOne(
          { title: movie.title, trailerUrl: { $exists: false } },
          { $set: { trailerUrl } },
          { runValidators: true },
        );
        addedTrailers += filled.modifiedCount;
      }
    }
    console.log(`Added ${addedMovies} missing sample movies`);
    console.log(`Added ${addedTrailers} missing sample trailers`);

    let addedAuditoriums = 0;
    for (const sample of auditoriums) {
      if (!await Auditorium.exists({ name: sample.name })) {
        await new Auditorium(sample).save();
        addedAuditoriums += 1;
      }
    }
    console.log(`Added ${addedAuditoriums} missing sample auditoriums`);

    // Showtimes for published sample movies that have none yet. Each movie takes the first
    // auditorium and start time that is free on all of its showtime days, so any number of sample
    // movies fit as long as there are free slots, and nothing that already exists is touched.
    const rooms = await Auditorium.find({ name: { $in: auditoriums.map((a) => a.name) } }).sort({ name: 1 });
    const published = movies.filter((movie) => movie.status === 'published');
    const isFree = async (room, startTime, endTime) => !await Showtime.exists({
      auditorium: room._id,
      status: 'scheduled',
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });
    let addedShowtimes = 0;
    for (const sample of published) {
      const movie = await Movie.findOne({ title: sample.title });
      if (!movie || movie.status !== 'published') continue;
      if (await Showtime.exists({ movie: movie._id })) continue;

      let placed = false;
      for (const hour of SLOT_HOURS_MANILA) {
        for (const room of rooms) {
          const slots = SHOWTIME_DAYS.map((day) => {
            const startTime = manilaStart(day, hour);
            return { startTime, endTime: Showtime.computeEndTime(startTime, movie.duration) };
          });
          let allFree = true;
          for (const { startTime, endTime } of slots) {
            if (!await isFree(room, startTime, endTime)) { allFree = false; break; }
          }
          if (!allFree) continue;
          for (const { startTime, endTime } of slots) {
            await new Showtime({
              movie: movie._id,
              auditorium: room._id,
              startTime,
              endTime,
              ticketPrice: sample.price * 100,
            }).save();
            addedShowtimes += 1;
          }
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (!placed) console.log(`No free auditorium slot for "${movie.title}", so it has no showtimes yet`);
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
