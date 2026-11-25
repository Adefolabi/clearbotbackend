'use strict';

/**
 * Matric numbers that may run the bot without paying (owner/tester accounts).
 * Set FREE_MATRICS to a comma-separated list, e.g. "BU22CSC1081,BU21ABC1234".
 * Read on every call so a Railway variable change applies after redeploy without code edits.
 */
function isFreeMatric(matricNumber) {
  if (!matricNumber || typeof matricNumber !== 'string') return false;
  const list = (process.env.FREE_MATRICS || '')
    .split(',')
    .map(m => m.trim().toUpperCase())
    .filter(Boolean);
  return list.includes(matricNumber.trim().toUpperCase());
}

module.exports = { isFreeMatric };
