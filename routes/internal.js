const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { HttpError, wrap } = require('../utils/http');
const { sweepReminders } = require('../services/mail/reminders');

const router = express.Router();

// Compares digests, so the check takes the same time wherever the first difference is.
function matches(given, expected) {
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

// For a scheduler (cron-job.org, GitHub Actions...) rather than a person: send the reminder emails
// that are due now. A free host sleeps when nobody visits, which also stops the in-process timer in
// index.js; this call wakes the server and runs the same sweep. It is safe to call as often as you
// like, because every reminder is marked once sent. Without CRON_SECRET it does not exist (404).
router.post('/sweep-reminders', wrap(async (req, res) => {
  const secret = config.cronSecret;
  if (!secret) throw new HttpError(404, 'Not found');
  const match = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!match || !matches(match[1], secret)) throw new HttpError(401, 'Invalid or missing token');
  res.set('Cache-Control', 'no-store');
  res.json(await sweepReminders());
}));

module.exports = router;
