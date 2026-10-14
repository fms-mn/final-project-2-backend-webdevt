const { Worker } = require('node:worker_threads');
const { cpus } = require('node:os');
const path = require('node:path');
const { HttpError } = require('../utils/http');

const workers = new Set();
const waiting = [];
const workerLimit = Math.min(2, Math.max(1, cpus().length - 1));
const maxOutstanding = 128;
const unavailable = () => new HttpError(503, 'Password processing is busy right now. Please try again in a moment.', { retryAfter: 1 });

function dispatch() {
  for (const slot of workers) {
    if (slot.job || waiting.length === 0) continue;
    slot.job = waiting.shift();
    slot.worker.ref();
    slot.worker.postMessage(slot.job.input);
  }
}

function addWorker() {
  const slot = { worker: new Worker(path.join(__dirname, 'passwordWorker.js')), job: null };
  workers.add(slot);
  slot.worker.on('message', ({ value, failed }) => {
    const job = slot.job;
    slot.job = null;
    failed ? job.reject(unavailable()) : job.resolve(value);
    slot.worker.unref();
    dispatch();
  });
  const stop = () => {
    if (!workers.delete(slot)) return;
    if (slot.job) slot.job.reject(unavailable());
    if (workers.size === 0) {
      for (const job of waiting.splice(0)) job.reject(unavailable());
    } else dispatch();
  };
  slot.worker.on('error', stop);
  slot.worker.on('exit', stop);
  slot.worker.unref();
}

function run(input) {
  if (waiting.length + [...workers].filter(slot => slot.job).length >= maxOutstanding) {
    return Promise.reject(unavailable());
  }
  try {
    if (workers.size < workerLimit) addWorker();
  } catch { return Promise.reject(unavailable()); }
  return new Promise((resolve, reject) => {
    waiting.push({ input, resolve, reject });
    dispatch();
  });
}

module.exports = {
  hashPassword: password => run({ operation: 'hash', password }),
  comparePassword: (password, hash) => run({ operation: 'compare', password, hash }),
};
