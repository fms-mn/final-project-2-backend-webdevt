const express = require('express');
const { auth } = require('../middleware/auth');

const router = express.Router();

// The booking engine is being rebuilt around showtimes, seat claims and transactions
// (Trello list "4 · Booking Engine"). The earlier movie/date/time implementation cannot
// work with the new Booking model, so every booking route answers 501 until then.
// Authentication still runs first, so logged-out requests keep getting 401.
router.use(auth, (req, res) => {
  res.status(501).json({
    message: 'Bookings are being rebuilt around showtimes and are not available yet',
  });
});

module.exports = router;
