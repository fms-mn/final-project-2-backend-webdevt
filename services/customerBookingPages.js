const Booking = require('../models/Booking');
const Showtime = require('../models/Showtime');
const Movie = require('../models/Movie');
const { badRequest } = require('../utils/validate');
const { describeBookings } = require('./bookings');

const literalPattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function customerBookingPage(userId, query, { limit, page }) {
  const { scope, filter = 'all', order = 'newest', search = '' } = query;
  if (!['history', 'upcoming'].includes(scope)) throw badRequest({ scope: 'scope must be history or upcoming' });
  if (!['all', 'cancelled', 'past'].includes(filter)) throw badRequest({ filter: 'filter must be all, cancelled or past' });
  if (!['newest', 'oldest'].includes(order)) throw badRequest({ order: 'order must be newest or oldest' });
  if (typeof search !== 'string' || search.length > 200) throw badRequest({ search: 'search must be text of at most 200 characters' });
  const now = new Date();
  const classification = scope === 'upcoming'
    ? { status: 'confirmed', '_showtime.startTime': { $gt: now } }
    : { $or: [{ status: 'cancelled' }, { status: 'confirmed', '_showtime.startTime': { $lte: now } }] };
  const matching = {};
  if (scope === 'history') {
    if (filter === 'cancelled') matching.status = 'cancelled';
    if (filter === 'past') matching.status = 'confirmed';
    if (search.trim()) matching.$or = ['_movie.title', 'bookingCode'].map(field => ({ [field]: { $regex: literalPattern(search.trim()), $options: 'i' } }));
  }
  const match = { $match: matching };
  const [result] = await Booking.aggregate([
    { $match: { user: userId, status: { $in: ['confirmed', 'cancelled'] } } },
    { $lookup: { from: Showtime.collection.name, localField: 'showtime', foreignField: '_id', as: '_showtime' } },
    { $unwind: { path: '$_showtime', preserveNullAndEmptyArrays: true } },
    { $match: classification },
    { $lookup: { from: Movie.collection.name, localField: '_showtime.movie', foreignField: '_id', as: '_movie' } },
    { $unwind: { path: '$_movie', preserveNullAndEmptyArrays: true } },
    { $set: { _sortTime: { $ifNull: ['$_showtime.startTime', new Date(0)] } } },
    { $facet: {
      overall: [{ $count: 'total' }],
      matching: [match, { $count: 'total' }],
      records: [match, { $sort: { _sortTime: scope === 'upcoming' || order === 'oldest' ? 1 : -1, _id: 1 } },
        { $skip: (page - 1) * limit }, { $limit: limit }],
      ...(scope === 'history' ? { days: [match, { $group: {
        _id: { $dateToString: { date: '$_showtime.startTime', format: '%Y-%m-%d', timezone: 'Asia/Manila', onNull: 'unknown' } }, total: { $sum: 1 },
      } }] } : {}),
    } },
  ]);
  const total = result.matching[0]?.total || 0;
  const hasMore = page * limit < total;
  return {
    records: await describeBookings(result.records), total, overallTotal: result.overall[0]?.total || 0,
    page, limit, hasMore, nextPage: hasMore ? page + 1 : null,
    dayCounts: scope === 'history' ? Object.fromEntries(result.days.map(day => [day._id, day.total])) : {},
  };
}

module.exports = { customerBookingPage };
