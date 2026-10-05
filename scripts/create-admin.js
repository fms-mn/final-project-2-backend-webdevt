/**
 * Creates the first administrator. Public registration can only ever create regular users,
 * so this controlled script is the only way an admin account comes into existence.
 *
 * The credentials come from environment variables, never from source code:
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long password' npm run create-admin
 *
 * (They can also be set in server/.env. ADMIN_NAME is optional.) On Windows PowerShell:
 *   $env:ADMIN_EMAIL = 'you@example.com'; $env:ADMIN_PASSWORD = 'a long password'; npm.cmd run create-admin
 *
 * It never changes an existing account: if the email is already registered it stops and says so.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

async function main() {
  const { MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  const ADMIN_NAME = process.env.ADMIN_NAME || 'Administrator';

  if (!MONGODB_URI) {
    throw new Error('Missing MONGODB_URI. Copy server/.env.example to server/.env and update the value.');
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (environment variables or server/.env).');
  }
  const passwordError = User.validatePassword(ADMIN_PASSWORD);
  if (passwordError) throw new Error(passwordError);

  await mongoose.connect(MONGODB_URI);

  const email = ADMIN_EMAIL.trim().toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.role === 'admin') {
      console.log(`Administrator ${email} already exists. Nothing changed.`);
      return;
    }
    throw new Error(`${email} is already registered as a regular user. Nothing changed.`);
  }

  await new User({
    name: ADMIN_NAME,
    email,
    passwordHash: await User.hashPassword(ADMIN_PASSWORD),
    role: 'admin',
  }).save();
  console.log(`Created administrator ${email}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
