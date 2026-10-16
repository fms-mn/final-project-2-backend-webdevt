const fs = require('fs');
const path = require('path');
const config = require('../../config');

// How an email actually leaves the server. Each transport takes
//   { to, toName, subject, html, text, tags }
// and returns { ok: true, id } or throws an Error with a message an admin can act on.
// Brevo and Resend are called over HTTPS, which hosts such as Render allow on their free plan
// (they block the SMTP ports). Nothing here needs an extra package.

const TIMEOUT_MS = 10000;

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = null;
  try { data = await response.json(); } catch { /* an empty answer */ }
  if (!response.ok) {
    const reason = data?.message || data?.error?.message || data?.error || `HTTP ${response.status}`;
    const error = new Error(`${response.status}: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    error.status = response.status;
    throw error;
  }
  return data || {};
}

const brevo = {
  label: 'Brevo',
  needsKey: true,
  ready: () => Boolean(config.mail.brevoKey && config.mail.fromEmail),
  problem: () => (!config.mail.brevoKey ? 'BREVO_API_KEY is not set.' : !config.mail.fromEmail ? 'MAIL_FROM is not set.' : ''),
  async send({ to, toName, subject, html, text, tags }) {
    const { brevoKey, fromEmail, fromName } = config.mail;
    const data = await postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': brevoKey }, {
      sender: { name: fromName, email: fromEmail },
      to: [{ email: to, ...(toName ? { name: toName } : {}) }],
      subject,
      htmlContent: html,
      textContent: text,
      ...(tags?.length ? { tags } : {}),
    });
    return { ok: true, id: data.messageId };
  },
};

const resend = {
  label: 'Resend',
  needsKey: true,
  ready: () => Boolean(config.mail.resendKey && config.mail.fromEmail),
  problem: () => (!config.mail.resendKey ? 'RESEND_API_KEY is not set.' : !config.mail.fromEmail ? 'MAIL_FROM is not set.' : ''),
  async send({ to, subject, html, text, tags }) {
    const { resendKey, fromEmail, fromName } = config.mail;
    const data = await postJson('https://api.resend.com/emails', { Authorization: `Bearer ${resendKey}` }, {
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html,
      text,
      ...(tags?.length ? { tags: tags.map((name) => ({ name: 'type', value: name.replace(/[^A-Za-z0-9_-]/g, '_') })) } : {}),
    });
    return { ok: true, id: data.id };
  },
};

// Development helper: nothing is sent. The email is saved as a web page you can open in a browser
// (server/.mail-outbox), so the design can be seen without setting up a provider.
const OUTBOX = path.join(__dirname, '..', '..', '.mail-outbox');
const log = {
  label: 'Not connected (saved to a folder)',
  ready: () => false,
  problem: () => (config.isProduction
    ? 'No email provider is set up (BREVO_API_KEY and MAIL_FROM are missing).'
    : 'No email provider is set up, so emails are only saved as files in server/.mail-outbox.'),
  async send({ to, subject, html }) {
    if (!config.isProduction) {
      fs.mkdirSync(OUTBOX, { recursive: true });
      const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      const file = path.join(OUTBOX, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}.html`);
      fs.writeFileSync(file, `<!-- To: ${to} | Subject: ${subject} -->\n${html}`);
      return { ok: true, simulated: true, id: path.relative(process.cwd(), file) };
    }
    return { ok: true, simulated: true };
  },
};

// Tests read what would have been sent from here.
const sent = [];
const memory = {
  label: 'Memory (tests)',
  ready: () => false,
  problem: () => 'Test transport.',
  async send(message) {
    sent.push({ ...message, at: new Date() });
    return { ok: true, simulated: true, id: `memory-${sent.length}` };
  },
};

const TRANSPORTS = { brevo, resend, log, memory };

function transportFor(provider = config.mail.provider) {
  return TRANSPORTS[provider] || log;
}

module.exports = { transportFor, sent };
