const config = require('../../config');
const { transportFor, sent } = require('./transports');

// Sending an email must never get in the way of a booking, a payment or a cancellation, so:
//   - sendMail never throws: it answers { ok, simulated, provider, error }.
//   - notify() runs a notification in the background; whatever goes wrong is only logged.
//   - idle() waits for the background work, which is what the tests and scripts use.

const looksLikeEmail = (value) => typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim());

// "a***@gmail.com": enough to recognise in a log, not enough to read someone's address from it.
const hide = (address) => String(address).replace(/^(.).*(@.*)$/, '$1***$2');

const quiet = () => process.env.NODE_ENV === 'test';
const logLine = (...parts) => { if (!quiet()) console.log('[mail]', ...parts); };

async function sendMail({ to, toName, subject, html, text, tags = [] }) {
  const provider = config.mail.provider;
  if (!looksLikeEmail(to)) return { ok: false, provider, error: 'The recipient is not a valid email address.' };
  const transport = transportFor(provider);
  // A provider without its key or sender address cannot work: say so plainly instead of failing at the network.
  if (transport.needsKey && !transport.ready()) return { ok: false, provider, error: transport.problem() };
  const message = { to: to.trim(), toName, subject, html, text, tags };

  // One more try for a network hiccup or a busy provider; a refusal (4xx) is not retried.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await transport.send(message);
      logLine(result.simulated ? 'saved (not sent)' : 'sent', `via ${provider}`, `to=${hide(to)}`, `subject="${subject}"`);
      return { ...result, provider };
    } catch (error) {
      const retryable = !error.status || error.status >= 500;
      if (attempt === 2 || !retryable) {
        if (!quiet()) console.error('[mail] failed', `via ${provider}`, `to=${hide(to)}`, `subject="${subject}"`, '-', error.message);
        return { ok: false, provider, error: error.message };
      }
      await new Promise((resolve) => { setTimeout(resolve, 600); });
    }
  }
  return { ok: false, provider, error: 'Unknown error' };
}

const pending = new Set();
function notify(work) {
  const task = Promise.resolve()
    .then(work)
    .catch((error) => { if (!quiet()) console.error('[mail] notification failed:', error.message); })
    .finally(() => pending.delete(task));
  pending.add(task);
  return task;
}
const idle = async () => { while (pending.size) await Promise.all([...pending]); };

// What the admin sees about the connection. Never includes a key.
function status() {
  const { provider, fromEmail, fromName, appUrl } = config.mail;
  const transport = transportFor(provider);
  return {
    provider,
    label: transport.label,
    ready: transport.ready(),
    problem: transport.ready() ? '' : transport.problem(),
    from: fromEmail ? `${fromName} <${fromEmail}>` : '',
    appUrl,
  };
}

module.exports = { sendMail, notify, idle, status, looksLikeEmail, sent };
