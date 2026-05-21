'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const { connectDB } = require('./services/db');
const { cleanupOldJobs } = require('./services/jobManager');
const assessmentRoutes = require('./routes/assessment');
const paymentRoutes    = require('./routes/payment');
const healthRoutes     = require('./routes/health');
const logger     = require('./utils/logger');

const app  = express();
const PORT = process.env.PORT || 4000;

// Trust Fly.io's reverse proxy so Express correctly extracts the real client IP
// from the X-Forwarded-For header. Value of 1 = trust one proxy hop (Fly's LB only).
// Eliminates ERR_ERL_UNEXPECTED_X_FORWARDED_FOR from express-rate-limit on every request.
// Do NOT use true — that trusts all proxies in the chain, which is a security risk.
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Wildcard origins cannot be used when credentials are involved (SSE with cookies).
// Exact origins (production URL + localhost) are listed; Vercel preview deployments
// are allowed via pattern because Vercel generates a new hash in the URL every push.
const exactOrigins = [
  process.env.FRONTEND_URL,
  'https://clearbot-frontend.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

// Matches any Vercel preview URL for this project, e.g.:
//   https://clearbot-frontend-abc123-gaffer.vercel.app
const VERCEL_PREVIEW_RE = /^https:\/\/clearbot-frontend-[a-z0-9]+-gaffer\.vercel\.app$/;

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no Origin header (e.g. curl, Postman, server-to-server).
    if (!origin) return callback(null, true);
    if (exactOrigins.includes(origin)) return callback(null, true);
    if (VERCEL_PREVIEW_RE.test(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} is not allowed`));
  },
  credentials: true, // required for SSE connections that include cookies
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
// Paystack webhooks need the raw body for signature verification.
// This must be registered BEFORE express.json() for that specific path.
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));

// Cap at 10 kb — credentials are tiny; anything bigger is suspicious.
app.use(express.json({ limit: '10kb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/assessment', assessmentRoutes);
app.use('/api/payment',    paymentRoutes);
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
