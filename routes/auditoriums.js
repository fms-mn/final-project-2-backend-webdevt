const express = require('express');
const Auditorium = require('../models/Auditorium');
const Showtime = require('../models/Showtime');
const { adminAuth } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils/http');
const { requireId, badRequest } = require('../utils/validate');
const scheduling = require('../services/scheduling');

const router = express.Router();

// Admin only. seatLabels are never accepted from the client: the model generates them.
const EDITABLE_FIELDS = ['name', 'rows', 'seatsPerRow', 'isActive'];
const pickEditable = (body = {}) => Object.fromEntries(
  EDITABLE_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]),
);

const hasFutureShowtime = (auditoriumId) => Showtime.exists({
  auditorium: auditoriumId, status: 'scheduled', startTime: { $gt: new Date() },
});

router.get('/', adminAuth, wrap(async (req, res) => {
  res.json(await Auditorium.find().sort({ name: 1 }));
}));

router.get('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Auditorium');
  const auditorium = await Auditorium.findById(req.params.id);
  if (!auditorium) throw new HttpError(404, 'Auditorium not found');
  res.json(auditorium);
}));

router.post('/', adminAuth, wrap(async (req, res) => {
  const auditorium = new Auditorium(pickEditable(req.body));
  await auditorium.save();
  res.status(201).json(auditorium);
}));

router.patch('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Auditorium');
  const changes = pickEditable(req.body);
  if (Object.keys(changes).length === 0) {
    throw badRequest({ body: `Send at least one of: ${EDITABLE_FIELDS.join(', ')}` });
  }
  if (changes.isActive !== undefined && typeof changes.isActive !== 'boolean') {
    throw badRequest({ isActive: 'isActive must be true or false' });
  }

  const auditorium = await Auditorium.findById(req.params.id);
  if (!auditorium) throw new HttpError(404, 'Auditorium not found');

  // The seat layout is part of every showtime and booking made in this auditorium.
  const layoutChanges = ['rows', 'seatsPerRow'].some(
    (field) => changes[field] !== undefined && Number(changes[field]) !== auditorium[field],
  );
  if (layoutChanges && await Showtime.exists({ auditorium: auditorium._id })) {
    throw new HttpError(409, 'The seat layout is locked because showtimes use this auditorium. You can still rename it.');
  }
  if (changes.isActive === false && auditorium.isActive && await hasFutureShowtime(auditorium._id)) {
    throw new HttpError(409, 'This auditorium has upcoming showtimes. Cancel or move them first.');
  }

  auditorium.set(changes); // save() validates and regenerates seatLabels when the layout changed
  await auditorium.save();
  res.json(auditorium);
}));

router.get('/:id/blocked-seats', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Auditorium');
  res.json(await scheduling.getRoomBlockedSeats(req.params.id));
}));

// Replace the seats that cannot be booked in any showing here: { "seats": ["A1", "A2"] }.
router.put('/:id/blocked-seats', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Auditorium');
  res.json(await scheduling.setRoomBlockedSeats(req.params.id, req.body));
}));

router.delete('/:id', adminAuth, wrap(async (req, res) => {
  requireId(req.params.id, 'Auditorium');
  const auditorium = await Auditorium.findById(req.params.id);
  if (!auditorium) throw new HttpError(404, 'Auditorium not found');
  if (await Showtime.exists({ auditorium: auditorium._id })) {
    throw new HttpError(409, 'Showtimes use this auditorium, so it cannot be deleted. Deactivate it instead.');
  }
  await Auditorium.deleteOne({ _id: auditorium._id });
  res.json({ message: 'Auditorium deleted' });
}));

module.exports = router;
