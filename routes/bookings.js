const express = require('express');
const Booking = require('../models/Booking');
const Movie = require('../models/Movie');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Create booking (authenticated)
router.post('/', auth, async (req, res) => {
  try {
    const { movieId, seats, showDate, showTime } = req.body;

    const movie = await Movie.findById(movieId);
    if (!movie) {
      return res.status(404).json({ message: 'Movie not found' });
    }

    // Check if seats are already booked for this show
    const existingBookings = await Booking.find({
      movie: movieId,
      showDate: new Date(showDate),
      showTime,
      status: { $ne: 'cancelled' },
    });

    const bookedSeats = existingBookings.flatMap((b) => b.seats);
    const conflictSeats = seats.filter((s) => bookedSeats.includes(s));

    if (conflictSeats.length > 0) {
      return res.status(400).json({
        message: `Seats already booked: ${conflictSeats.join(', ')}`,
      });
    }

    const totalPrice = seats.length * movie.price;

    const booking = new Booking({
      user: req.user._id,
      movie: movieId,
      seats,
      showDate: new Date(showDate),
      showTime,
      totalPrice,
    });

    await booking.save();
    await booking.populate('movie', 'title posterUrl');

    res.status(201).json(booking);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get user's bookings (authenticated)
router.get('/my', auth, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user._id })
      .populate('movie', 'title posterUrl duration genre')
      .sort({ createdAt: -1 });

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get booked seats for a specific show (public)
router.get('/seats/:movieId', async (req, res) => {
  try {
    const { showDate, showTime } = req.query;

    const bookings = await Booking.find({
      movie: req.params.movieId,
      showDate: new Date(showDate),
      showTime,
      status: { $ne: 'cancelled' },
    });

    const bookedSeats = bookings.flatMap((b) => b.seats);
    res.json({ bookedSeats });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Cancel booking (authenticated)
router.patch('/:id/cancel', auth, async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ message: 'Booking already cancelled' });
    }

    booking.status = 'cancelled';
    await booking.save();

    res.json({ message: 'Booking cancelled', booking });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
