const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const { corsMiddleware, originCheck, securityHeaders } = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const movieRoutes = require('./routes/movies');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const adminMovieRoutes = require('./routes/adminMovies');
const auditoriumRoutes = require('./routes/auditoriums');
const showtimeRoutes = require('./routes/showtimes');
const adminStatsRoutes = require('./routes/adminStats');
const adminSettingsRoutes = require('./routes/adminSettings');

// Serves the built React app, and index.html for page URLs the browser router handles
// (/movies/123, /my-bookings...). Anything with a file extension that does not exist is a real 404.
function serveClient(app, dist) {
  const indexFile = path.join(dist, 'index.html');
  if (!fs.existsSync(indexFile)) return false;

  app.use(express.static(dist, {
    index: false,
    setHeaders(res, filePath) {
      // Vite fingerprints everything in /assets, so those files can be cached for a long time.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  app.get('*', (req, res, next) => {
    if (path.extname(req.path)) return next();
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(indexFile);
  });
  return true;
}

// Builds the Express app without connecting to a database or opening a port,
// so tests can exercise the real middleware and routes.
function createApp({ clientDist = config.clientDist } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Middleware
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(originCheck);
  app.use(express.json({ limit: '100kb' }));

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/movies', movieRoutes);
  app.use('/api/admin/movies', adminMovieRoutes);
  app.use('/api/admin/showtimes', showtimeRoutes.adminRouter);
  app.use('/api/admin/stats', adminStatsRoutes);
  app.use('/api/admin/settings', adminSettingsRoutes);
  app.use('/api/auditoriums', auditoriumRoutes);
  app.use('/api/showtimes', showtimeRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/payments', paymentRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'FILME API is running' });
  });

  app.use('/api', notFound);

  const servingWebsite = serveClient(app, clientDist);
  if (servingWebsite && process.env.NODE_ENV !== 'test') {
    console.log(`Serving the website from ${clientDist}`);
  }

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
