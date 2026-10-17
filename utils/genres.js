const DEFAULT_GENRES = [
  'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance',
  'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western',
];

function normalizeGenres(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Use a list of at most 100 genres.');
  const genres = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (genres.some(item => !item || item.length > 40 || /[,/;|\r\n]/.test(item))) {
    throw new Error('Each genre must be 1–40 characters without commas, slashes, semicolons, pipes or line breaks.');
  }
  if (new Set(genres.map(item => item.toLowerCase())).size !== genres.length) throw new Error('Genre names must be unique.');
  return genres;
}

module.exports = { DEFAULT_GENRES, normalizeGenres };
