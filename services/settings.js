const Setting = require('../models/Setting');
const { collectErrors } = require('../utils/validate');
const { DEFAULT_GENRES, normalizeGenres } = require('../utils/genres');

const KEY = 'cinema';
const DEFAULTS = { turnaroundMinutes: 15, salesCutoffMinutes: 15, autoArchiveDays: 30, genres: DEFAULT_GENRES };
const FIELDS = Object.keys(DEFAULTS);
const LIMITS = { turnaroundMinutes: 240, salesCutoffMinutes: 1440, autoArchiveDays: 3650 };
const UNITS = { turnaroundMinutes: 'minutes', salesCutoffMinutes: 'minutes', autoArchiveDays: 'days' };

// A rule saved before it existed has no value; it falls back to the default.
const pick = (doc) => Object.fromEntries(FIELDS.map((field) => [field, doc && doc[field] !== undefined && doc[field] !== null ? doc[field] : DEFAULTS[field]]));

// The rules in force: what the admin saved, or the defaults when nothing was saved yet.
async function getSettings(session) {
  const query = Setting.findOne({ key: KEY });
  const doc = await (session ? query.session(session) : query);
  return pick(doc);
}

async function updateSettings(body = {}) {
  const changes = collectErrors((fail) => {
    const found = {};
    for (const field of FIELDS) {
      if (body[field] === undefined) continue;
      const value = body[field];
      if (field === 'genres') {
        try { found.genres = normalizeGenres(value); }
        catch (err) { fail('genres', err.message); }
        continue;
      }
      if (!Number.isInteger(value) || value < 0 || value > LIMITS[field]) {
        fail(field, `${field} must be a whole number of ${UNITS[field]} from 0 to ${LIMITS[field]}`);
      } else {
        found[field] = value;
      }
    }
    if (Object.keys(found).length === 0 && Object.keys(body).every((key) => !FIELDS.includes(key))) {
      fail('body', `Send at least one of: ${FIELDS.join(', ')}`);
    }
    return found;
  });
  const doc = await Setting.findOne({ key: KEY }) || new Setting({ key: KEY, ...DEFAULTS });
  doc.set(changes);
  await doc.save();
  return pick(doc);
}

module.exports = { getSettings, updateSettings, DEFAULTS };
