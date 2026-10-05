// Tests for serving the built website from the same server as the API (no database needed).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'offline-test-secret-offline-test-secret';
process.env.TRUST_PROXY = '1'; // so X-Forwarded-Proto: https counts as HTTPS

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../app');

let dist;
let withSite;
let withoutSite;
let siteBase;
let apiOnlyBase;

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

test.before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'filme-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>FILME</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log("app")');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  withSite = await listen(createApp({ clientDist: dist }));
  withoutSite = await listen(createApp({ clientDist: path.join(dist, 'does-not-exist') }));
  siteBase = urlOf(withSite);
  apiOnlyBase = urlOf(withoutSite);
});

test.after(async () => {
  await Promise.all([withSite, withoutSite].map((s) => new Promise((resolve) => s.close(resolve))));
  fs.rmSync(dist, { recursive: true, force: true });
});

test('the home page and browser-router URLs return index.html', async () => {
  for (const route of ['/', '/movies', '/movies/12345', '/my-bookings', '/login']) {
    const res = await fetch(siteBase + route);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<div id="root">/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  }
});

test('fingerprinted assets are served and cached for a long time', async () => {
  const res = await fetch(`${siteBase}/assets/index-abc123.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${siteBase}/favicon.svg`)).status, 200);
});

test('a missing file is a real 404, not index.html', async () => {
  const res = await fetch(`${siteBase}/assets/missing.js`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /id="root"/);
});

test('the API still answers with JSON, including unknown API routes', async () => {
  const health = await fetch(`${siteBase}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const unknown = await fetch(`${siteBase}/api/nope`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type'), /json/);
  assert.equal((await unknown.json()).message, 'Not found');
});

test('writes to non-API paths are not answered with the website', async () => {
  const res = await fetch(`${siteBase}/movies`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('path traversal cannot read files outside the site', async () => {
  const secret = path.join(path.dirname(dist), 'filme-secret.txt');
  fs.writeFileSync(secret, 'TOP SECRET');
  try {
    for (const attempt of ['/..%2ffilme-secret.txt', '/%2e%2e/filme-secret.txt', '/assets/..%2f..%2ffilme-secret.txt']) {
      const res = await fetch(siteBase + attempt);
      assert.doesNotMatch(await res.text(), /TOP SECRET/, attempt);
    }
  } finally {
    fs.rmSync(secret, { force: true });
  }
});

test('without a build the server is API-only', async () => {
  assert.equal((await fetch(`${apiOnlyBase}/api/health`)).status, 200);
  const home = await fetch(`${apiOnlyBase}/`);
  assert.equal(home.status, 404);
  assert.doesNotMatch(await home.text(), /id="root"/);
});

test('security headers are set; HSTS only over HTTPS', async () => {
  const plain = await fetch(`${siteBase}/api/health`);
  assert.equal(plain.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(plain.headers.get('x-frame-options'), 'DENY');
  assert.ok(plain.headers.get('referrer-policy'));
  assert.equal(plain.headers.get('strict-transport-security'), null);
  assert.equal(plain.headers.get('x-powered-by'), null);

  const secure = await fetch(`${siteBase}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(secure.headers.get('strict-transport-security'), /max-age=\d+/);
});
