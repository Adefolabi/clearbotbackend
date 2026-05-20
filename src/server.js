'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const { connectDB } = require('./services/db');
const { cleanupOldJobs } = require('./services/jobManager');
const assessmentRoutes = require('./routes/assessment');
const healthRoutes     = require('./routes/health');
const logger     = require('./utils/logger');

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Wildcard origins cannot be used when credentials are involved (SSE with cookies).
// We explicitly allow the production frontend origin and localhost for development.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://clearbot-frontend-ctgk3tbb7-gaffer.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean); // remove undefined if FRONTEND_URL is not set

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no Origin header (e.g. curl, Postman, server-to-server).
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} is not allowed`));
  },
  credentials: true, // required for SSE connections that include cookies
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
// Cap at 10 kb — credentials are tiny; anything bigger is suspicious.
app.use(express.json({ limit: '10kb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/assessment', assessmentRoutes);
app.use('/api/health',     healthRoutes);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Must have 4 parameters for Express to treat it as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled Express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await connectDB();
  } catch (err) {
    // Log the DB failure but still start the server — health endpoint can report degraded state.
    logger.error('Failed to connect to MongoDB on startup', { error: err.message });
  }

  app.listen(PORT, () => {
    logger.info(`CLEARBOT backend running on port ${PORT}`);
  });

  // Sweep stale in-memory jobs every 30 minutes.
  setInterval(cleanupOldJobs, 30 * 60 * 1000);
}

start();
