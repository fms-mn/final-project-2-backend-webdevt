const { parentPort } = require('node:worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ operation, password, hash }) => {
  try {
    const value = operation === 'hash' ? bcrypt.hashSync(password, 12) : bcrypt.compareSync(password, hash);
    parentPort.postMessage({ value });
  } catch {
    parentPort.postMessage({ failed: true });
  }
});
