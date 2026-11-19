'use strict';

// Test harness: stubs Mongo (Run model), the Playwright bot and Paystack so the
// real Express app + real jobManager can be exercised without any network or browser.

const path   = require('path');
const http   = require('http');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const SEMESTER = '2026_2027_1st';

function stubModule(relPath, exports) {
  const file = require.resolve(path.join(SRC, relPath));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// ─── In-memory stand-in for the Mongoose Run model ───────────────────────────
class Run {
  constructor(fields = {}) {
    Object.assign(this, {
      paid: false, runCompleted: false, createdAt: new Date(), _id: crypto.randomUUID(),
    }, fields);
  }
  async save() {
    if (Run.failSave) throw new Error('simulated save failure');
    if (!Run.docs.includes(this)) Run.docs.push(this);
    return this;
  }
  static match(doc, q) { return Object.entries(q).every(([k, v]) => doc[k] === v); }
  static findOne(q) {
    const run = () => {
      if (Run.failFind) throw new Error('simulated DB failure');
      const hits = Run.docs.filter(d => Run.match(d, q));
      return hits.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    };
    const chain = {
      sort() { return chain; },
      then(res, rej) { try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
    };
    return chain;
  }
  static async findOneAndUpdate(q, update) {
    const doc = Run.docs.find(d => Run.match(d, q));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  }
  static reset() { Run.docs = []; Run.failFind = false; Run.failSave = false; }
}
Run.reset();

// ─── Bot stub ─────────────────────────────────────────────────────────────────
const bot = { calls: [], hang: false };
function runAssessmentBot(jobId, credentials, ratings, dryRun) {
  bot.calls.push({ jobId, credentials: { ...credentials }, ratings, dryRun });
  const jm = require(path.join(SRC, 'services', 'jobManager'));
  if (bot.hang) return new Promise(() => {}); // job stays active, matric stays locked
  jm.setJobStatus(jobId, 'done');
  jm.unlockMatric(credentials.matricNumber); // the real bot does this in its finally block
  return Promise.resolve();
}

stubModule('services/db.js', {
  connectDB: async () => {}, Run, getCurrentSemester: () => SEMESTER,
});
stubModule('services/bot.js', { runAssessmentBot });

// Silence expected error logs from the code under test.
const logger = require(path.join(SRC, 'utils', 'logger'));
for (const k of ['info', 'warn', 'error', 'debug']) logger[k] = () => {};

const app = require(path.join(SRC, 'app'));

// ─── Paystack fetch stub ──────────────────────────────────────────────────────
const realFetch = global.fetch;
const paystack = { calls: [], initialize: null, verify: null };
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.paystack.co')) {
    paystack.calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    const data = String(url).includes('/initialize') ? paystack.initialize : paystack.verify;
    return { json: async () => data };
  }
  return realFetch(url, opts);
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
let server, base, ipCounter = 0;

async function listen() {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const close = () => new Promise(r => server.close(r));

// A fresh X-Forwarded-For per request so the in-memory rate limiters never interfere.
async function request(method, url, body, headers = {}) {
  const res = await realFetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${++ipCounter}`, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: json };
}

function sign(rawBody, secret) {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

// Sets env vars for one test and returns a restore function.
function withEnv(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

module.exports = { Run, bot, paystack, SEMESTER, listen, close, request, sign, withEnv, jobManager: () => require(path.join(SRC, 'services', 'jobManager')) };
