const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { wrap } = require('../utils/http');
const { getSettings, updateSettings } = require('../services/settings');

const router = express.Router();

// The cinema's scheduling rules: turnaroundMinutes (gap between shows) and salesCutoffMinutes
// (online booking closes this long before a showing starts).
router.get('/', adminAuth, wrap(async (req, res) => {
  res.json(await getSettings());
}));

router.patch('/', adminAuth, wrap(async (req, res) => {
  res.json(await updateSettings(req.body));
}));

module.exports = router;
