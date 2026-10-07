const mongoose = require('mongoose');
const { integer } = require('./validators');

const showtimeSchema = new mongoose.Schema(
  {
    movie: { type: mongoose.Schema.Types.ObjectId, ref: 'Movie', required: true },
    auditorium: { type: mongoose.Schema.Types.ObjectId, ref: 'Auditorium', required: true },
    // Stored in UTC; the UI displays them in Asia/Manila.
    startTime: { type: Date, required: true },
    // Derived from the movie duration (see computeEndTime).
    endTime: { type: Date, required: true },
    // Integer centavos.
    ticketPrice: {
      type: Number,
      required: true,
      min: [0, 'ticketPrice cannot be negative'],
      validate: integer,
    },
    status: {
      type: String,
      enum: ['scheduled', 'cancelled'],
      default: 'scheduled',
    },
    // Bumped by every booking (see services/bookings.js). Writing the showtime inside the booking
    // transaction makes a booking conflict with a concurrent cancellation or edit of the same
    // showtime, so whichever runs second re-checks the state the first one left behind.
    bookingRevision: { type: Number, default: 0 },
    // Hidden showtimes are invisible to customers and cannot be booked. Showtimes saved before
    // this field existed have no value, which counts as published (see isHidden below).
    isPublished: { type: Boolean, default: true },
    // Seats blocked for this showing only (the auditorium can block seats for every showing).
    blockedSeats: { type: [String], default: [] },
    // Set when an admin moves the showing: when it was first planned and when it last moved.
    originalStartTime: { type: Date },
    rescheduledAt: { type: Date },
  },
  { timestamps: true },
);

showtimeSchema.pre('validate', function checkTimes(next) {
  if (this.startTime && this.endTime && this.endTime <= this.startTime) {
    this.invalidate('endTime', 'endTime must be after startTime');
  }
  next();
});

showtimeSchema.statics.computeEndTime = function computeEndTime(startTime, durationMinutes) {
  return new Date(new Date(startTime).getTime() + durationMinutes * 60 * 1000);
};

// Overlap checks and listings look up showtimes by auditorium/time, movie and status.
showtimeSchema.index({ auditorium: 1, startTime: 1 });
showtimeSchema.index({ movie: 1, startTime: 1 });
showtimeSchema.index({ status: 1, startTime: 1 });

module.exports = mongoose.model('Showtime', showtimeSchema);
