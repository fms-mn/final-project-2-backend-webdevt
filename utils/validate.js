const { HttpError } = require('./http');

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MANILA_OFFSET = '+08:00'; // the cinema's timezone; the Philippines has no daylight saving

const isObjectId = (value) => typeof value === 'string' && OBJECT_ID.test(value);

// A malformed id in the URL can never match a record.
function requireId(value, label) {
  if (!isObjectId(value)) throw new HttpError(404, `${label} not found`);
  return value;
}

// Local calendar day (Asia/Manila) as a [start, end) range of instants, or null when invalid.
function dayRange(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return null;
  const start = new Date(`${value}T00:00:00${MANILA_OFFSET}`);
  if (Number.isNaN(start.getTime())) return null;
  // Rejects dates such as 2026-02-31 that Date would silently roll over.
  if (start.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) !== value) return null;
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function badRequest(errors, message = 'Validation failed') {
  return new HttpError(400, message, { errors });
}

// Collects field problems and throws one 400 with all of them.
function collectErrors(check) {
  const errors = {};
  const result = check((field, message) => { errors[field] = message; });
  if (Object.keys(errors).length) throw badRequest(errors);
  return result;
}

module.exports = { isObjectId, requireId, dayRange, badRequest, collectErrors };
