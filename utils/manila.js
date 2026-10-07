// The cinema runs on Philippine time (UTC+8, no daylight saving).
const ZONE = 'Asia/Manila';
const OFFSET = '+08:00';
const DAY_MS = 24 * 60 * 60 * 1000;

const manilaDay = (value) => new Date(value).toLocaleDateString('en-CA', { timeZone: ZONE });

const manilaClock = (value) => new Date(value).toLocaleTimeString('en-GB', {
  timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// "Thu 8 Oct, 16:00": how a slot is named in messages.
const manilaLabel = (value) => `${new Date(value).toLocaleDateString('en-GB', {
  timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short',
})}, ${manilaClock(value)}`;

// The instant of a Manila wall-clock time: ('2026-10-08', '16:00').
const atManila = (day, clock) => new Date(`${day}T${clock}:00${OFFSET}`);

// 0 (Sunday) to 6 (Saturday), the weekday it is in Manila on that date.
const weekdayOf = (day) => new Date(`${day}T12:00:00${OFFSET}`).getUTCDay();

// 'YYYY-MM-DD' days from `from` to `to`, both included.
function daysBetween(from, to) {
  const days = [];
  for (let at = atManila(from, '12:00').getTime(); at <= atManila(to, '12:00').getTime(); at += DAY_MS) {
    days.push(manilaDay(new Date(at)));
  }
  return days;
}

module.exports = { manilaDay, manilaClock, manilaLabel, atManila, weekdayOf, daysBetween };
