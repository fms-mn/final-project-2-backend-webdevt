const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Booking = require('../models/Booking');
const Showtime = require('../models/Showtime');
const AuthToken = require('../models/AuthToken');
const notifications = require('../services/mail/notifications');
const { auth, adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');

const router = express.Router();

// Read own profile. Also returns the CSRF token so the app can restore a session after a reload.
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user, csrfToken: req.csrfToken });
});

// Update own name and/or phone. Anything else in the body (role, email, isActive...) is ignored.
router.patch('/me', auth, wrap(async (req, res) => {
  const { name, phone } = req.body || {};
  let changed = false;

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new HttpError(400, 'Name must be non-empty text');
    }
    req.user.name = name;
    changed = true;
  }
  if (phone !== undefined) {
    if (phone !== null && typeof phone !== 'string') {
      throw new HttpError(400, 'Phone must be text');
    }
    // null or blank clears it
    req.user.phone = phone && phone.trim() ? phone : undefined;
    changed = true;
  }
  if (!changed) throw new HttpError(400, 'Send a name and/or phone to update');

  await req.user.save();
  res.json({ user: req.user });
}));

// List accounts (admin). Never includes password hashes.
router.get('/', adminAuth, wrap(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const [users, total] = await Promise.all([
    User.find().select('-passwordHash').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    User.countDocuments(),
  ]);
  res.json({ users, total, page, limit });
}));

// Activate or deactivate a regular user (admin). Administrators cannot be changed here.
router.patch('/:id/status', adminAuth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'User not found');
  const { isActive } = req.body || {};
  if (typeof isActive !== 'boolean') throw new HttpError(400, 'isActive must be true or false');

  const target = await User.findById(req.params.id).select('-passwordHash');
  if (!target) throw new HttpError(404, 'User not found');
  if (target.role !== 'user') {
    throw new HttpError(403, 'Only regular user accounts can be activated or deactivated');
  }

  target.isActive = isActive;
  await target.save();
  res.json({ user: target });
}));

// Permanently remove a regular user account (admin), then email the owner to say so. Administrators
// cannot be removed. An account with tickets still to be used (or seats being held) is refused, so a
// customer is never left without the seats they paid for: cancel those bookings first, or disable
// the account instead. Past bookings and payments stay in the cinema's records.
router.delete('/:id', adminAuth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'User not found');
  const target = await User.findById(req.params.id).select('-passwordHash');
  if (!target) throw new HttpError(404, 'User not found');
  if (target.role !== 'user') throw new HttpError(403, 'Only regular user accounts can be removed');

  const now = new Date();
  const open = (await Booking.find({ user: target._id, status: { $in: ['pending', 'confirmed'] } }).select('showtime status holdExpiresAt'))
    .filter((booking) => booking.status === 'confirmed' || !booking.holdExpiresAt || new Date(booking.holdExpiresAt) > now);
  const upcoming = open.length
    ? await Showtime.countDocuments({ _id: { $in: open.map((booking) => booking.showtime) }, startTime: { $gt: now } })
    : 0;
  if (upcoming > 0) {
    throw new HttpError(409, `${target.name} still has ${upcoming} upcoming booking${upcoming === 1 ? '' : 's'}. Cancel ${upcoming === 1 ? 'it' : 'them'} first, or disable the account instead.`);
  }

  const { name, email } = target;
  await AuthToken.deleteMany({ user: target._id });
  await User.deleteOne({ _id: target._id });
  notifications.accountRemoved({ name, email });
  res.json({ removed: true, id: String(target._id) });
}));

module.exports = router;
