import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { config } from './config.js';
import { router } from './routes/index.js';
import { errorHandler } from './middleware/errors.js';
import { verifyToken } from './services/auth.js';
import { db } from './services/db/index.js';
import { startMqtt } from './services/mqtt/index.js';
import { notify } from './services/notify/index.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.headers.origin &&
    req.headers.origin !== config.WEB_ORIGIN) {
    return res.status(403).json({ error: 'Origin tidak diizinkan' });
  }
  return next();
});
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false
}), router);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));

const webDistDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (config.NODE_ENV === 'production' && existsSync(resolve(webDistDir, 'index.html'))) {
  app.use(express.static(webDistDir));
  app.get('*', (_req, res) => res.sendFile(resolve(webDistDir, 'index.html')));
} else {
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));
}
app.use(errorHandler);

export function attachRealtime(server: import('node:http').Server) {
  const io = new Server(server, { cors: { origin: config.WEB_ORIGIN, credentials: true } });
  io.use((socket, next) => {
    try {
      if (socket.handshake.headers.origin !== config.WEB_ORIGIN) return next(new Error('Unauthorized'));
      const sessionCookie = socket.handshake.headers.cookie?.split(';')
        .map((part) => part.trim()).find((part) => part.startsWith('session='));
      if (!sessionCookie) return next(new Error('Unauthorized'));
      const token = decodeURIComponent(sessionCookie.slice('session='.length));
      const user = verifyToken(token);
      const current = db.prepare('SELECT username, role, active FROM users WHERE id = ?').get(user.id) as
        { username: string; role: string; active: number } | undefined;
      if (!current?.active) return next(new Error('Unauthorized'));
      socket.data.user = { id: user.id, username: current.username, role: current.role };
      return next();
    } catch {
      return next(new Error('Unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const user = socket.data.user as { role: string };
    const deviceIds = db.prepare('SELECT id FROM devices').all() as { id: string }[];
    for (const device of deviceIds) {
      socket.join(`device:${device.id}`);
      if (user.role === 'admin') socket.join(`device:${device.id}:admins`);
    }
  });
  return io;
}

export async function initializeData() {
  const { ensureBootstrapAdmin } = await import('./services/auth.js');
  await ensureBootstrapAdmin();
  db.prepare("UPDATE commands SET status = 'timeout', result = 'server_restarted', completed_at = ? WHERE status = 'pending'")
    .run(new Date().toISOString());
  const exists = db.prepare('SELECT id FROM devices WHERE topic_prefix = ?').get(config.DEFAULT_DEVICE_TOPIC_PREFIX);
  if (!exists) {
    db.prepare(`INSERT INTO devices (id, name, topic_prefix, timezone, created_at)
      VALUES (?, ?, ?, 'Asia/Jakarta', ?)`)
      .run(randomUUID(), config.DEFAULT_DEVICE_NAME, config.DEFAULT_DEVICE_TOPIC_PREFIX, new Date().toISOString());
  }
}

export function initializeMqtt(io: Server) {
  startMqtt(io);
  const notifiedOffline = new Set<string>();
  const interval = setInterval(() => {
    const devices = db.prepare('SELECT id, name, last_seen_at FROM devices').all() as
      { id: string; name: string; last_seen_at: string | null }[];
    for (const device of devices) {
      const offline = !device.last_seen_at ||
        Date.now() - Date.parse(device.last_seen_at) > config.OFFLINE_THRESHOLD_MINUTES * 60_000;
      if (offline && !notifiedOffline.has(device.id)) {
        notifiedOffline.add(device.id);
        const previous = db.prepare(`SELECT created_at FROM notifications WHERE device_id = ?
          AND kind = 'device_offline' ORDER BY created_at DESC LIMIT 1`).get(device.id) as { created_at: string } | undefined;
        if (!previous || (device.last_seen_at && Date.parse(previous.created_at) < Date.parse(device.last_seen_at))) {
          void notify('device_offline', `${device.name} offline lebih dari ${config.OFFLINE_THRESHOLD_MINUTES} menit`, device.id)
            .catch((error: unknown) => console.error('Offline notification failed:', error));
        }
      }
      if (!offline) notifiedOffline.delete(device.id);
    }
  }, 60_000);
  interval.unref();
}
