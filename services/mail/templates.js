const { esc, link, shell, hero, movieCard, ticketStub, rows, notice, button, paragraph, section, C } = require('./layout');

// The words and layout of each email. Every function takes plain data and returns
// { subject, html, text, tags }: no database, no sending, so they can be previewed and tested alone.
//
// `t` is a ticket (see notifications.js, ticketOf): { code, movieTitle, posterUrl, rating, genre,
// durationLabel, dateShort, dateLong, time, room, seats, quantity, unitPrice, total, method,
// paymentReference, refundReference, simulated, ... } with money already formatted as text.

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const text = (lines) => lines.filter((line) => line !== null && line !== undefined && line !== false).join('\n');
const strongHtml = (value) => `<strong style="color:${C.ink};" class="t-ink">${esc(value)}</strong>`;
const MY_TICKETS = '/my-bookings';

const testNotice = (t) => (t.simulated
  ? notice({ tone: 'info', title: 'This is a test booking', text: 'No real money was charged, and it is not valid for admission to a cinema.' })
  : '');

const ticketText = (t) => [
  `${t.movieTitle}`,
  `${t.dateLong} at ${t.time}`,
  `${t.room} · ${t.seats.length === 1 ? 'Seat' : 'Seats'} ${t.seats.join(', ')}`,
  `Booking code: ${t.code}`,
];

// ---- 1. welcome -----------------------------------------------------------------------------
function welcome({ name }) {
  const step = (number, title, copy) => `<tr>
    <td width="44" valign="top" style="padding:0 0 16px;"><div style="width:32px;height:32px;line-height:32px;text-align:center;border-radius:16px;background:${C.crimson};color:#ffffff;font:800 15px 'Helvetica Neue',Helvetica,Arial,sans-serif;">${number}</div></td>
    <td valign="top" style="padding:0 0 16px;"><div class="t-ink" style="font:700 16px 'Helvetica Neue',Helvetica,Arial,sans-serif;color:${C.ink};">${esc(title)}</div><div class="t-muted" style="margin-top:2px;font:400 14px/1.5 'Helvetica Neue',Helvetica,Arial,sans-serif;color:${C.muted};">${esc(copy)}</div></td></tr>`;
  const html = shell({
    preheader: 'Your account is ready. Here is how booking works.',
    rowsHtml: hero({ chip: 'Welcome', tone: 'brand', title: `Welcome to filme, ${firstName(name)}!`, lead: 'Your account is ready. Booking a movie takes about a minute.' })
      + section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
          ${step(1, 'Pick a movie and a showing', 'Browse what is on and choose the day and time that suits you.')}
          ${step(2, 'Choose your seats', 'See the room, pick the seats you like. We hold them while you pay.')}
          ${step(3, 'Pay and get your ticket', 'Your booking code arrives by email and stays in My Tickets.')}
        </table>`, { pad: '16px 32px 0' })
      + button(link('/movies'), 'Browse movies'),
  });
  return {
    subject: `Welcome to filme, ${firstName(name)}`, html, tags: ['welcome'],
    text: text([`Welcome to filme, ${firstName(name)}!`, '', 'Your account is ready. Booking a movie takes about a minute:', '1. Pick a movie and a showing', '2. Choose your seats (we hold them while you pay)', '3. Pay and get your ticket by email', '', link('/movies') && `Browse movies: ${link('/movies')}`]),
  };
}

// ---- 2. booking confirmed + receipt ---------------------------------------------------------
function bookingConfirmed(t, { name }) {
  const html = shell({
    preheader: `${t.movieTitle}, ${t.dateShort} at ${t.time}. Booking code ${t.code}.`,
    rowsHtml: hero({
      chip: 'Booking confirmed', tone: 'ok', title: `You're all set, ${firstName(name)}!`,
      lead: `Your seats for ${strongHtml(t.movieTitle)} are booked. Show the booking code below at the cinema. A screenshot of this email is enough.`,
    })
      + movieCard(t)
      + ticketStub(t)
      + rows([
        ['Tickets', `${t.quantity} × ${esc(t.unitPriceText)}`],
        t.method ? ['Paid with', esc(t.method)] : null,
        t.paymentReference ? ['Payment reference', `<span style="font-family:monospace;">${esc(t.paymentReference)}</span>`] : null,
        ['Total paid', esc(t.totalText), true],
      ], { title: 'Receipt' })
      + testNotice(t)
      + notice({ tone: 'warn', title: 'Good to know', text: 'Please arrive about 15 minutes early. Plans changed? You can cancel for a full refund from My Tickets until the showing starts.' })
      + button(link(MY_TICKETS), 'View my tickets'),
  });
  return {
    subject: `Your tickets for ${t.movieTitle} are confirmed`, html, tags: ['booking-confirmed'],
    text: text([`You're all set, ${firstName(name)}!`, '', `Your seats are booked.`, '', ...ticketText(t), '', `Tickets: ${t.quantity} x ${t.unitPriceText}`, t.method && `Paid with: ${t.method}`, t.paymentReference && `Payment reference: ${t.paymentReference}`, `Total paid: ${t.totalText}`, '', t.simulated && 'This is a test booking. No real money was charged, and it is not valid for admission to a cinema.', 'Please arrive about 15 minutes early. You can cancel for a full refund from My Tickets until the showing starts.', link(MY_TICKETS) && `My tickets: ${link(MY_TICKETS)}`]),
  };
}

// ---- 3. booking cancelled (by the customer, or by an admin) -----------------------------------
function bookingCancelled(t, { name, byCinema, refunded }) {
  const title = byCinema ? 'The cinema cancelled your booking' : 'Your booking was cancelled';
  const lead = byCinema
    ? `We are sorry: the cinema cancelled your booking for ${strongHtml(t.movieTitle)}. ${refunded ? 'Your payment has been refunded in full.' : 'Nothing was charged.'}`
    : `As you asked, we cancelled your booking for ${strongHtml(t.movieTitle)}. The seats are free again. ${refunded ? 'Your payment has been refunded in full.' : 'Nothing was charged.'}`;
  const html = shell({
    preheader: refunded ? `Refund of ${t.totalText} for ${t.movieTitle}.` : `Booking ${t.code} was cancelled.`,
    rowsHtml: hero({ chip: 'Booking cancelled', tone: 'down', title, lead })
      + ticketStub(t, { struck: true })
      + (refunded ? rows([
        ['Refund amount', esc(t.totalText), true],
        t.method ? ['Refunded to', esc(t.method)] : null,
        t.refundReference ? ['Refund reference', `<span style="font-family:monospace;">${esc(t.refundReference)}</span>`] : null,
      ], { title: 'Refund' }) : '')
      + (refunded && t.simulated ? notice({ tone: 'info', title: 'Test refund', text: 'This was a test booking, so no real money moved.' }) : '')
      + button(link('/movies'), 'Browse movies'),
  });
  return {
    subject: `Your booking for ${t.movieTitle} was cancelled`, html, tags: ['booking-cancelled'],
    text: text([title, '', ...ticketText(t), '', refunded ? `Refund: ${t.totalText}${t.refundReference ? ` (reference ${t.refundReference})` : ''}` : 'Nothing was charged.', '', link('/movies') && `Browse movies: ${link('/movies')}`]),
  };
}

// ---- 4. the cinema cancelled the showing ------------------------------------------------------
function showingCancelled(t, { name, refunded }) {
  const html = shell({
    preheader: `${t.movieTitle} on ${t.dateShort} was cancelled${refunded ? `. We refunded ${t.totalText}.` : '.'}`,
    rowsHtml: hero({
      chip: 'Showing cancelled', tone: 'down', title: 'We had to cancel this showing',
      lead: `Hi ${esc(firstName(name))}, we are very sorry. The ${esc(t.time)} showing of ${strongHtml(t.movieTitle)} on ${esc(t.dateShort)} will not go ahead. ${refunded ? 'Your payment has been refunded in full, and you do not need to do anything.' : 'You were not charged.'}`,
    })
      + ticketStub(t, { struck: true })
      + (refunded ? rows([
        ['Refund amount', esc(t.totalText), true],
        t.method ? ['Refunded to', esc(t.method)] : null,
        t.refundReference ? ['Refund reference', `<span style="font-family:monospace;">${esc(t.refundReference)}</span>`] : null,
      ], { title: 'Refund' }) : '')
      + (refunded && t.simulated ? notice({ tone: 'info', title: 'Test refund', text: 'This was a test booking, so no real money moved.' }) : '')
      + paragraph('Still want to see it? Another showing may be available.')
      + button(link(t.movieId ? `/movie/${t.movieId}` : '/movies'), 'Find another showing'),
  });
  return {
    subject: `Cancelled: ${t.movieTitle} on ${t.dateShort}`, html, tags: ['showing-cancelled'],
    text: text([`We had to cancel this showing`, '', `We are very sorry. The showing below will not go ahead.`, '', ...ticketText(t), '', refunded ? `Your payment of ${t.totalText} was refunded in full${t.refundReference ? ` (reference ${t.refundReference})` : ''}.` : 'You were not charged.', '', link('/movies') && `Find another showing: ${link(t.movieId ? `/movie/${t.movieId}` : '/movies')}`]),
  };
}

// ---- 5. the cinema moved the showing ----------------------------------------------------------
function showingMoved(t, { name, before }) {
  const column = (heading, data, tone) => `<td width="48%" valign="top" class="soft" style="background:${tone === 'old' ? C.soft : C.okBg};border-radius:12px;padding:14px 16px;">
      <div style="font:700 11px 'Helvetica Neue',Helvetica,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${tone === 'old' ? C.muted : C.okInk};">${esc(heading)}</div>
      <div style="margin-top:6px;font:700 16px/1.35 'Helvetica Neue',Helvetica,Arial,sans-serif;color:${tone === 'old' ? C.muted : C.okInk};${tone === 'old' ? 'text-decoration:line-through;' : ''}">${esc(data.dateShort)}<br>${esc(data.time)}</div>
      <div style="margin-top:4px;font:400 13px 'Helvetica Neue',Helvetica,Arial,sans-serif;color:${tone === 'old' ? C.muted : C.okInk};">${esc(data.room)}</div>
    </td>`;
  const html = shell({
    preheader: `${t.movieTitle} is now on ${t.dateShort} at ${t.time}, ${t.room}.`,
    rowsHtml: hero({
      chip: 'Schedule change', tone: 'warn', title: 'Your showing has moved',
      lead: `Hi ${esc(firstName(name))}, the cinema changed the time or room of ${strongHtml(t.movieTitle)}. Your seats and booking code stay the same, so you do not need to do anything.`,
    })
      + section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${column('Was', before, 'old')}<td width="4%" align="center" class="t-muted" style="font:700 20px 'Helvetica Neue',Helvetica,Arial,sans-serif;color:${C.muted};">&rarr;</td>${column('Now', t, 'new')}</tr></table>`)
      + ticketStub(t)
      + notice({ tone: 'warn', title: 'Does the new time not work for you?', text: 'You can cancel for a full refund from My Tickets until the showing starts.' })
      + button(link(MY_TICKETS), 'View my tickets'),
  });
  return {
    subject: `Schedule change: ${t.movieTitle} is now on ${t.dateShort}, ${t.time}`, html, tags: ['showing-moved'],
    text: text(['Your showing has moved', '', `Was: ${before.dateShort} at ${before.time}, ${before.room}`, `Now: ${t.dateShort} at ${t.time}, ${t.room}`, '', 'Your seats and booking code stay the same.', '', ...ticketText(t), '', 'Cannot make the new time? You can cancel for a full refund from My Tickets until the showing starts.', link(MY_TICKETS) && `My tickets: ${link(MY_TICKETS)}`]),
  };
}

// ---- 6. reminder ------------------------------------------------------------------------------
function reminder(t, { name, when }) {
  const html = shell({
    preheader: `${t.movieTitle} starts ${when}. Booking code ${t.code}.`,
    rowsHtml: hero({
      chip: 'Starting soon', tone: 'info', title: `${t.movieTitle} starts ${when}`,
      lead: `Hi ${esc(firstName(name))}, a quick reminder about your showing. Have your booking code ready at the cinema.`,
    })
      + ticketStub(t)
      + notice({ tone: 'warn', title: 'Before you go', text: 'Arrive about 15 minutes early to find your seats and grab snacks.' })
      + testNotice(t)
      + button(link(MY_TICKETS), 'View my ticket'),
  });
  return {
    subject: `Reminder: ${t.movieTitle} starts ${when}`, html, tags: ['reminder'],
    text: text([`${t.movieTitle} starts ${when}`, '', ...ticketText(t), '', 'Arrive about 15 minutes early.', link(MY_TICKETS) && `My tickets: ${link(MY_TICKETS)}`]),
  };
}

// ---- 7. a test, from the admin page -----------------------------------------------------------
function testEmail({ to, providerLabel, at }) {
  const html = shell({
    preheader: 'If you can read this, emails from filme are working.',
    rowsHtml: hero({ chip: 'Test email', tone: 'info', title: 'Emails are working', lead: 'This message was sent from the Settings page of your filme admin. If you are reading it, customers will receive their booking emails too.' })
      + rows([['Sent to', esc(to)], ['Sent through', esc(providerLabel)], ['Sent at', esc(at)]], { title: 'Details' }),
  });
  return { subject: 'filme test email', html, tags: ['test'], text: text(['Emails are working', '', `Sent to: ${to}`, `Sent through: ${providerLabel}`, `Sent at: ${at}`]) };
}

module.exports = { welcome, bookingConfirmed, bookingCancelled, showingCancelled, showingMoved, reminder, testEmail };
