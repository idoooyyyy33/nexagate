import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type AuthUser, type Role } from '../services/auth.js';
import { db } from '../services/db/index.js';

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Autentikasi diperlukan' });
  try {
    const user = verifyToken(token);
    const current = db.prepare('SELECT username, role, active FROM users WHERE id = ?').get(user.id) as
      { username: string; role: Role; active: number } | undefined;
    if (!current?.active) return res.status(401).json({ error: 'Sesi tidak valid atau kedaluwarsa' });
    req.user = { id: user.id, username: current.username, role: current.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'Sesi tidak valid atau kedaluwarsa' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Akses ditolak' });
    return next();
  };
}
