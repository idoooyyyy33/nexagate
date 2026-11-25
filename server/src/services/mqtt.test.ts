import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from './db/index.js';
import { handleMessage } from './mqtt/index.js';

test('MQTT log receiver maps device topic and records server receipt time', async () => {
  const deviceId = randomUUID();
  const prefix = `tests/${deviceId}`;
  db.prepare(`INSERT INTO devices (id, name, topic_prefix, created_at) VALUES (?, ?, ?, ?)`)
    .run(deviceId, 'Test Door', prefix, new Date().toISOString());
  const before = Date.now();
  await handleMessage(`${prefix}/log`, JSON.stringify({
    uid: 'F93F8429', status: 'DITERIMA', gagal: 0, t: 120
  }));
  const row = db.prepare(`SELECT received_at, device_uptime_seconds, uid_masked FROM access_logs WHERE device_id = ?`)
    .get(deviceId) as { received_at: string; device_uptime_seconds: number; uid_masked: string };
  assert.ok(Date.parse(row.received_at) >= before);
  assert.equal(row.device_uptime_seconds, 120);
  assert.equal(row.uid_masked, '****8429');
});

test('MQTT log receiver rejects invalid payloads without persisting them', async () => {
  const deviceId = randomUUID();
  const prefix = `tests/${deviceId}`;
  db.prepare(`INSERT INTO devices (id, name, topic_prefix, created_at) VALUES (?, ?, ?, ?)`)
    .run(deviceId, 'Invalid Test Door', prefix, new Date().toISOString());
  await handleMessage(`${prefix}/log`, JSON.stringify({ uid: 'bad uid', status: 'ALLOW', gagal: -1, t: -1 }));
  const count = (db.prepare('SELECT COUNT(*) AS count FROM access_logs WHERE device_id = ?').get(deviceId) as { count: number }).count;
  assert.equal(count, 0);
});
