const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const router = express.Router();

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
});

const signToken = (user) => jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
  expiresIn: '7d',
});

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    // Reject non-strings so a request body cannot smuggle query operators into the lookup.
    if (typeof name !== 'string' || typeof email !== 'string') {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    if (phone !== undefined && typeof phone !== 'string') {
      return res.status(400).json({ message: 'Phone must be text' });
    }
    const passwordError = User.validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Public registration always creates a regular user, whatever role the request names.
    const user = new User({
      name,
      email,
      phone,
      passwordHash: await User.hashPassword(password),
      role: 'user',
    });
    await user.save();

    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: error.message });
    }
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Email already registered' });
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
