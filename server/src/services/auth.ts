import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from './db/index.js';

export type Role = 'admin' | 'operator' | 'viewer';
export type AuthUser = { id: string; username: string; role: Role };

export async function ensureBootstrapAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(config.BOOTSTRAP_ADMIN_USERNAME);
  if (existing) return;
  const hash = await argon2.hash(config.BOOTSTRAP_ADMIN_PASSWORD, { type: argon2.argon2id });
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), config.BOOTSTRAP_ADMIN_USERNAME, hash, 'admin', new Date().toISOString());
}

export function signToken(user: AuthUser) {
  return jwt.sign({ ...user, sub: user.id }, config.JWT_SECRET, { expiresIn: '8h', issuer: 'rfid-lock-manager' });
}

export function verifyToken(token: string): AuthUser {
  const decoded = jwt.verify(token, config.JWT_SECRET, { issuer: 'rfid-lock-manager' });
  if (typeof decoded === 'string' || !decoded.sub || !decoded.username || !decoded.role) {
    throw new Error('Invalid session token');
  }
  return { id: String(decoded.sub), username: String(decoded.username), role: decoded.role as Role };
}
