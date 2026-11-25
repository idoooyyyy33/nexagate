import test from 'node:test';
import assert from 'node:assert/strict';
import { addLocalDays, localDateKey, utcAtLocalMidnight } from './time.js';

test('local-day boundaries use the configured device timezone', () => {
  const date = new Date('2026-11-23T17:00:00.000Z');
  assert.equal(localDateKey(date, 'Asia/Jakarta'), '2026-11-24');
  assert.equal(utcAtLocalMidnight('2026-11-24', 'Asia/Jakarta'), '2026-11-23T17:00:00.000Z');
  assert.equal(addLocalDays('2026-11-24', -1), '2026-11-23');
});
