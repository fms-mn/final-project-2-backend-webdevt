const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { wrap } = require('../utils/http');
const { getSettings, updateSettings } = require('../services/settings');
const mail = require('../services/mail');
const notifications = require('../services/mail/notifications');

const router = express.Router();

// The cinema's scheduling rules: turnaroundMinutes (gap between shows) and salesCutoffMinutes
// (online booking closes this long before a showing starts).
router.get('/', adminAuth, wrap(async (req, res) => {
  res.json(await getSettings());
}));

router.patch('/', adminAuth, wrap(async (req, res) => {
  res.json(await updateSettings(req.body));
}));

// Email: is a provider connected, and a test message to the signed-in admin's own address.
router.get('/mail', adminAuth, wrap(async (req, res) => {
  res.json(mail.status());
}));

router.post('/mail/test', adminAuth, wrap(async (req, res) => {
  const result = await notifications.sendTest(req.user.email);
  res.json({ ok: result.ok, simulated: result.simulated, label: result.label, to: req.user.email, error: result.ok ? '' : result.error });
}));

module.exports = router;
