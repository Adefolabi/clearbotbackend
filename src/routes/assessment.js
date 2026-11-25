'use strict';

const express    = require('express');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const jobManager = require('../services/jobManager');
const { runAssessmentBot } = require('../services/bot');
const { validateStartRequest } = require('../utils/validate');
const logger     = require('../utils/logger');
const { isFreeMatric } = require('../utils/freeAccess');
const { Run, getCurrentSemester } = require('../services/db');

const router = express.Router();

// ─── Measure 4: Rate limiter — POST /start only ───────────────────────────────
// Applied only to the bot-launch endpoint, not to the SSE stream.
// A legitimate student submits once per semester; 5 per 15 min covers any reasonable retry.
// Without this, anyone who finds the URL can spawn hundreds of Playwright browsers per minute.
const startRateLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15-minute sliding window
  max:             5,              // 5 requests per IP per window
  standardHeaders: true,           // emit RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset
  legacyHeaders:   false,          // suppress deprecated X-RateLimit-* headers
  message: {
    error: 'Too many requests — please wait 15 minutes before trying again',
  },
});

// ─── POST /api/assessment/start ───────────────────────────────────────────────

router.post('/start', startRateLimiter, async (req, res) => {
  // ── Validate input ──────────────────────────────────────────────────────
  const validation = validateStartRequest(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', details: validation.errors });
  }

  const { matricNumber, password, campus, defaultRating, perCourseRatings = {} } = req.body;

  // ── Measure 9: Extract dryRun flag ────────────────────────────────────────
  // Must be an explicit boolean true — string "true" is rejected.
  // When omitted, defaults to false so existing behaviour is unchanged.
  const dryRun = req.body.dryRun === true;

  // ── Measure 6: Per-matric concurrency check ───────────────────────────────
  if (jobManager.isMatricActive(matricNumber)) {
    return res.status(409).json({
      error: 'A job is already running for this matric number. Open your progress tab to check it.',
    });
  }

  // ── Global capacity check ──────────────────────────────────────────────────
  if (jobManager.getRunningJobCount() >= jobManager.MAX_CONCURRENT_JOBS) {
    return res.status(503).json({
      error: 'Server is at capacity — please try again in a few minutes.',
    });
  }

  // Lock synchronously (before any await) to close the double-submit race.
  jobManager.lockMatric(matricNumber);
  let jobId = null;
  let botStarted = false;

  try {
    // ── Payment verification (runs BEFORE a job record exists) ──────────────
    // Fail closed: in production a missing PAYSTACK_SECRET_KEY must never mean "free".
    // Dev/test (non-production) may skip payment when the key is unset.
    if (!process.env.PAYSTACK_SECRET_KEY && process.env.NODE_ENV === 'production') {
      logger.error('PAYSTACK_SECRET_KEY missing in production — refusing to start job');
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    let paymentRecord = null;
    const freeAccess = isFreeMatric(matricNumber);
    if (freeAccess) {
      logger.info('Start: free-access matric, skipping payment check', { matric: logger.maskMatric(matricNumber) });
    } else if (process.env.PAYSTACK_SECRET_KEY) {
      paymentRecord = await Run.findOne({
        matricNumber: matricNumber.toUpperCase(),
        semester:     getCurrentSemester(),
        paid:         true,
      });
      if (!paymentRecord) {
        return res.status(402).json({ error: 'Payment required' });
      }
    }

    // ── Create job ──────────────────────────────────────────────────────────
    jobId = crypto.randomUUID();
    jobManager.createJob(jobId, { dryRun });

    if (paymentRecord) {
      paymentRecord.jobId = jobId;
      await paymentRecord.save();
    }

    // ── Start bot in background (not awaited) ───────────────────────────────
    const credentials = { matricNumber, password, campus };
    const ratings     = { defaultRating, perCourseRatings };

    botStarted = true; // bot's own finally block now owns the matric lock
    runAssessmentBot(jobId, credentials, ratings, dryRun).catch(err => {
      logger.error('Unhandled bot error escaped runAssessmentBot', { jobId, error: err.message });
      jobManager.emit(jobId, {
        type:      'error',
        message:   'An unexpected server error occurred.',
        fatal:     true,
        timestamp: new Date().toISOString(),
      });
      jobManager.setJobStatus(jobId, 'error');
      jobManager.unlockMatric(matricNumber);
    });

    logger.info('Assessment job queued', { jobId, matric: logger.maskMatric(matricNumber), dryRun });
    return res.status(200).json({ jobId });

  } catch (err) {
    logger.error('Assessment start failed', { jobId, error: err.message });
    if (jobId) jobManager.setJobStatus(jobId, 'error');
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  } finally {
    // Release the lock on every path where the bot never took ownership of it.
    if (!botStarted) jobManager.unlockMatric(matricNumber);
  }
});

// ─── GET /api/assessment/progress/:jobId  (SSE) ───────────────────────────────

router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  const job = jobManager.getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // ── SSE headers ─────────────────────────────────────────────────────────
  // X-Accel-Buffering: no  →  tells Nginx not to buffer SSE chunks.
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.flushHeaders();

  // ── Replay past events ──────────────────────────────────────────────────
  jobManager.replayLog(jobId, res);

  // ── Register this client ────────────────────────────────────────────────
  jobManager.addClient(jobId, res);

  // ── Heartbeat ───────────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 20000);

  // ── Client disconnect ───────────────────────────────────────────────────
  req.on('close', () => {
    clearInterval(heartbeat);
    jobManager.removeClient(jobId, res);
    logger.debug('SSE client disconnected', { jobId });
  });
});

module.exports = router;
