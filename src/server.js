'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB } = require('./services/db');
const { cleanupOldJobs } = require('./services/jobManager');
const app        = require('./app');
const logger     = require('./utils/logger');

// Last-resort guards: a stray async error must be logged, not silently kill every running job.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason?.message || String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

const PORT = process.env.PORT || 4000;

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await connectDB();
  } catch (err) {
    // Log the DB failure but still start the server — health endpoint can report degraded state.
    logger.error('Failed to connect to MongoDB on startup', { error: err.message });
  }

  const server = app.listen(PORT, () => {
    logger.info(`CLEARBOT backend running on port ${PORT}`);
  });

  // Sweep stale in-memory jobs every 30 minutes.
  const sweeper = setInterval(cleanupOldJobs, 30 * 60 * 1000);

  // Railway/Fly send SIGTERM on every redeploy. Stop accepting connections, close the
  // DB, then exit; force-exit after 10s so open SSE streams can't hang the shutdown.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);
    clearInterval(sweeper);
    setTimeout(() => process.exit(0), 10_000).unref();
    server.close(async () => {
      try {
        await mongoose.connection.close();
      } catch (err) {
        logger.error('Error closing MongoDB connection', { error: err.message });
      }
      process.exit(0);
    });
    // Drop idle keep-alive sockets so server.close() can complete (Node >= 18.2).
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start();
