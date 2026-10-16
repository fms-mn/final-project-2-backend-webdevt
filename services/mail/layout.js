const config = require('../../config');

// The look shared by every email. Email programs are picky: layout is made of tables, styles are
// written inline, fonts are the safe ones, and images are only used where a missing image does not
// break the message. A small <style> block adds dark mode for the programs that understand it.

const C = {
  crimson: '#c82448', crimsonDark: '#8f1634', ink: '#172347', muted: '#637297', page: '#e8eaf5',
  card: '#ffffff', soft: '#f4f5fb', line: '#dce2f1',
  okInk: '#0b7f58', okBg: '#e2f7ed', warnInk: '#7a4a05', warnBg: '#fff3dc', downInk: '#b4233e', downBg: '#fdecef',
  infoInk: '#2a3f8f', infoBg: '#e8edff',
};
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";

const TONES = {
  ok: { ink: C.okInk, bg: C.okBg },
  warn: { ink: C.warnInk, bg: C.warnBg },
  down: { ink: C.downInk, bg: C.downBg },
  info: { ink: C.infoInk, bg: C.infoBg },
  brand: { ink: '#ffffff', bg: C.crimson },
};

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Only web addresses go into a link or image, so a bad value can never become a script.
const safeUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
};

const link = (pathname = '') => (config.mail.appUrl ? `${config.mail.appUrl}${pathname}` : '');

// ---- blocks ---------------------------------------------------------------------------------
function pill(text, tone = 'ok') {
  const { ink, bg } = TONES[tone] || TONES.ok;
  return `<span class="pill" style="display:inline-block;padding:5px 12px;border-radius:99px;background:${bg};color:${ink};font:700 12px ${SANS};letter-spacing:.08em;text-transform:uppercase;">${esc(text)}</span>`;
}

function hero({ chip, tone, title, lead }) {
  return `<tr><td style="padding:32px 32px 8px;">
    ${chip ? `<div style="margin:0 0 14px;">${pill(chip, tone)}</div>` : ''}
    <h1 class="t-ink" style="margin:0;font:800 28px/1.2 ${SANS};letter-spacing:-.02em;color:${C.ink};">${esc(title)}</h1>
    ${lead ? `<p class="t-muted" style="margin:12px 0 0;font:400 16px/1.55 ${SANS};color:${C.muted};">${lead}</p>` : ''}
  </td></tr>`;
}

function section(inner, { pad = '20px 32px 8px' } = {}) {
  return `<tr><td style="padding:${pad};">${inner}</td></tr>`;
}

// The movie: poster, title and a line of facts.
function movieCard(t) {
  const poster = safeUrl(t.posterUrl);
  const facts = [t.rating, t.genre, t.durationLabel].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  return section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="soft" style="background:${C.soft};border-radius:14px;">
    <tr>
      ${poster ? `<td width="96" valign="top" style="padding:14px 0 14px 14px;"><img src="${esc(poster)}" width="82" alt="" style="display:block;width:82px;height:auto;border-radius:8px;border:0;background:${C.line};"></td>` : ''}
      <td valign="middle" style="padding:14px 16px;">
        <div class="t-ink" style="font:800 20px/1.25 ${SANS};letter-spacing:-.01em;color:${C.ink};">${esc(t.movieTitle)}</div>
        ${facts ? `<div class="t-muted" style="margin-top:6px;font:400 14px/1.4 ${SANS};color:${C.muted};">${facts}</div>` : ''}
      </td>
    </tr></table>`);
}

// The ticket itself: when and where, the seats, and the booking code to show at the cinema.
function ticketStub(t, { struck = false } = {}) {
  const dim = struck ? 'opacity:.55;' : '';
  const strike = struck ? 'text-decoration:line-through;' : '';
  return section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="line" style="border:1px solid ${C.line};border-radius:16px;overflow:hidden;${dim}">
    <tr><td style="background:${C.crimson};padding:10px 18px;font:700 12px ${SANS};letter-spacing:.14em;text-transform:uppercase;color:#ffffff;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font:700 12px ${SANS};letter-spacing:.14em;color:#ffffff;text-transform:uppercase;">Admit ${esc(t.quantity)}</td>
        <td align="right" style="font:700 12px ${SANS};letter-spacing:.14em;color:#ffffff;text-transform:uppercase;">${esc(t.room)}</td>
      </tr></table>
    </td></tr>
    <tr><td class="card" style="padding:20px 18px 6px;background:${C.card};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="top" width="58%" style="padding-bottom:14px;">
          <div class="t-muted" style="font:700 11px ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.muted};">Date</div>
          <div class="t-ink" style="margin-top:4px;font:700 17px/1.3 ${SANS};color:${C.ink};${strike}">${esc(t.dateShort)}</div>
        </td>
        <td valign="top" style="padding-bottom:14px;">
          <div class="t-muted" style="font:700 11px ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.muted};">Time</div>
          <div class="t-ink" style="margin-top:4px;font:700 17px/1.3 ${SANS};color:${C.ink};${strike}">${esc(t.time)}</div>
        </td>
      </tr><tr>
        <td colspan="2" style="padding-bottom:16px;">
          <div class="t-muted" style="font:700 11px ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.muted};">${t.seats.length === 1 ? 'Seat' : 'Seats'}</div>
          <div class="t-ink" style="margin-top:4px;font:700 17px/1.3 ${SANS};color:${C.ink};">${t.seats.map(esc).join(', ')}</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td class="card" style="background:${C.card};padding:0 18px;"><div class="line" style="border-top:2px dashed ${C.line};height:1px;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>
    <tr><td class="card" align="center" style="background:${C.card};padding:16px 18px 20px;">
      <div class="t-muted" style="font:700 11px ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.muted};">Booking code</div>
      <div class="t-ink" style="margin-top:6px;font:700 26px/1.2 ${MONO};letter-spacing:.08em;color:${C.ink};${strike}">${esc(t.code)}</div>
    </td></tr>
  </table>`);
}

// Rows of "label ... value".
function rows(items, { title } = {}) {
  const body = items.filter(Boolean).map(([label, value, strong], index, all) => `<tr>
      <td class="t-muted line" style="padding:11px 0;${index < all.length - 1 ? `border-bottom:1px solid ${C.line};` : ''}font:400 14px ${SANS};color:${C.muted};">${esc(label)}</td>
      <td class="t-ink line" align="right" style="padding:11px 0;${index < all.length - 1 ? `border-bottom:1px solid ${C.line};` : ''}font:${strong ? 800 : 600} ${strong ? 17 : 14}px ${SANS};color:${C.ink};">${value}</td>
    </tr>`).join('');
  return section(`${title ? `<div class="t-ink" style="margin:0 0 4px;font:800 15px ${SANS};color:${C.ink};">${esc(title)}</div>` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>`);
}

function notice({ tone = 'info', title, text }) {
  const { ink, bg } = TONES[tone] || TONES.info;
  return section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${bg};border-radius:12px;padding:14px 16px;font:400 14px/1.55 ${SANS};color:${ink};">
    ${title ? `<strong style="font-weight:800;">${esc(title)}</strong><br>` : ''}${text}
  </td></tr></table>`);
}

// A button that works in every email program (a coloured table cell, not CSS on a link).
function button(url, label) {
  if (!safeUrl(url)) return '';
  return section(`<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${C.crimson}" style="border-radius:12px;">
      <a href="${esc(url)}" style="display:inline-block;padding:15px 28px;font:700 16px ${SANS};color:#ffffff;text-decoration:none;border-radius:12px;">${esc(label)}</a>
    </td></tr></table>`, { pad: '12px 32px 28px' });
}

const paragraph = (html) => section(`<p class="t-muted" style="margin:0;font:400 15px/1.6 ${SANS};color:${C.muted};">${html}</p>`);

// ---- the page around it all -----------------------------------------------------------------
function shell({ preheader, rowsHtml }) {
  const logo = link('/email-logo.png');
  const home = link('/');
  const brand = `${logo ? `<img src="${esc(logo)}" width="44" height="34" alt="" style="vertical-align:middle;border:0;margin-right:8px;">` : ''}<span class="t-ink" style="vertical-align:middle;font:800 30px ${SANS};letter-spacing:-.045em;color:${C.ink};">filme</span>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>filme</title>
<style>
@media (prefers-color-scheme: dark) {
  .bg-page { background:#11172d !important; }
  .card { background:#1b2441 !important; }
  .soft { background:#252f4d !important; }
  .t-ink { color:#f0f3ff !important; }
  .t-muted { color:#b4bfdc !important; }
  .line { border-color:#3c4766 !important; }
}
@media only screen and (max-width:620px) {
  .wrap { width:100% !important; }
  .pad { padding-left:20px !important; padding-right:20px !important; }
}
</style></head>
<body class="bg-page" style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg-page" style="background:${C.page};"><tr><td align="center" style="padding:28px 12px 36px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="wrap" style="width:600px;max-width:100%;">
    <tr><td align="center" style="padding:0 0 18px;">${home ? `<a href="${esc(home)}" style="text-decoration:none;">${brand}</a>` : brand}</td></tr>
    <tr><td class="card" style="background:${C.card};border-radius:22px;overflow:hidden;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:6px;line-height:6px;font-size:6px;background:${C.crimson};">&nbsp;</td></tr>
        ${rowsHtml}
        <tr><td style="height:12px;line-height:12px;font-size:12px;">&nbsp;</td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:22px 20px 0;font:400 12.5px/1.6 ${SANS};color:${C.muted};" class="t-muted">
      <strong style="font-weight:700;">filme</strong> &nbsp;·&nbsp; Movie ticket booking<br>
      You are getting this email because of activity on your filme account.<br>
      Please do not reply to this message; it comes from an address nobody reads.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

module.exports = { C, esc, safeUrl, link, shell, hero, section, movieCard, ticketStub, rows, notice, button, paragraph, pill };
