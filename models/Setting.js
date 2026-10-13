const mongoose = require('mongoose');
const { integer } = require('./validators');

// Cinema-wide rules the admin can change. One document, keyed 'cinema'. A cinema that has never
// saved its settings uses the defaults in services/settings.js.
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    // Minutes an auditorium needs between the end of one show and the start of the next
    // (cleaning, ads, getting people in and out). Checked whenever a showing is scheduled.
    turnaroundMinutes: {
      type: Number, required: true, min: [0, 'turnaroundMinutes cannot be negative'], max: [240, 'turnaroundMinutes is at most 240'], validate: integer,
    },
    // Online booking closes this many minutes before a showing starts.
    salesCutoffMinutes: {
      type: Number, required: true, min: [0, 'salesCutoffMinutes cannot be negative'], max: [1440, 'salesCutoffMinutes is at most 1440'], validate: integer,
    },
    // A published movie that has been released but has had no showings for this many days is
    // archived by itself (see services/movieArchive.js). 0 switches this off.
    autoArchiveDays: {
      type: Number, min: [0, 'autoArchiveDays cannot be negative'], max: [3650, 'autoArchiveDays is at most 3650'], validate: integer,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Setting', settingSchema);
