'use strict';

const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

// GET /api/health
// Used by Render health checks and uptime monitors.
router.get('/', (req, res) => {
  const dbState = mongoose.connection.readyState;
  // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const dbStatus = dbState === 1 ? 'connected' : 'disconnected';

  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'ok' : 'degraded',
    db:     dbStatus,
    uptime: Math.floor(process.uptime()),
    ts:     new Date().toISOString(),
  });
});

module.exports = router;
