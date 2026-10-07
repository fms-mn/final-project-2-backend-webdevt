const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { wrap } = require('../utils/http');
const { buildStats } = require('../services/stats');

const router = express.Router();

// Sales figures for the admin overview: ?from=2026-10-01&to=2026-10-07 (Asia/Manila days).
router.get('/', adminAuth, wrap(async (req, res) => {
  res.json(await buildStats(req.query));
}));

module.exports = router;
