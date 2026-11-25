'use strict';

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const MATRIC = 'BU22CSC1081';
const AMOUNT = 200000;
const PS_KEY = 'sk_test_key';
const ADMIN  = 'admin-secret-value';

let restoreEnv;
before(h.listen);
after(h.close);
beforeEach(() => {
  h.Run.reset();
  h.paystack.calls.length = 0;
  h.paystack.initialize = { status: true, data: {} };
  h.paystack.verify = { status: true, data: { status: 'success', amount: AMOUNT } };
  restoreEnv?.();
  restoreEnv = h.withEnv({ PAYSTACK_SECRET_KEY: PS_KEY, ADMIN_SECRET: ADMIN, NODE_ENV: 'test' });
});

const unpaidRun = (over = {}) => new h.Run({ matricNumber: MATRIC, semester: h.SEMESTER, ...over });

// ─── POST /initiate ───────────────────────────────────────────────────────────
test('initiate: rejects missing or malformed matric', async () => {
  for (const matricNumber of [undefined, 123, 'nope', { $ne: '' }]) {
    const r = await h.request('POST', '/api/payment/initiate', { matricNumber });
    assert.equal(r.status, 400, JSON.stringify(matricNumber));
  }
  assert.equal(h.paystack.calls.length, 0);
});

test('regression: non-string email returns 400 instead of crashing the process', async () => {
  for (const email of [{}, [], 42, true]) {
    const r = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC, email });
    assert.equal(r.status, 400);
  }
  // still alive
  const ok = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC });
  assert.equal(ok.status, 200);
});

test('initiate: creates a Run and asks Paystack for exactly ₦2,000', async () => {
  const r = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC.toLowerCase() });
  assert.equal(r.status, 200);
  assert.equal(r.body.amount, AMOUNT);
  assert.equal(r.body.email, 'bu22csc1081@clearbot.ng');
  assert.match(r.body.reference, /^cb-bu22csc1081-\d+$/);
  const sent = h.paystack.calls[0].body;
  assert.equal(sent.amount, AMOUNT);
  assert.equal(sent.metadata.matricNumber, MATRIC);
  assert.equal(h.Run.docs.length, 1);
  assert.equal(h.Run.docs[0].paystackRef, r.body.reference);
});

test('initiate: uses a valid supplied email, ignores an invalid one', async () => {
  const good = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC, email: ' a@b.com ' });
  assert.equal(good.body.email, 'a@b.com');
  const bad = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC, email: 'not-an-email' });
  assert.equal(bad.body.email, 'bu22csc1081@clearbot.ng');
});

test('initiate: retrying reuses the same unpaid Run (idempotent)', async () => {
  await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC });
  await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC });
  assert.equal(h.Run.docs.length, 1);
});

test('initiate: already-paid student short-circuits without calling Paystack', async () => {
  await unpaidRun({ paid: true }).save();
  const r = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC });
  assert.deepEqual(r.body, { alreadyPaid: true });
  assert.equal(h.paystack.calls.length, 0);
});

test('initiate: Paystack failure gives 502', async () => {
  h.paystack.initialize = { status: false, message: 'boom' };
  const r = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC });
  assert.equal(r.status, 502);
});

// ─── GET /status/:reference ───────────────────────────────────────────────────
test('status: successful verification marks the Run paid', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  const r = await h.request('GET', '/api/payment/status/ref1');
  assert.deepEqual(r.body, { paid: true, runCompleted: false });
  assert.equal(run.paid, true);
  assert.ok(run.paidAt instanceof Date);
});

test('status: pending/failed Paystack transaction is not paid', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  h.paystack.verify = { status: true, data: { status: 'abandoned', amount: AMOUNT } };
  const r = await h.request('GET', '/api/payment/status/ref1');
  assert.equal(r.body.paid, false);
  assert.equal(run.paid, false);
});

test('status: wrong amount is rejected (no ₦1 purchases)', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  h.paystack.verify = { status: true, data: { status: 'success', amount: 100 } };
  const r = await h.request('GET', '/api/payment/status/ref1');
  assert.equal(r.body.paid, false);
  assert.equal(run.paid, false);
});

test('status: falls back to Paystack metadata when paystackRef was overwritten', async () => {
  const run = unpaidRun({ paystackRef: 'newer-ref' }); await run.save();
  h.paystack.verify = { status: true, data: { status: 'success', amount: AMOUNT, metadata: { matricNumber: MATRIC, semester: h.SEMESTER } } };
  const r = await h.request('GET', '/api/payment/status/old-ref');
  assert.equal(r.body.paid, true);
  assert.equal(run.paid, true);
  assert.equal(run.paystackRef, 'old-ref');
});

test('status: paid on Paystack but no matching Run reports paid without crashing', async () => {
  const r = await h.request('GET', '/api/payment/status/ghost');
  assert.deepEqual(r.body, { paid: true, runCompleted: false });
});

test('status: oversized reference is rejected', async () => {
  const r = await h.request('GET', `/api/payment/status/${'x'.repeat(121)}`);
  assert.equal(r.status, 400);
});

// ─── POST /webhook ────────────────────────────────────────────────────────────
function webhook(event, { secret = PS_KEY, signature } = {}) {
  const raw = JSON.stringify(event);
  return h.request('POST', '/api/payment/webhook', raw, {
    'x-paystack-signature': signature ?? h.sign(raw, secret),
  });
}
const chargeSuccess = (over = {}) => ({ event: 'charge.success', data: { reference: 'ref1', amount: AMOUNT, ...over } });

test('webhook: valid signature + correct amount marks the Run paid', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  const r = await webhook(chargeSuccess());
  assert.equal(r.status, 200);
  assert.equal(run.paid, true);
});

test('webhook: bad signature, missing signature, or missing server key → 401, nothing changes', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  assert.equal((await webhook(chargeSuccess(), { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(chargeSuccess(), { signature: 'zz' })).status, 401);
  assert.equal((await h.request('POST', '/api/payment/webhook', JSON.stringify(chargeSuccess()))).status, 401);
  restoreEnv(); restoreEnv = h.withEnv({ PAYSTACK_SECRET_KEY: undefined });
  assert.equal((await webhook(chargeSuccess())).status, 401);
  assert.equal(run.paid, false);
});

test('webhook: wrong amount is ignored but still acknowledged with 200', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  const r = await webhook(chargeSuccess({ amount: 500 }));
  assert.equal(r.status, 200);
  assert.equal(run.paid, false);
});

test('webhook: other event types are acknowledged and ignored', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  const r = await webhook({ event: 'charge.failed', data: { reference: 'ref1', amount: AMOUNT } });
  assert.equal(r.status, 200);
  assert.equal(run.paid, false);
});

test('webhook: metadata fallback when paystackRef was overwritten', async () => {
  const run = unpaidRun({ paystackRef: 'newer' }); await run.save();
  const r = await webhook(chargeSuccess({ metadata: { matricNumber: MATRIC, semester: h.SEMESTER } }));
  assert.equal(r.status, 200);
  assert.equal(run.paid, true);
});

// ─── POST /recover ────────────────────────────────────────────────────────────
const recover = (body) => h.request('POST', '/api/payment/recover', body);

test('recover: wrong, missing or non-string secret → 401', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  for (const secret of ['nope', undefined, '', 123, { $ne: 1 }]) {
    assert.equal((await recover({ secret, matricNumber: MATRIC })).status, 401);
  }
  assert.equal(run.paid, false);
});

test('recover: 401 when ADMIN_SECRET is not configured, even if the body secret is empty or "undefined"', async () => {
  restoreEnv(); restoreEnv = h.withEnv({ PAYSTACK_SECRET_KEY: PS_KEY, ADMIN_SECRET: undefined });
  for (const secret of ['', 'undefined', undefined]) {
    assert.equal((await recover({ secret, matricNumber: MATRIC })).status, 401);
  }
});

test('recover: refuses to run without a Paystack key (cannot verify)', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  restoreEnv(); restoreEnv = h.withEnv({ PAYSTACK_SECRET_KEY: undefined, ADMIN_SECRET: ADMIN });
  const r = await recover({ secret: ADMIN, matricNumber: MATRIC });
  assert.equal(r.status, 503);
  assert.equal(run.paid, false);
});

test('recover: verified payment is marked paid, using a supplied reference', async () => {
  const run = unpaidRun({ paystackRef: 'stale' }); await run.save();
  const r = await recover({ secret: ADMIN, matricNumber: MATRIC, reference: 'real-ref' });
  assert.equal(r.status, 200);
  assert.equal(r.body.recovered, true);
  assert.equal(run.paid, true);
  assert.equal(run.paystackRef, 'real-ref');
  assert.ok(h.paystack.calls[0].url.endsWith('/verify/real-ref'));
});

test('recover: Paystack not confirming → 402 and nothing marked paid', async () => {
  const run = unpaidRun({ paystackRef: 'ref1' }); await run.save();
  h.paystack.verify = { status: true, data: { status: 'failed', amount: AMOUNT } };
  assert.equal((await recover({ secret: ADMIN, matricNumber: MATRIC })).status, 402);
  h.paystack.verify = { status: true, data: { status: 'success', amount: 1 } };
  assert.equal((await recover({ secret: ADMIN, matricNumber: MATRIC })).status, 402);
  assert.equal(run.paid, false);
});

test('recover: already paid, unknown matric, and non-string reference are handled', async () => {
  await unpaidRun({ paid: true }).save();
  assert.equal((await recover({ secret: ADMIN, matricNumber: MATRIC })).body.alreadyPaid, true);
  h.Run.reset();
  assert.equal((await recover({ secret: ADMIN, matricNumber: 'BU22CSC0000' })).status, 404);
  await unpaidRun({ paystackRef: 'ref1' }).save();
  const r = await recover({ secret: ADMIN, matricNumber: MATRIC, reference: { x: 1 } });
  assert.equal(r.status, 200); // falls back to stored reference instead of throwing
});

test('initiate: FREE_MATRICS matric gets alreadyPaid without touching Paystack', async () => {
  const undo = h.withEnv({ FREE_MATRICS: 'BU22CSC1081' });
  try {
    const r = await h.request('POST', '/api/payment/initiate', { matricNumber: MATRIC.toLowerCase() });
    assert.equal(r.status, 200);
    assert.equal(r.body.alreadyPaid, true);
    assert.equal(h.paystack.calls.length, 0);
  } finally {
    undo();
  }
});
