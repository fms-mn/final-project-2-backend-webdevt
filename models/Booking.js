const crypto = require('crypto');
const mongoose = require('mongoose');
const { integer, nonEmptyArray, uniqueItems, nonEmptyStrings } = require('./validators');

// No 0/O or 1/I so a code is easy to read out at the cinema.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Random, not sequential: FLM-7K3QX9PD. Uniqueness is still enforced by the unique index.
function generateBookingCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `FLM-${code}`;
}

const bookingSchema = new mongoose.Schema(
  {
    bookingCode: { type: String, required: true, unique: true, trim: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    showtime: { type: mongoose.Schema.Types.ObjectId, ref: 'Showtime', required: true },
    seats: {
      type: [String],
      required: true,
      validate: [nonEmptyArray, uniqueItems, nonEmptyStrings],
    },
    // Integer centavos. unitPrice is a snapshot of the showtime price at booking time.
    unitPrice: {
      type: Number,
      required: true,
      min: [0, 'unitPrice cannot be negative'],
      validate: integer,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: [0, 'totalAmount cannot be negative'],
      validate: integer,
    },
    status: {
      type: String,
      enum: ['confirmed', 'cancelled'],
      default: 'confirmed',
    },
    bookedAt: { type: Date, required: true, default: Date.now },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The server calculates totals; refuse to store one that does not add up.
bookingSchema.pre('validate', function checkTotal(next) {
  if (Array.isArray(this.seats) && Number.isInteger(this.unitPrice)
    && Number.isInteger(this.totalAmount)
    && this.totalAmount !== this.unitPrice * this.seats.length) {
    this.invalidate('totalAmount', 'totalAmount must equal unitPrice x number of seats');
  }
  next();
});

bookingSchema.statics.generateCode = generateBookingCode;

bookingSchema.index({ user: 1, bookedAt: -1 });
bookingSchema.index({ showtime: 1, status: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
