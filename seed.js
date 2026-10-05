require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

if (!process.env.MONGODB_URI) {
  console.error(
    'Missing MONGODB_URI. Copy server/.env.example to server/.env and update the value.',
  );
  process.exit(1);
}

const movies = [
  {
    title: 'Dune: Part Three',
    description:
      'Paul Atreides unites with the Fremen to take on the galactic emperor in the epic conclusion of the Dune saga. As ancient prophecies collide with political machinations, the fate of the universe hangs in the balance.',
    genre: ['Sci-Fi', 'Adventure', 'Drama'],
    duration: 166,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/d5NXSklXo0qyIYkgV94XAgMIckC.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/original/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg',
    director: 'Denis Villeneuve',
    cast: ['Timothée Chalamet', 'Zendaya', 'Florence Pugh', 'Austin Butler'],
    releaseDate: new Date('2026-11-15'),
    status: 'now_showing',
    price: 400,
  },
  {
    title: 'Spider-Man: Beyond the Spider-Verse',
    description:
      'Miles Morales embarks on his most dangerous journey yet across the multiverse, facing impossible choices that will redefine what it means to be Spider-Man.',
    genre: ['Animation', 'Action', 'Adventure'],
    duration: 140,
    rating: 'PG',
    posterUrl: 'https://image.tmdb.org/t/p/w500/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/original/4HodYYKEIsGOdinkGi2Ucz6X9i0.jpg',
    director: 'Joaquim Dos Santos',
    cast: ['Shameik Moore', 'Hailee Steinfeld', 'Oscar Isaac'],
    releaseDate: new Date('2026-10-01'),
    status: 'now_showing',
    price: 380,
  },
  {
    title: 'The Batman: Part II',
    description:
      'Bruce Wayne continues his crusade against Gotham\'s criminal underworld, uncovering a conspiracy that threatens the very soul of the city.',
    genre: ['Action', 'Crime', 'Drama'],
    duration: 175,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/74xTEgt7R36Fpooo50r9T25onhq.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/original/b0PlSFdDwbyFAJlB1lnhj0Tv48T.jpg',
    director: 'Matt Reeves',
    cast: ['Robert Pattinson', 'Zoë Kravitz', 'Colin Farrell'],
    releaseDate: new Date('2026-10-20'),
    status: 'now_showing',
    price: 420,
  },
  {
    title: 'Avatar 3: Fire and Ash',
    description:
      'Jake Sully and the Omaticaya clan face a new elemental threat as the volcanic regions of Pandora awaken, bringing fire tribes and ancient dangers.',
    genre: ['Sci-Fi', 'Adventure', 'Fantasy'],
    duration: 190,
    rating: 'PG-13',
    posterUrl: 'https://image.tmdb.org/t/p/w500/aosm8NMQ34FzvFpsb7AO0m1VGlS.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/original/198vrF8k7mfQ4FjDJsBmdQcaiyq.jpg',
    director: 'James Cameron',
    cast: ['Sam Worthington', 'Zoe Saldaña', 'Sigourney Weaver'],
    releaseDate: new Date('2026-12-19'),
    status: 'coming_soon',
    price: 450,
  },
  {
    title: 'Oppenheimer: The Aftermath',
    description:
      'A gripping follow-up exploring the political fallout and moral reckoning in the years following the creation of the atomic bomb.',
    genre: ['Drama', 'History', 'Thriller'],
    duration: 152,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/original/fm6KqXpk3M2HVveHwCrBSSBaO0V.jpg',
    director: 'Christopher Nolan',
    cast: ['Cillian Murphy', 'Emily Blunt', 'Robert Downey Jr.'],
    releaseDate: new Date('2026-11-08'),
    status: 'now_showing',
    price: 380,
  },
  {
    title: 'Blade Runner 2099',
    description:
      'In a dystopian future, a new blade runner uncovers a secret that could reshape the boundaries between humans and replicants forever.',
    genre: ['Sci-Fi', 'Thriller', 'Drama'],
    duration: 145,
    rating: 'R',
    posterUrl: 'https://image.tmdb.org/t/p/w500/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/original/sRLC052ieEzkQs9dEtPMfFxYkej.jpg',
    director: 'Ridley Scott',
    cast: ['Ana de Armas', 'Dave Bautista', 'Jared Leto'],
    releaseDate: new Date('2027-01-15'),
    status: 'coming_soon',
    price: 400,
  },
];

const seedDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    let addedMovies = 0;
    for (const movie of movies) {
      const result = await Movie.updateOne(
        { title: movie.title },
        { $setOnInsert: movie },
        { upsert: true },
      );
      addedMovies += result.upsertedCount;
    }
    console.log(`Added ${addedMovies} missing sample movies`);

    console.log('Database seeded successfully!');
  } catch (error) {
    console.error('Seed error:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

seedDB();
