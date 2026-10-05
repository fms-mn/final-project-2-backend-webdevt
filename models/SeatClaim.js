const mongoose = require('mongoose');

// One document per seat held by a confirmed booking. Internal only: customers never edit these.
const seatClaimSchema = new mongoose.Schema(
  {
    showtime: { type: mongoose.Schema.Types.ObjectId, ref: 'Showtime', required: true },
    seatLabel: { type: String, required: true, trim: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
  },
  { timestamps: true },
);

// This unique index is what makes double-booking impossible: a second claim for the same
// seat at the same showtime fails with a duplicate key error and the transaction rolls back.
seatClaimSchema.index({ showtime: 1, seatLabel: 1 }, { unique: true });
seatClaimSchema.index({ booking: 1 });

module.exports = mongoose.model('SeatClaim', seatClaimSchema);
