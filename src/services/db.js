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
  semester:      { type: String, required: true },   // e.g. "2025_2026_2nd"
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

// ─── Semester Helper ──────────────────────────────────────────────────────────

/**
 * Returns the current semester identifier string, e.g. "2025_2026_2nd".
 * Aug–Jan  = 1st semester of the academic year starting that August.
 * Feb–Jul  = 2nd semester of the same academic year.
 */
function getCurrentSemester() {
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

module.exports = { connectDB, Run, getCurrentSemester };
