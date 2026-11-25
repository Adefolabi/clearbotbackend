'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { getCurrentSemester } = require('../src/services/db');

let saved;
beforeEach(() => { saved = process.env.CURRENT_SEMESTER; delete process.env.CURRENT_SEMESTER; });
afterEach(() => { if (saved === undefined) delete process.env.CURRENT_SEMESTER; else process.env.CURRENT_SEMESTER = saved; });

test('CURRENT_SEMESTER overrides the date-based value', () => {
  process.env.CURRENT_SEMESTER = '2026_2027_1st';
  assert.equal(getCurrentSemester(), '2026_2027_1st');
});

test('an unset or empty CURRENT_SEMESTER falls back to the date-based value', () => {
  assert.match(getCurrentSemester(), /^\d{4}_\d{4}_(1st|2nd)$/);
  process.env.CURRENT_SEMESTER = '';
  assert.match(getCurrentSemester(), /^\d{4}_\d{4}_(1st|2nd)$/);
});

test('a malformed CURRENT_SEMESTER throws instead of silently falling back', () => {
  for (const bad of ['26/27 1st', '2026_2027', '2026_2027_3rd', ' 2026_2027_1st']) {
    process.env.CURRENT_SEMESTER = bad;
    assert.throws(() => getCurrentSemester(), /CURRENT_SEMESTER/, bad);
  }
});

test('date-based value: Nov 2026 is 2026_2027_1st, Feb 2027 is 2026_2027_2nd', () => {
  const RealDate = Date;
  try {
    for (const [iso, expected] of [['2026-11-23T12:00:00Z', '2026_2027_1st'], ['2027-01-15T12:00:00Z', '2026_2027_1st'], ['2027-02-02T12:00:00Z', '2026_2027_2nd']]) {
      global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [iso])); } };
      assert.equal(getCurrentSemester(), expected, iso);
    }
  } finally { global.Date = RealDate; }
});
