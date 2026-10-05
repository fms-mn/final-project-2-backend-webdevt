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
