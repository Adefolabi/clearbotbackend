'use strict';

require('dotenv').config();

const { connectDB, getCurrentSemester } = require('./services/db');
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
  // Fail fast on a malformed CURRENT_SEMESTER instead of erroring on the first payment.
  logger.info(`Active semester: ${getCurrentSemester()}`);

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
