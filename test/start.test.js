'use strict';

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const MATRIC = 'BU22CSC1081';
const valid = (over = {}) => ({ matricNumber: MATRIC, password: 'secret1', campus: 'Iwo Campus', defaultRating: 3, ...over });
const paidRun = (matric = MATRIC) => new h.Run({ matricNumber: matric, semester: h.SEMESTER, paid: true });

let restoreEnv;
before(h.listen);
after(h.close);
beforeEach(() => {
  h.Run.reset();
  h.bot.calls.length = 0;
  h.bot.hang = false;
  restoreEnv?.();
  restoreEnv = h.withEnv({ PAYSTACK_SECRET_KEY: 'sk_test_x', NODE_ENV: 'test' });
});

test('400 on invalid body, bot never runs', async () => {
  const r = await h.request('POST', '/api/assessment/start', valid({ matricNumber: 'bad', defaultRating: 9 }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Validation failed');
  assert.equal(h.bot.calls.length, 0);
});

test('campus must be one the portal offers (Abuja was removed)', async () => {
  await paidRun().save();
  for (const campus of ['Abuja Campus', 'iwo campus', '']) {
    const r = await h.request('POST', '/api/assessment/start', valid({ campus }));
    assert.equal(r.status, 400, campus);
  }
  for (const campus of ['Iwo Campus', 'Ogbomosho Campus']) {
    const r = await h.request('POST', '/api/assessment/start', valid({ campus, matricNumber: campus === 'Iwo Campus' ? MATRIC : 'BU22CSC1082' }));
    assert.notEqual(r.status, 400, campus);
  }
  assert.equal(h.bot.calls.length, 1); // only the paid matric launched
});

test('402 when the student has not paid, no job started, matric not left locked', async () => {
  const r = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(r.status, 402);
  assert.equal(h.bot.calls.length, 0);
  assert.equal(h.jobManager().isMatricActive(MATRIC), false);
});

test('200 when paid: starts bot with credentials and links jobId to the Run', async () => {
  const run = paidRun();
  await run.save();
  const r = await h.request('POST', '/api/assessment/start', valid({ perCourseRatings: { 'CSC 406': 4 } }));
  assert.equal(r.status, 200);
  assert.match(r.body.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(run.jobId, r.body.jobId);
  assert.equal(h.bot.calls.length, 1);
  assert.equal(h.bot.calls[0].credentials.password, 'secret1');
  assert.deepEqual(h.bot.calls[0].ratings.perCourseRatings, { 'CSC 406': 4 });
  assert.equal(h.bot.calls[0].dryRun, false);
});

test('dryRun only honoured when it is boolean true', async () => {
  await paidRun().save();
  await h.request('POST', '/api/assessment/start', valid({ dryRun: 'true' }));
  assert.equal(h.bot.calls[0].dryRun, false);
});

test('paid status for a different semester or matric does not count', async () => {
  await new h.Run({ matricNumber: MATRIC, semester: '1999_2000_1st', paid: true }).save();
  await paidRun('BU22CSC9999').save();
  const r = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(r.status, 402);
});

test('409 while a job is already active for the same matric', async () => {
  await paidRun().save();
  h.bot.hang = true;
  const first = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(first.status, 200);
  const second = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(second.status, 409);
  assert.equal(h.bot.calls.length, 1);
  // lock is case-insensitive
  const third = await h.request('POST', '/api/assessment/start', valid({ matricNumber: MATRIC.toLowerCase() }));
  assert.equal(third.status, 409);
  h.jobManager().unlockMatric(MATRIC);
});

test('regression: DB failure during payment check returns 500, releases the lock, and does not crash', async () => {
  h.Run.failFind = true;
  const r = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(r.status, 500);
  assert.equal(h.jobManager().isMatricActive(MATRIC), false);
  assert.equal(h.bot.calls.length, 0);
  // Server is still serving and the same matric can retry once the DB recovers.
  h.Run.failFind = false;
  await paidRun().save();
  const retry = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(retry.status, 200);
});

test('regression: failure saving jobId releases the lock and the bot never starts', async () => {
  await paidRun().save();
  h.Run.failSave = true;
  const r = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(r.status, 500);
  assert.equal(h.bot.calls.length, 0);
  assert.equal(h.jobManager().isMatricActive(MATRIC), false);
});

test('fails closed in production when PAYSTACK_SECRET_KEY is missing', async () => {
  restoreEnv(); restoreEnv = h.withEnv({ PAYSTACK_SECRET_KEY: undefined, NODE_ENV: 'production' });
  const r = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(r.status, 503);
  assert.equal(h.bot.calls.length, 0);
  assert.equal(h.jobManager().isMatricActive(MATRIC), false);
});

test('dev mode (non-production, no Paystack key) skips the payment check', async () => {
  restoreEnv(); restoreEnv = h.withEnv({ PAYSTACK_SECRET_KEY: undefined, NODE_ENV: 'test' });
  const r = await h.request('POST', '/api/assessment/start', valid());
  assert.equal(r.status, 200);
});

test('503 when the server is at capacity', async () => {
  const jm = h.jobManager();
  h.bot.hang = true;
  const matrics = [];
  for (let i = 0; jm.getRunningJobCount() < jm.MAX_CONCURRENT_JOBS; i++) {
    const m = `BU22CSC${String(2000 + i)}`;
    matrics.push(m);
    await paidRun(m).save();
    const r = await h.request('POST', '/api/assessment/start', valid({ matricNumber: m }));
    assert.equal(r.status, 200);
  }
  await paidRun('BU22CSC7777').save();
  const over = await h.request('POST', '/api/assessment/start', valid({ matricNumber: 'BU22CSC7777' }));
  assert.equal(over.status, 503);
  matrics.forEach(m => jm.unlockMatric(m));
});

test('unknown job id on the SSE endpoint is 404', async () => {
  const r = await h.request('GET', '/api/assessment/progress/does-not-exist');
  assert.equal(r.status, 404);
});

test('FREE_MATRICS: listed matric starts without payment; others still need to pay', async () => {
  const undo = h.withEnv({ FREE_MATRICS: ' bu22csc1081 , BU21ABC1234' });
  try {
    const free = await h.request('POST', '/api/assessment/start', valid());
    assert.equal(free.status, 200);
    assert.equal(h.bot.calls.length, 1);

    const other = await h.request('POST', '/api/assessment/start', valid({ matricNumber: 'BU22CSC9999' }));
    assert.equal(other.status, 402);
    assert.equal(h.bot.calls.length, 1);
  } finally {
    undo();
  }
});
