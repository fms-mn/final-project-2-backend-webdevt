const express = require('express');
const config = require('./config');
const { corsMiddleware, originCheck } = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const movieRoutes = require('./routes/movies');
const bookingRoutes = require('./routes/bookings');

// Builds the Express app without connecting to a database or opening a port,
// so tests can exercise the real middleware and routes.
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Middleware
  app.use(corsMiddleware);
  app.use(originCheck);
  app.use(express.json({ limit: '100kb' }));

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/movies', movieRoutes);
  app.use('/api/bookings', bookingRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'FILME API is running' });
  });

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
