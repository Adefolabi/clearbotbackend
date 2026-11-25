'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

// ─── Connection ───────────────────────────────────────────────────────────────

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  try {
    await mongoose.connect(uri, {
      // Modern Mongoose (v8+) uses these as defaults but being explicit is safer on Render.
      serverSelectionTimeoutMS: 10000,
    });
    logger.info('MongoDB connected successfully');
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    throw err;
  }
}

// ─── Run Schema ───────────────────────────────────────────────────────────────

const runSchema = new mongoose.Schema({
  matricNumber:  { type: String, required: true, uppercase: true, trim: true },
  semester:      { type: String, required: true },   // e.g. "2026_2027_1st"
  paid:          { type: Boolean, default: false },
  paidAt:        { type: Date },
  paystackRef:   { type: String },                   // populated when Paystack is integrated
  runCompleted:  { type: Boolean, default: false },
  completedAt:   { type: Date },
  jobId:         { type: String },
  summary: {
    completed: { type: Number },
    skipped:   { type: Number },
    failed:    { type: Number },
  },
  createdAt:     { type: Date, default: Date.now },
});

// Compound index for fast payment lookup per student per semester.
runSchema.index({ matricNumber: 1, semester: 1 });

const Run = mongoose.model('Run', runSchema);

// ─── FreeTester Schema ────────────────────────────────────────────────────────
// Matric numbers allowed to run the bot without paying (owner/testers).
// Managed at runtime via /api/admin/testers — no redeploy needed to add someone.

const freeTesterSchema = new mongoose.Schema({
  matricNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
  note:         { type: String, trim: true, maxlength: 200 },
  addedAt:      { type: Date, default: Date.now },
});

const FreeTester = mongoose.model('FreeTester', freeTesterSchema);

// ─── Semester Helper ──────────────────────────────────────────────────────────

const SEMESTER_RE = /^\d{4}_\d{4}_(1st|2nd)$/;

/**
 * Returns the current semester identifier string, e.g. "2026_2027_1st".
 *
 * If CURRENT_SEMESTER is set it wins, so the rollover is controlled by config rather
 * than the calendar. A set-but-malformed value throws instead of silently falling back,
 * because a typo would otherwise reset every student's paid status.
 *
 * Otherwise it is derived from today's date:
 * Aug–Jan  = 1st semester of the academic year starting that August.
 * Feb–Jul  = 2nd semester of the same academic year.
 */
function getCurrentSemester() {
  const override = process.env.CURRENT_SEMESTER;
  if (override !== undefined && override !== '') {
    if (!SEMESTER_RE.test(override)) {
      throw new Error(`CURRENT_SEMESTER "${override}" is invalid — expected e.g. 2026_2027_1st`);
    }
    return override;
  }

  const now = new Date();
  const month = now.getMonth() + 1; // 1-indexed
  const year  = now.getFullYear();

  if (month >= 8) {
    // Aug–Dec: first semester, academic year starts this calendar year.
    return `${year}_${year + 1}_1st`;
  } else if (month === 1) {
    // January still belongs to the 1st semester that started the previous August.
    return `${year - 1}_${year}_1st`;
  } else {
    // Feb–Jul: second semester, academic year started the previous August.
    return `${year - 1}_${year}_2nd`;
  }
}

module.exports = { connectDB, Run, FreeTester, getCurrentSemester };
