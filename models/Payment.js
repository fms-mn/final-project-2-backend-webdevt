const crypto = require('crypto');
const mongoose = require('mongoose');
const { integer } = require('./validators');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(prefix) {
  let value = '';
  for (let i = 0; i < 8; i += 1) value += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${prefix}-${value}`;
}

// One payment attempt for one booking. The gateway is simulated (services/payments.js), but the
// record is shaped like a real one. A full card number and the security code are NEVER stored:
// only the brand and the last four digits.
const paymentSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Integer centavos, copied from the booking total.
    amount: { type: Number, required: true, min: [0, 'amount cannot be negative'], validate: integer },
    currency: { type: String, default: 'PHP' },
    method: { type: String, required: true, enum: ['card', 'gcash', 'maya'] },
    // awaiting_approval: a wallet payment waiting for the customer to approve it in the wallet.
    status: {
      type: String,
      enum: ['awaiting_approval', 'paid', 'failed', 'refunded'],
      default: 'awaiting_approval',
    },
    reference: { type: String, required: true, unique: true },
    cardBrand: { type: String },
    cardLast4: { type: String },
    walletLast4: { type: String },
    failureCode: { type: String },
    failureMessage: { type: String },
    paidAt: { type: Date },
    refundedAt: { type: Date },
    refundReference: { type: String },
  },
  { timestamps: true },
);

paymentSchema.index({ booking: 1, createdAt: -1 });
paymentSchema.statics.generateReference = () => code('PAY');
paymentSchema.statics.generateRefundReference = () => code('RF');

module.exports = mongoose.model('Payment', paymentSchema);
