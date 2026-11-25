'use strict';

// ─── Admin: free-tester management ────────────────────────────────────────────
// Lets the owner add/remove matric numbers that can run the bot without paying,
// without a redeploy. Every route requires the X-Admin-Secret header to equal ADMIN_SECRET.
//
//   GET    /api/admin/testers              → { testers: [{ matricNumber, note, addedAt }], envTesters: [...] }
//   POST   /api/admin/testers              body { matricNumber, note? } → 201 added / 200 already there
//   DELETE /api/admin/testers/:matric      → 200 removed / 404 not found

const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const { FreeTester } = require('../services/db');
const { envFreeMatrics } = require('../utils/freeAccess');
const logger    = require('../utils/logger');

const MATRIC_PATTERN = /^[A-Za-z]{2}\d{2}[A-Za-z]{3}\d{4}$/;

const router = express.Router();

// Slows down secret guessing; generous enough for normal admin use.
router.use(rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests' },
}));

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.use((req, res, next) => {
  const secret = req.get('x-admin-secret');
  if (!process.env.ADMIN_SECRET || typeof secret !== 'string' || !safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

router.get('/testers', async (req, res) => {
  try {
    const testers = await FreeTester.find({}, { _id: 0, matricNumber: 1, note: 1, addedAt: 1 })
      .sort({ addedAt: -1 })
      .lean();
    return res.json({ testers, envTesters: envFreeMatrics() });
  } catch (err) {
    logger.error('Admin list testers failed', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/testers', async (req, res) => {
  const { matricNumber, note } = req.body || {};
  if (typeof matricNumber !== 'string' || !MATRIC_PATTERN.test(matricNumber.trim())) {
    return res.status(400).json({ error: 'A valid matricNumber is required (e.g. BU22CSC1081)' });
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > 200)) {
    return res.status(400).json({ error: 'note must be a string of at most 200 characters' });
  }

  const matric = matricNumber.trim().toUpperCase();
  try {
    const existing = await FreeTester.findOne({ matricNumber: matric });
    if (existing) {
      return res.status(200).json({ added: false, message: 'Already a free tester', matricNumber: matric });
    }
    await new FreeTester({ matricNumber: matric, note }).save();
    logger.info('Admin: free tester added', { matric });
    return res.status(201).json({ added: true, matricNumber: matric });
  } catch (err) {
    logger.error('Admin add tester failed', { matric, error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/testers/:matric', async (req, res) => {
  const matric = String(req.params.matric || '').trim().toUpperCase();
  if (!MATRIC_PATTERN.test(matric)) {
    return res.status(400).json({ error: 'A valid matric number is required' });
  }
  try {
    const result = await FreeTester.deleteOne({ matricNumber: matric });
    if (!result.deletedCount) {
      return res.status(404).json({ error: 'Not a free tester', matricNumber: matric });
    }
    logger.info('Admin: free tester removed', { matric });
    return res.json({ removed: true, matricNumber: matric });
  } catch (err) {
    logger.error('Admin remove tester failed', { matric, error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
