import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedAt } from './schedule.js';

test('access schedule respects timezone, weekday boundaries and inclusive validity start', () => {
  const slots = [{ weekday: 1, start_time: '08:00', end_time: '17:00' }];
  const mondayAtJakartaNine = new Date('2026-11-23T02:00:00.000Z');
  assert.equal(isAllowedAt(mondayAtJakartaNine, '2026-11-23T02:00:00.000Z', null, slots, 'Asia/Jakarta'), true);
  assert.equal(isAllowedAt(new Date('2026-11-23T00:59:00.000Z'), null, null, slots, 'Asia/Jakarta'), false);
  assert.equal(isAllowedAt(mondayAtJakartaNine, null, '2026-11-23T01:59:59.000Z', slots, 'Asia/Jakarta'), false);
});

test('an empty schedule allows access during its validity period', () => {
  assert.equal(isAllowedAt(new Date('2026-11-23T02:00:00.000Z'), null, null, [], 'Asia/Jakarta'), true);
});
