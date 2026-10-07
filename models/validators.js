// Small validators shared by the Mongoose schemas.

// Money is stored as integer centavos, so 400.00 pesos is 40000.
const integer = {
  validator: Number.isInteger,
  message: '{PATH} must be an integer',
};

// Mongoose's `required` accepts an empty array, so array fields need an explicit check.
const nonEmptyArray = {
  validator: (value) => Array.isArray(value) && value.length > 0,
  message: '{PATH} must contain at least one item',
};

const uniqueItems = {
  validator: (value) => new Set(value).size === value.length,
  message: '{PATH} must not contain duplicates',
};

const nonEmptyStrings = {
  validator: (value) => value.every((item) => typeof item === 'string' && item.trim().length > 0),
  message: '{PATH} must only contain non-empty text',
};

// Returns the 11-character video id of a YouTube link, or null when the text is not one.
// Only https links on YouTube's own hosts count, so a trailer can never point somewhere else.
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(link) {
  if (typeof link !== 'string') return null;
  let url;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname)) return null;

  let id = null;
  if (url.hostname === 'youtu.be') {
    [, id] = url.pathname.split('/');
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    const [, kind, videoId] = url.pathname.split('/');
    if (kind === 'embed' || kind === 'shorts') id = videoId;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

const youtubeLink = {
  validator: (value) => value === undefined || value === null || youtubeId(value) !== null,
  message: '{PATH} must be a YouTube link such as https://www.youtube.com/watch?v=...',
};

module.exports = { integer, nonEmptyArray, uniqueItems, nonEmptyStrings, youtubeId, youtubeLink };
