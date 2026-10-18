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

// ---- 8. forgot password: the reset link -------------------------------------------------------
function passwordReset({ name, url, minutes }) {
  const html = shell({
    preheader: `Choose a new password. The link works for ${minutes} minutes.`,
    rowsHtml: hero({ chip: 'Password reset', tone: 'info', title: `Reset your password, ${firstName(name)}`, lead: `We got a request to reset the password for your filme account. The button below works for ${minutes} minutes and only once.` })
      + button(url, 'Choose a new password')
      + notice({ tone: 'warn', title: 'Did not ask for this?', text: 'Ignore this email. Your password stays the same and nobody can use this link without your inbox.' })
      + paragraph(`If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;">${esc(url)}</span>`),
  });
  return {
    subject: 'Reset your filme password', html, tags: ['password-reset'],
    text: text([`Reset your password, ${firstName(name)}`, '', `We got a request to reset the password for your filme account. This link works for ${minutes} minutes and only once:`, url, '', 'Did not ask for this? Ignore this email. Your password stays the same.']),
  };
}

// ---- 9. password changed: the security notice -------------------------------------------------
function passwordChanged({ name }) {
  const html = shell({
    preheader: 'Your filme password was just changed.',
    rowsHtml: hero({ chip: 'Password changed', tone: 'ok', title: 'Your password was changed', lead: `Hi ${firstName(name)}, the password for your filme account was just changed. You were signed out everywhere, so sign in again with the new one.` })
      + notice({ tone: 'down', title: 'Was this not you?', text: 'Reset your password again right away from the sign-in page, because someone else may have access to your email.' })
      + button(link('/login'), 'Sign in'),
  });
  return {
    subject: 'Your filme password was changed', html, tags: ['password-changed'],
    text: text([`Hi ${firstName(name)},`, '', 'The password for your filme account was just changed. You were signed out everywhere.', 'Was this not you? Reset your password again right away from the sign-in page.', link('/login') && `Sign in: ${link('/login')}`]),
  };
}

// ---- 10. sign-in code after a long time away --------------------------------------------------
function loginCode({ name, code, minutes }) {
  const html = shell({
    preheader: `Your filme sign-in code is ${code}.`,
    rowsHtml: hero({ chip: 'Sign-in code', tone: 'info', title: `Your code, ${firstName(name)}`, lead: `It has been a while since you last signed in, so we need to check it is you. Enter this code on the sign-in page. It works for ${minutes} minutes.` })
      + section(`<div style="margin:8px 0;padding:18px 12px;text-align:center;border:2px dashed ${C.line};border-radius:12px;background:${C.soft};"><span class="t-ink" style="font:800 34px/1 'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;letter-spacing:10px;color:${C.ink};">${esc(code)}</span></div>`, { pad: '8px 32px 0' })
      + notice({ tone: 'warn', title: 'Not you?', text: 'Do not share this code with anyone. If you did not try to sign in, change your password.' }),
  });
  return {
    subject: `Your filme sign-in code: ${code}`, html, tags: ['login-code'],
    text: text([`Your code, ${firstName(name)}`, '', `It has been a while since you last signed in. Enter this code on the sign-in page (valid for ${minutes} minutes):`, '', code, '', 'Do not share it. If you did not try to sign in, change your password.']),
  };
}

// ---- 11. account removed by an administrator ---------------------------------------------------
function accountRemoved({ name }) {
  const html = shell({
    preheader: 'Your filme account has been removed.',
    rowsHtml: hero({ chip: 'Account removed', tone: 'down', title: 'Your account was removed', lead: `Hi ${firstName(name)}, a filme administrator has removed your account. You can no longer sign in with this email, and you will not get any more emails from us about it.` })
      + notice({ tone: 'info', title: 'Think this is a mistake?', text: 'Contact the cinema and we will look into it. You are always welcome to create a new account.' })
      + button(link('/register'), 'Create a new account'),
  });
  return {
    subject: 'Your filme account was removed', html, tags: ['account-removed'],
    text: text([`Hi ${firstName(name)},`, '', 'A filme administrator has removed your account. You can no longer sign in with this email.', 'Think this is a mistake? Contact the cinema and we will look into it.', link('/register') && `Create a new account: ${link('/register')}`]),
  };
}

// ---- 12. a coming-soon movie is about to open: the reminder the customer asked for -------------
function comingSoonReminder(m, { name, when, advanceTickets }) {
  const openLine = `${m.movieTitle} opens ${when}`;
  const html = shell({
    preheader: `${openLine}. You asked us to remind you.`,
    rowsHtml: hero({
      chip: 'Opening soon', tone: 'info', title: openLine,
      lead: `Hi ${esc(firstName(name))}, you asked us to remind you before ${strongHtml(m.movieTitle)} opens, and that is ${esc(when)}.`,
    })
      + movieCard(m)
      + rows([['Opens', esc(m.releaseLong)]], { title: 'Details' })
      + notice({ tone: 'ok', title: advanceTickets ? 'Tickets are on sale' : 'Showtimes are coming', text: advanceTickets ? 'Pick your seats now so you are not stuck with what is left.' : 'Showtimes are not posted yet. Check the movie page for them as soon as they are.' })
      + button(link(`/movie/${m.movieId}`), advanceTickets ? 'Book tickets' : 'See the movie'),
  });
  return {
    subject: `Reminder: ${openLine}`, html, tags: ['coming-soon-reminder'],
    text: text([openLine, '', `Hi ${firstName(name)}, you asked us to remind you before this movie opens.`, `Opens: ${m.releaseLong}`, advanceTickets ? 'Tickets are on sale now.' : 'Showtimes are not posted yet.', link(`/movie/${m.movieId}`) && `Movie page: ${link(`/movie/${m.movieId}`)}`]),
  };
}

module.exports = { welcome, bookingConfirmed, bookingCancelled, showingCancelled, showingMoved, reminder, testEmail, passwordReset, passwordChanged, loginCode, accountRemoved, comingSoonReminder };
