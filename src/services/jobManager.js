'use strict';

const logger = require('../utils/logger');

// ─── In-memory job store ──────────────────────────────────────────────────────
// Jobs are ephemeral — they live only for the lifetime of this process.
// Structure per entry:
// {
//   jobId:          string,
//   status:         'queued' | 'running' | 'done' | 'error',
//   dryRun:         boolean,           // Measure 9: visible in admin logs
//   createdAt:      Date,
//   log:            EventObject[],     // every emitted event, for SSE replay on reconnect
//   clients:        Set<ServerResponse>,
//   _sensitiveData: { password, matricNumber } | null  // Measure 3: SSE sanitizer reference
// }
const jobs = new Map();

// ─── Measure 6: Per-matric concurrency lock ───────────────────────────────────
// Tracks which matric numbers currently have an active bot job.
// Prevents two simultaneous Playwright sessions for the same account.
const activeMatrics = new Set();

// ─── SSE write helper ─────────────────────────────────────────────────────────

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise a new job entry. Must be called before emit() or addClient().
 * Accepts an options object so callers can attach metadata (e.g. dryRun).
 */
function createJob(jobId, { dryRun = false } = {}) {
  jobs.set(jobId, {
    jobId,
    status:         'queued',
    dryRun,                    // stored so it appears in any future admin log queries
    createdAt:      new Date(),
    log:            [],
    clients:        new Set(),
    _sensitiveData: null,      // populated by setJobCredentials() once the bot starts
  });
  logger.info('Job created', { jobId, dryRun });
}

/**
 * Update the job's status field.
 */
function setJobStatus(jobId, status) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
}

// ─── Measure 3: Credential storage for the SSE sanitizer ─────────────────────

/**
 * Store a reference to the job's credentials so emit() can sanitize SSE payloads.
 * Must be called from bot.js before the first emit() for this job.
 * The stored values are cleared (not just null-referenced) by clearJobCredentials().
 */
function setJobCredentials(jobId, credentials) {
  const job = jobs.get(jobId);
  if (!job) return;
  job._sensitiveData = {
    password:     credentials.password,
    matricNumber: credentials.matricNumber,
  };
}

/**
 * Clear the credential reference after bot.js has zeroed and nulled the strings.
 * Called unconditionally from the bot's finally block.
 */
function clearJobCredentials(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job._sensitiveData) return;
  // Null the fields explicitly — do not rely solely on GC to release these.
  job._sensitiveData.password     = null;
  job._sensitiveData.matricNumber = null;
  job._sensitiveData = null;
}

// ─── Emit ─────────────────────────────────────────────────────────────────────

/**
 * Emit an event for a job.
 * - Runs the Measure 3 credential sanitizer before storing or sending.
 * - Stores the event in job.log[] for replay on reconnect.
 * - Sends the event to every currently connected SSE client.
 */
function emit(jobId, eventObject) {
  const job = jobs.get(jobId);
  if (!job) {
    logger.warn('emit() called for unknown jobId', { jobId });
    return;
  }

  // Stamp every event with a server-side timestamp if the caller didn't add one.
  if (!eventObject.timestamp) {
    eventObject.timestamp = new Date().toISOString();
  }

  // ── Measure 3: Credential sanitizer ───────────────────────────────────────
  // Serialize the event and check whether it contains the student's password or
  // matric number. If it does, a bug has caused sensitive data to leak into an
  // SSE payload — drop the event and log a security warning. Never throw.
  if (job._sensitiveData) {
    const serialized   = JSON.stringify(eventObject);
    const { password, matricNumber } = job._sensitiveData;
    const hasPassword  = password     && serialized.includes(password);
    const hasMatric    = matricNumber && serialized.includes(matricNumber);

    if (hasPassword || hasMatric) {
      logger.error(
        'SECURITY WARNING: credential detected in SSE payload — event dropped',
        { jobId, leakedField: hasPassword ? 'password' : 'matricNumber' }
      );
      return; // drop silently — the event is never stored or sent to clients
    }
  }

  job.log.push(eventObject);

  for (const res of job.clients) {
    try {
      sendSSE(res, eventObject);
    } catch (err) {
      // The client disconnected mid-write; remove it silently.
      logger.warn('Failed to write SSE to client, removing', { jobId, error: err.message });
      job.clients.delete(res);
    }
  }
}

/**
 * Register a new SSE response object as a listener for jobId.
 * Returns false if the jobId does not exist.
 */
function addClient(jobId, res) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.clients.add(res);
  logger.debug('SSE client added', { jobId, totalClients: job.clients.size });
  return true;
}

/**
 * Deregister an SSE response object (called on 'close' event).
 */
function removeClient(jobId, res) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.clients.delete(res);
  logger.debug('SSE client removed', { jobId, totalClients: job.clients.size });
}

/**
 * Retrieve a job object, or null if not found.
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Replay all past events to a newly connected SSE client.
 * Enables seamless reconnection — the frontend rebuilds its state from the replay.
 */
function replayLog(jobId, res) {
  const job = jobs.get(jobId);
  if (!job) return;
  for (const event of job.log) {
    try {
      sendSSE(res, event);
    } catch (err) {
      logger.warn('Failed to replay event to new client', { jobId, error: err.message });
      return;
    }
  }
}

/**
 * Delete jobs older than 2 hours to prevent unbounded memory growth.
 * Called on a 30-minute interval from server.js.
 */
function cleanupOldJobs() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  let removed = 0;

  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt.getTime() < twoHoursAgo) {
      for (const res of job.clients) {
        try { res.end(); } catch (_) { /* already closed */ }
      }
      jobs.delete(jobId);
      removed++;
    }
  }

  if (removed > 0) {
    logger.info('Cleaned up old jobs', { removed, remaining: jobs.size });
  }
}

// ─── Measure 6: Per-matric concurrency lock ───────────────────────────────────

/**
 * Returns true if a bot job is currently active for the given matric number.
 * Used in the POST /start route to reject duplicate submissions with 409 Conflict.
 */
function isMatricActive(matricNumber) {
  return activeMatrics.has(matricNumber.toUpperCase());
}

/**
 * Mark a matric number as having an active job.
 * Call this in the route handler immediately before launching the bot,
 * after createJob(), to close the race window between validation and bot start.
 */
function lockMatric(matricNumber) {
  activeMatrics.add(matricNumber.toUpperCase());
  logger.debug('Matric lock acquired', { matric: logger.maskMatric(matricNumber) });
}

/**
 * Release the matric lock.
 * Called unconditionally from bot.js finally block — idempotent (safe to call twice).
 * Also called by the timeout handler (Measure 5) and the catch in assessment.js.
 */
function unlockMatric(matricNumber) {
  if (!matricNumber) return; // safe to call even after credentials have been cleared
  activeMatrics.delete(matricNumber.toUpperCase());
  logger.debug('Matric lock released', { matric: logger.maskMatric(matricNumber) });
}

module.exports = {
  createJob,
  setJobStatus,
  emit,
  addClient,
  removeClient,
  getJob,
  replayLog,
  cleanupOldJobs,
  // Measure 3
  setJobCredentials,
  clearJobCredentials,
  // Measure 6
  isMatricActive,
  lockMatric,
  unlockMatric,
};
