// Runtime settings read from environment variables (see server/.env.example).
// Read once when the module is first required, so load dotenv before requiring this file.

const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const list = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

function parseTrustProxy(value) {
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const asNumber = Number(value);
  return Number.isInteger(asNumber) ? asNumber : value;
}

const sessionHours = positiveNumber(process.env.SESSION_HOURS, 2);

module.exports = {
  isProduction,

  // The built React app (npm run build). When it exists, the server serves it, so the website
  // and the API share one origin, as the proposal's deployment plan describes.
  clientDist: process.env.CLIENT_DIST || path.join(__dirname, '..', 'client', 'dist'),

  // Session cookie. Short-lived on purpose: there is no refresh token, so users sign in again.
  cookieName: 'filme_session',
  // Secure cookies only travel over HTTPS, so they are on by default in production only.
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : isProduction,
  sessionHours,
  sessionSeconds: Math.round(sessionHours * 3600),

  // Browsers on these origins may call the API with credentials. Requests from the API's own
  // origin (the single-origin deployment) are always accepted as well.
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? list(process.env.ALLOWED_ORIGINS)
    : (isProduction ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']),

  // Set TRUST_PROXY=1 behind a reverse proxy (Render, Railway, ...) so req.ip is the client.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Failed sign-ins allowed per IP + email within the window. A whole IP gets five times as many.
  loginRateMax: positiveNumber(process.env.LOGIN_RATE_MAX, 5),
  loginRateWindowMs: positiveNumber(process.env.LOGIN_RATE_WINDOW_MINUTES, 15) * 60 * 1000,

  // Payments are simulated by services/payments.js (no real money moves). These are read each time
  // they are used, so they can be changed by an environment variable without restarting code paths.
  //   PAYMENT_REQUIRED=false  bookings confirm immediately, with no payment step
  //   HOLD_MINUTES            how long chosen seats are held while the customer pays (default 5)
  //   PAYMENT_DELAY_MS        pretend processing time of the simulated gateway (default 900)
  get paymentRequired() { return process.env.PAYMENT_REQUIRED !== 'false'; },
  get holdMinutes() { return positiveNumber(process.env.HOLD_MINUTES, 5); },
  // Emails (services/mail). Read each time so a test can change them.
  //   MAIL_PROVIDER   brevo | resend | log | memory. Chosen by itself when a key is set (BREVO_API_KEY or
  //                   RESEND_API_KEY); without one, emails are only written to a folder (development) or logged.
  //   MAIL_FROM       the sender address. Brevo only sends from an address you verified there.
  //   MAIL_FROM_NAME  the sender name customers see (default "filme").
  //   APP_URL         the public address of the website, for the buttons and the logo in emails.
  //   REMINDER_HOURS  how long before a showing the reminder email goes out (default 3).
  get mail() {
    const env = process.env;
    const detected = env.BREVO_API_KEY ? 'brevo' : env.RESEND_API_KEY ? 'resend' : (env.NODE_ENV === 'test' ? 'memory' : 'log');
    return {
      provider: (env.MAIL_PROVIDER || detected).trim().toLowerCase(),
      brevoKey: env.BREVO_API_KEY || '',
      resendKey: env.RESEND_API_KEY || '',
      fromEmail: (env.MAIL_FROM || '').trim(),
      fromName: (env.MAIL_FROM_NAME || 'filme').trim(),
      appUrl: (env.APP_URL || '').trim().replace(/\/+$/, ''),
      reminderHours: positiveNumber(env.REMINDER_HOURS, 3),
    };
  },
  get paymentDelayMs() {
    const value = Number(process.env.PAYMENT_DELAY_MS);
    return process.env.PAYMENT_DELAY_MS !== undefined && Number.isFinite(value) && value >= 0 ? value : 900;
  },
};
