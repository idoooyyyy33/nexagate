import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { once } from 'node:events';
import { signToken, verifyToken } from './auth.js';
import { app } from '../app.js';
import { ensureBootstrapAdmin } from './auth.js';

test('password hashes and session tokens authenticate the expected role', async () => {
  const hash = await argon2.hash('correct-horse-battery-staple');
  assert.equal(await argon2.verify(hash, 'correct-horse-battery-staple'), true);
  assert.equal(await argon2.verify(hash, 'wrong-password'), false);

  const token = signToken({ id: 'user-id', username: 'operator', role: 'operator' });
  assert.deepEqual(verifyToken(token), { id: 'user-id', username: 'operator', role: 'operator' });
});

test('HTTP login establishes an HttpOnly session and role gates privileged routes', async () => {
  await ensureBootstrapAdmin();
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const origin = 'http://localhost:5173';
  try {
    const invalid = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'wrong-password' })
    });
    assert.equal(invalid.status, 401);

    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'test-admin-password-123' })
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get('set-cookie');
    assert.ok(adminCookie?.includes('HttpOnly'));
    const cookie = adminCookie?.split(';')[0] ?? '';

    const created = await fetch(`${base}/api/users`, {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-viewer', password: 'test-viewer-password-123', role: 'viewer' })
    });
    assert.equal(created.status, 201);

    const viewerLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-viewer', password: 'test-viewer-password-123' })
    });
    const viewerCookie = viewerLogin.headers.get('set-cookie')?.split(';')[0] ?? '';
    const denied = await fetch(`${base}/api/audit-logs`, { headers: { cookie: viewerCookie } });
    assert.equal(denied.status, 403);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
