'use strict';

const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };
const isProd = process.env.NODE_ENV === 'production';

// Mask matric numbers so they never appear in plain text in logs.
// "BU22CSC1081" → "BU22***1081"
function maskMatric(str) {
  return String(str).replace(/^([A-Za-z]{2}\d{2})[A-Za-z]{3}(\d{4})$/, '$1***$2');
}

function format(level, message, meta) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${LEVELS[level]}] ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    // Strip any accidental password fields before serialising meta.
    const safe = { ...meta };
    delete safe.password;
    if (safe.matricNumber) safe.matricNumber = maskMatric(safe.matricNumber);
    return `${base} ${JSON.stringify(safe)}`;
  }
  return base;
}

function write(level, message, meta = {}) {
  // Suppress debug in production.
  if (isProd && level === 'debug') return;
  const line = format(level, message, meta);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  info:  (msg, meta) => write('info',  msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
  maskMatric,
};

module.exports = logger;
