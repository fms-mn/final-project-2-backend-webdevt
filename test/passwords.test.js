const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { hashPassword, comparePassword } = require('../services/passwords');

test('password hashing preserves bcrypt cost and runs while the main event loop remains available', async () => {
  let completed = false;
  const hashing = hashPassword('correct-horse').then(hash => { completed = true; return hash; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(completed, false, 'Hashing continues in a worker while timers run');
  const hash = await hashing;
  assert.equal(bcrypt.getRounds(hash), 12);
  assert.equal(await comparePassword('correct-horse', hash), true);
  assert.equal(await comparePassword('wrong-horse', hash), false);
});

test('worker admission rejects excess jobs and serves accepted jobs using existing bcrypt hashes', async () => {
  const existingHash = bcrypt.hashSync('legacy-password', 4);
  const jobs = Array.from({ length: 129 }, () => comparePassword('legacy-password', existingHash).then(value => ({ value }), error => ({ error })));
  const results = await Promise.all(jobs);
  assert.equal(results.filter(result => result.value === true).length, 128);
  const refused = results.find(result => result.error);
  assert.equal(refused.error.status, 503);
  assert.equal(refused.error.retryAfter, 1);
  assert.equal(await comparePassword('legacy-password', existingHash), true);
});

test('a failed password job releases worker capacity without breaking the next job', async () => {
  await assert.rejects(hashPassword(null), error => error.status === 503);
  const hash = bcrypt.hashSync('legacy-password', 4);
  assert.equal(await comparePassword('legacy-password', hash), true);
});
