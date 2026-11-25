'use strict';

const logger = require('./logger');

/**
 * Matric numbers that may run the bot without paying (owner/tester accounts).
 *
 * Two sources, either one grants access:
 *  - The FreeTester collection, managed at runtime via /api/admin/testers (no redeploy).
 *  - FREE_MATRICS env var, a comma-separated list — a fallback that works even if the DB is down.
 *
 * A DB error fails closed (not free) so an outage never hands out free runs.
 */
function envFreeMatrics() {
  return (process.env.FREE_MATRICS || '')
    .split(',')
    .map(m => m.trim().toUpperCase())
    .filter(Boolean);
}

async function isFreeMatric(matricNumber) {
  if (!matricNumber || typeof matricNumber !== 'string') return false;
  const matric = matricNumber.trim().toUpperCase();
  if (envFreeMatrics().includes(matric)) return true;

  try {
    // Required lazily so tests can stub services/db before this runs.
    const { FreeTester } = require('../services/db');
    return Boolean(await FreeTester.exists({ matricNumber: matric }));
  } catch (err) {
    logger.error('Free-tester lookup failed — treating as not free', { error: err.message });
    return false;
  }
}

module.exports = { isFreeMatric, envFreeMatrics };
