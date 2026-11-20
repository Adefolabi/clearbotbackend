'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeNoPendingRows } = require('../src/services/bot');

test('skip message says already assessed when Assessed rows exist', () => {
  assert.match(describeNoPendingRows('AES 531', 2), /AES 531 — already assessed, skipping/);
});

test('skip message says Lecturer not assigned when the page has no rows at all', () => {
  const msg = describeNoPendingRows('AES 598', 0);
  assert.match(msg, /AES 598 — Lecturer not assigned/);
  assert.doesNotMatch(msg, /already assessed/);
});

const { countLecturerRows } = require('../src/services/bot');

test('countLecturerRows counts lecturer rows, ignoring Teaching Environment and headers', () => {
  const rows = [
    'S/N Assessment Action/Status',
    '1. Dr Christiana Afolabi Assess',
    '2 Teaching Environment Assess',
  ];
  assert.equal(countLecturerRows(rows), 1);
});

test('countLecturerRows is 0 when only Teaching Environment exists (no lecturer connected)', () => {
  assert.equal(countLecturerRows(['S/N Assessment Action/Status', '1 Teaching Environment Assessed']), 0);
  assert.equal(countLecturerRows([]), 0);
});

test('countLecturerRows counts already-assessed lecturers too', () => {
  assert.equal(countLecturerRows(['1. Dr A B Assessed', '2. Dr C D Assessed', '3 Teaching Environment Assessed']), 2);
});
