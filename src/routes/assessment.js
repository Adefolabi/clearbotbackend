'use strict';

const express    = require('express');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const jobManager = require('../services/jobManager');
const { runAssessmentBot } = require('../services/bot');
const { validateStartRequest } = require('../utils/validate');
const logger     = require('../utils/logger');
// eslint-disable-next-line no-unused-vars
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
  // Reject the request immediately if a bot job is already running for this matric.
  // This prevents race conditions on the portal and protects against double-submits.
  if (jobManager.isMatricActive(matricNumber)) {
    return res.status(409).json({
      error: 'A job is already running for this matric number. Open your progress tab to check it.',
    });
  }

  // ── Generate job ID ─────────────────────────────────────────────────────
  const jobId = crypto.randomUUID();
  jobManager.createJob(jobId, { dryRun }); // Measure 9: dryRun stored in job record

  // ── Measure 6: Lock matric before launching the bot ───────────────────────
  // Lock is acquired here (in the route handler) rather than inside runAssessmentBot
  // to close the race window between validation and the first async operation.
  jobManager.lockMatric(matricNumber);

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: PAYSTACK INTEGRATION
  //
  // Before starting the bot, verify that this student has a valid
  // paid + unused run for the current semester in MongoDB.
  //
  // If no valid payment exists, return 402 Payment Required along with a
  // Paystack payment initialisation URL so the frontend can redirect them.
  //
  // const semester = getCurrentSemester();
  // const paymentRecord = await Run.findOne({
  //   matricNumber: matricNumber.toUpperCase(),
  //   semester,
  //   paid:         true,
  //   runCompleted: false,
  // });
  //
  // if (!paymentRecord) {
  //   jobManager.unlockMatric(matricNumber);      // release lock — no bot will run
  //   jobManager.setJobStatus(jobId, 'error');
  //   return res.status(402).json({
  //     error:       'Payment required',
  //     paystackUrl: '<Paystack initialisation URL here>',
  //   });
  // }
  //
  // paymentRecord.jobId = jobId;
  // await paymentRecord.save();
  // ─────────────────────────────────────────────────────────────────────────

  // ── Start bot in background ─────────────────────────────────────────────
  // We do NOT await — the bot runs asynchronously and pushes progress via SSE.
  const credentials = { matricNumber, password, campus };
  const ratings     = { defaultRating, perCourseRatings };

  // dryRun is the 4th parameter (Measure 9).
  runAssessmentBot(jobId, credentials, ratings, dryRun).catch(err => {
    // This catch only fires if an error escapes runAssessmentBot's own try/catch,
    // which should never happen — but belt-and-suspenders.
    logger.error('Unhandled bot error escaped runAssessmentBot', { jobId, error: err.message });
    jobManager.emit(jobId, {
      type:      'error',
      message:   'An unexpected server error occurred.',
      fatal:     true,
      timestamp: new Date().toISOString(),
    });
    jobManager.setJobStatus(jobId, 'error');
    jobManager.unlockMatric(matricNumber); // release lock — bot will not call finally
  });

  logger.info('Assessment job queued', { jobId, matric: logger.maskMatric(matricNumber), dryRun });

  return res.status(200).json({ jobId });
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
