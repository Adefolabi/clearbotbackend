'use strict';

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const ADMIN  = 'admin-secret-value';
const auth   = { 'X-Admin-Secret': ADMIN };
const TESTER = 'BU22CSC1081';

let restoreEnv;
before(h.listen);
after(h.close);
beforeEach(() => {
  h.Run.reset();
  h.FreeTester.reset();
  h.bot.calls.length = 0;
  h.bot.hang = false;
  h.paystack.calls.length = 0;
  restoreEnv?.();
  restoreEnv = h.withEnv({ ADMIN_SECRET: ADMIN, PAYSTACK_SECRET_KEY: 'sk_test_x', NODE_ENV: 'test', FREE_MATRICS: undefined });
});

test('admin routes reject a missing or wrong secret', async () => {
  for (const headers of [{}, { 'X-Admin-Secret': 'wrong' }]) {
    assert.equal((await h.request('GET', '/api/admin/testers', undefined, headers)).status, 401);
    assert.equal((await h.request('POST', '/api/admin/testers', { matricNumber: TESTER }, headers)).status, 401);
    assert.equal((await h.request('DELETE', `/api/admin/testers/${TESTER}`, undefined, headers)).status, 401);
  }
  assert.equal(h.FreeTester.docs.length, 0);
});

test('admin routes are disabled when ADMIN_SECRET is unset', async () => {
  restoreEnv(); restoreEnv = h.withEnv({ ADMIN_SECRET: undefined });
  assert.equal((await h.request('GET', '/api/admin/testers', undefined, { 'X-Admin-Secret': '' })).status, 401);
});

test('add, list and remove a tester', async () => {
  const add = await h.request('POST', '/api/admin/testers', { matricNumber: ' bu22csc1081 ', note: 'owner' }, auth);
  assert.equal(add.status, 201);
  assert.equal(add.body.matricNumber, TESTER);

  const again = await h.request('POST', '/api/admin/testers', { matricNumber: TESTER }, auth);
  assert.equal(again.status, 200);
  assert.equal(again.body.added, false);

  const list = await h.request('GET', '/api/admin/testers', undefined, auth);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.testers.map(t => t.matricNumber), [TESTER]);

  const del = await h.request('DELETE', '/api/admin/testers/bu22csc1081', undefined, auth);
  assert.equal(del.status, 200);
  assert.equal((await h.request('DELETE', `/api/admin/testers/${TESTER}`, undefined, auth)).status, 404);
});

test('add rejects a malformed matric', async () => {
  const r = await h.request('POST', '/api/admin/testers', { matricNumber: 'nope' }, auth);
  assert.equal(r.status, 400);
});

test('a DB-listed tester skips payment on /initiate and /start; removing them restores the paywall', async () => {
  await h.request('POST', '/api/admin/testers', { matricNumber: TESTER }, auth);

  const init = await h.request('POST', '/api/payment/initiate', { matricNumber: TESTER });
  assert.equal(init.body.alreadyPaid, true);
  assert.equal(h.paystack.calls.length, 0);

  const start = await h.request('POST', '/api/assessment/start',
    { matricNumber: TESTER, password: 'secret1', campus: 'Iwo Campus', defaultRating: 3 });
  assert.equal(start.status, 200);
  assert.equal(h.bot.calls.length, 1);

  await h.request('DELETE', `/api/admin/testers/${TESTER}`, undefined, auth);
  const after = await h.request('POST', '/api/assessment/start',
    { matricNumber: TESTER, password: 'secret1', campus: 'Iwo Campus', defaultRating: 3 });
  assert.equal(after.status, 402);
});

test('a DB failure during the tester lookup fails closed (payment still required)', async () => {
  h.FreeTester.fail = true;
  const r = await h.request('POST', '/api/assessment/start',
    { matricNumber: TESTER, password: 'secret1', campus: 'Iwo Campus', defaultRating: 3 });
  assert.equal(r.status, 402);
  assert.equal(h.bot.calls.length, 0);
});
