import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../services/db/index.js';
import { isAllowedAt } from '../services/schedule.js';
import { maskUid, protectUid, revealUid } from '../services/crypto.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { signToken } from '../services/auth.js';
import { sendCommand, subscribeDevice, syncDeviceCards, unsubscribeDevice } from '../services/mqtt/index.js';
import { addLocalDays, localDateKey, utcAtLocalMidnight, zonedDayAndHour } from '../services/time.js';
import { getGmailSettingsStatus, isGmailAlertConfigured, saveGmailSettings, sendAlertEmail, sendOtpEmail, sendWelcomeEmail } from '../services/notify/index.js';
import { getSyncStatus, syncNow } from '../services/sync/supabase.js';

export const router = Router();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const isoNow = () => new Date().toISOString();
const id = () => randomUUID();
const pathId = (req: Request) => z.string().uuid().parse(req.params.id);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.' }
});

const pendingLoginOtps = new Map<string, { userId: string; email: string; code: string; expiresAt: number; attempts: number }>();

function maskEmailAddress(email: string) {
  const [local = '', domain = ''] = email.split('@');
  if (local.length <= 2) return `${local[0] ?? '*'}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

async function issueLoginOtpChallenge(user: { id: string; username: string; email: string }) {
  const challengeId = id();
  const code = String(randomInt(100000, 1000000));
  pendingLoginOtps.set(challengeId, {
    userId: user.id,
    email: user.email,
    code,
    expiresAt: Date.now() + 10 * 60_000,
    attempts: 0
  });
  await sendOtpEmail(user.email, code, user.username);
  const otpToken = jwt.sign({ challengeId, userId: user.id }, config.JWT_SECRET, { expiresIn: '10m' });
  return { otpToken, email: maskEmailAddress(user.email) };
}

router.post('/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const body = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) }).parse(req.body);
  const user = db.prepare('SELECT id, username, email, password_hash, role, active, login_otp_required FROM users WHERE username = ?')
    .get(body.username) as { id: string; username: string; email: string | null; password_hash: string; role: 'admin' | 'operator' | 'viewer'; active: number; login_otp_required: number } | undefined;
  const valid = user ? await argon2.verify(user.password_hash, body.password) : false;
  db.prepare('INSERT INTO login_attempts (username, ip_address, attempted_at, succeeded) VALUES (?, ?, ?, ?)')
    .run(body.username, req.ip, isoNow(), valid ? 1 : 0);
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-30 days')").run();
  if (!valid || !user?.active) return res.status(401).json({ error: 'Nama pengguna atau kata sandi salah' });
  if (user.login_otp_required === 1 && user.email && isGmailAlertConfigured()) {
    const challenge = await issueLoginOtpChallenge({ id: user.id, username: user.username, email: user.email });
    return res.json({ otpRequired: true, ...challenge });
  }
  res.cookie('session', signToken({ id: user.id, username: user.username, role: user.role }), {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000, path: '/'
  });
  return res.json({ user: { id: user.id, username: user.username, role: user.role } });
}));

router.post('/auth/verify-login-otp', loginLimiter, (req, res) => {
  const body = z.object({
    otpToken: z.string().min(10),
    code: z.string().trim().regex(/^\d{6}$/, 'Kode OTP harus 6 digit angka')
  }).parse(req.body);
  let decoded: { challengeId?: string; userId?: string };
  try {
    decoded = jwt.verify(body.otpToken, config.JWT_SECRET) as { challengeId?: string; userId?: string };
  } catch {
    return res.status(400).json({ error: 'Sesi OTP kedaluwarsa. Silakan login ulang.' });
  }
  const challenge = decoded.challengeId ? pendingLoginOtps.get(decoded.challengeId) : undefined;
  if (!challenge || challenge.expiresAt < Date.now() || challenge.userId !== decoded.userId) {
    if (decoded.challengeId) pendingLoginOtps.delete(decoded.challengeId);
    return res.status(400).json({ error: 'Kode OTP kedaluwarsa. Silakan login ulang.' });
  }
  challenge.attempts += 1;
  if (challenge.attempts > 5) {
    pendingLoginOtps.delete(decoded.challengeId!);
    return res.status(429).json({ error: 'Terlalu banyak percobaan OTP. Silakan login ulang.' });
  }
  if (challenge.code !== body.code) {
    return res.status(400).json({ error: 'Kode OTP salah.' });
  }
  pendingLoginOtps.delete(decoded.challengeId!);
  db.prepare('UPDATE users SET login_otp_required = 0 WHERE id = ?').run(challenge.userId);
  const user = db.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(challenge.userId) as
    { id: string; username: string; role: 'admin' | 'operator' | 'viewer'; active: number } | undefined;
  if (!user?.active) return res.status(401).json({ error: 'Akun tidak aktif' });
  audit(req, 'user.login_otp_verified', user.id, { email: challenge.email });
  res.cookie('session', signToken({ id: user.id, username: user.username, role: user.role }), {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/'
  });
  return res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/auth/resend-login-otp', loginLimiter, asyncRoute(async (req, res) => {
  const body = z.object({ otpToken: z.string().min(10) }).parse(req.body);
  let decoded: { challengeId?: string; userId?: string };
  try {
    decoded = jwt.verify(body.otpToken, config.JWT_SECRET) as { challengeId?: string; userId?: string };
  } catch {
    return res.status(400).json({ error: 'Sesi OTP kedaluwarsa. Silakan login ulang.' });
  }
  const user = decoded.userId
    ? db.prepare('SELECT id, username, email, active FROM users WHERE id = ?').get(decoded.userId) as
      { id: string; username: string; email: string | null; active: number } | undefined
    : undefined;
  if (!user?.active || !user.email) return res.status(400).json({ error: 'Akun tidak valid' });
  if (decoded.challengeId) pendingLoginOtps.delete(decoded.challengeId);
  const challenge = await issueLoginOtpChallenge({ id: user.id, username: user.username, email: user.email });
  return res.json({ ok: true, ...challenge });
}));

router.post('/auth/logout', (_req, res) => {
  res.clearCookie('session', { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/' });
  res.status(204).end();
});
router.get('/auth/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, username, role, email FROM users WHERE id = ?').get(req.user!.id) as
    { id: string; username: string; role: string; email: string | null } | undefined;
  res.json({ user: row ?? req.user });
});

router.get('/auth/providers', (_req, res) => {
  res.json({ google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) });
});

function googleRedirectUri() {
  return config.GOOGLE_REDIRECT_URI || `${config.WEB_ORIGIN.replace(/\/+$/, '')}/api/auth/google/callback`;
}

function buildGoogleAuthUrl(state: string, forceConsent = false) {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: forceConsent ? 'consent select_account' : 'select_account'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

router.get('/auth/google', (_req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Login Google belum dikonfigurasi' });
  }
  const nonce = randomBytes(24).toString('base64url');
  const stateToken = jwt.sign({ nonce, mode: 'login' }, config.JWT_SECRET, { expiresIn: '5m' });
  res.cookie('oauth_state', stateToken, {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 5 * 60 * 1000, path: '/api/auth/google'
  });
  return res.redirect(buildGoogleAuthUrl(nonce));
});

router.get('/auth/google/link', requireAuth, (req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Integrasi Google belum dikonfigurasi' });
  }
  const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/') ? req.query.returnTo : '/';
  const nonce = randomBytes(24).toString('base64url');
  const stateToken = jwt.sign({ nonce, mode: 'link', userId: req.user!.id, returnTo }, config.JWT_SECRET, { expiresIn: '5m' });
  res.cookie('oauth_state', stateToken, {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 5 * 60 * 1000, path: '/api/auth/google'
  });
  return res.redirect(buildGoogleAuthUrl(nonce, true));
});

router.get('/auth/google/register', (_req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Pendaftaran Google belum dikonfigurasi' });
  }
  const nonce = randomBytes(24).toString('base64url');
  const stateToken = jwt.sign({ nonce, mode: 'register' }, config.JWT_SECRET, { expiresIn: '5m' });
  res.cookie('oauth_state', stateToken, {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 5 * 60 * 1000, path: '/api/auth/google'
  });
  return res.redirect(buildGoogleAuthUrl(nonce));
});

router.get('/auth/google/admin-add', requireAuth, requireRole('admin'), (req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Integrasi Google belum dikonfigurasi' });
  }
  const role = z.enum(['admin', 'operator', 'viewer']).catch('operator').parse(req.query.role);
  const nonce = randomBytes(24).toString('base64url');
  const stateToken = jwt.sign({ nonce, mode: 'admin_add', role, actorId: req.user!.id }, config.JWT_SECRET, { expiresIn: '5m' });
  res.cookie('oauth_state', stateToken, {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 5 * 60 * 1000, path: '/api/auth/google'
  });
  return res.redirect(buildGoogleAuthUrl(nonce, true));
});

router.post('/auth/google/unlink', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET email = NULL WHERE id = ?').run(req.user!.id);
  audit(req, 'user.unlink_google', req.user!.id, {});
  res.json({ ok: true });
});

router.get('/auth/google/callback', asyncRoute(async (req, res) => {
  const webBase = config.WEB_ORIGIN.replace(/\/+$/, '');
  const loginBase = `${webBase}/login`;
  const clearState = () => res.clearCookie('oauth_state', { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/api/auth/google' });
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    clearState();
    return res.redirect(`${loginBase}?error=google_disabled`);
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const rawStateCookie = typeof req.cookies?.oauth_state === 'string' ? req.cookies.oauth_state : '';
  clearState();
  let statePayload: { nonce?: string; mode?: 'login' | 'link' | 'register' | 'admin_add'; userId?: string; returnTo?: string; role?: 'admin' | 'operator' | 'viewer'; actorId?: string } = {};
  try {
    statePayload = jwt.verify(rawStateCookie, config.JWT_SECRET) as typeof statePayload;
  } catch {
    return res.redirect(`${loginBase}?error=google_state`);
  }
  if (!code || !state || state !== statePayload.nonce) {
    return res.redirect(`${loginBase}?error=google_state`);
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code'
    })
  });
  if (!tokenRes.ok) return res.redirect(`${loginBase}?error=google_failed`);
  const tokenData = await tokenRes.json() as { access_token?: string };
  if (!tokenData.access_token) return res.redirect(`${loginBase}?error=google_failed`);

  const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokenData.access_token}` }
  });
  if (!profileRes.ok) return res.redirect(`${loginBase}?error=google_failed`);
  const profile = await profileRes.json() as { email?: string; email_verified?: boolean };
  if (!profile.email || !profile.email_verified) return res.redirect(`${loginBase}?error=google_unverified`);

  if (statePayload.mode === 'link' && statePayload.userId) {
    const dest = `${webBase}${statePayload.returnTo || '/'}`;
    const conflict = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(profile.email, statePayload.userId);
    if (conflict) return res.redirect(`${dest}?googleError=email_used`);
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(profile.email, statePayload.userId);
    db.prepare(`INSERT INTO audit_logs (id, actor_id, actor_name, action, target, ip_address, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id(), statePayload.userId, profile.email, 'user.link_google', statePayload.userId, req.ip, JSON.stringify({ email: profile.email }), isoNow());
    const linkedUser = db.prepare('SELECT username, role FROM users WHERE id = ?').get(statePayload.userId) as { username: string; role: string } | undefined;
    void sendWelcomeEmail(profile.email, linkedUser?.username ?? profile.email, { status: 'linked', role: linkedUser?.role }).catch(() => undefined);
    return res.redirect(`${dest}?googleLinked=1`);
  }

  if (statePayload.mode === 'admin_add') {
    const dest = `${webBase}/users`;
    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(profile.email);
    if (existing) return res.redirect(`${dest}?googleError=email_used`);
    const baseName = (profile.email.split('@')[0] ?? 'user').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 28) || 'user';
    let candidate = baseName.length < 3 ? `${baseName}01` : baseName;
    let suffix = 1;
    while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) {
      candidate = `${baseName.slice(0, 24)}_${suffix++}`;
    }
    const assignedRole = statePayload.role ?? 'operator';
    const newId = id();
    const randomHash = await argon2.hash(randomBytes(24).toString('hex'), { type: argon2.argon2id });
    db.prepare('INSERT INTO users (id, username, email, password_hash, role, active, login_otp_required, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)')
      .run(newId, candidate, profile.email, randomHash, assignedRole, isoNow());
    db.prepare(`INSERT INTO audit_logs (id, actor_id, actor_name, action, target, ip_address, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id(), statePayload.actorId ?? null, profile.email, 'user.create_google', newId, req.ip, JSON.stringify({ username: candidate, email: profile.email, role: assignedRole }), isoNow());
    void sendWelcomeEmail(profile.email, candidate, { status: 'active', role: assignedRole }).catch(() => undefined);
    return res.redirect(`${dest}?googleAdded=1`);
  }

  if (statePayload.mode === 'register') {
    const existing = db.prepare('SELECT id, username, email, role, active, login_otp_required FROM users WHERE lower(email) = lower(?)')
      .get(profile.email) as { id: string; username: string; email: string | null; role: 'admin' | 'operator' | 'viewer'; active: number; login_otp_required: number } | undefined;
    if (existing) {
      if (!existing.active) return res.redirect(`${loginBase}?registered=pending`);
      if (existing.login_otp_required === 1 && existing.email && isGmailAlertConfigured()) {
        const challenge = await issueLoginOtpChallenge({ id: existing.id, username: existing.username, email: existing.email });
        return res.redirect(`${loginBase}?otpToken=${encodeURIComponent(challenge.otpToken)}&email=${encodeURIComponent(challenge.email)}`);
      }
      res.cookie('session', signToken({ id: existing.id, username: existing.username, role: existing.role }), {
        httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/'
      });
      return res.redirect(`${webBase}/`);
    }
    const baseName = (profile.email.split('@')[0] ?? 'user').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 28) || 'user';
    let candidate = baseName.length < 3 ? `${baseName}01` : baseName;
    let suffix = 1;
    while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) {
      candidate = `${baseName.slice(0, 24)}_${suffix++}`;
    }
    const newId = id();
    const randomHash = await argon2.hash(randomBytes(24).toString('hex'), { type: argon2.argon2id });
    db.prepare('INSERT INTO users (id, username, email, password_hash, role, active, login_otp_required, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)')
      .run(newId, candidate, profile.email, randomHash, 'viewer', isoNow());
    db.prepare(`INSERT INTO audit_logs (id, actor_id, actor_name, action, target, ip_address, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id(), newId, profile.email, 'user.register_google', newId, req.ip, JSON.stringify({ username: candidate, email: profile.email }), isoNow());
    const { notify } = await import('../services/notify/index.js');
    await notify('user_register', `Pendaftar baru via Google: ${profile.email} (${candidate}) menunggu aktivasi Admin.`);
    void sendWelcomeEmail(profile.email, candidate, { status: 'pending' }).catch(() => undefined);
    return res.redirect(`${loginBase}?registered=1`);
  }

  const user = db.prepare('SELECT id, username, email, role, active, login_otp_required FROM users WHERE lower(email) = lower(?)')
    .get(profile.email) as { id: string; username: string; email: string | null; role: 'admin' | 'operator' | 'viewer'; active: number; login_otp_required: number } | undefined;
  db.prepare('INSERT INTO login_attempts (username, ip_address, attempted_at, succeeded) VALUES (?, ?, ?, ?)')
    .run(profile.email, req.ip, isoNow(), user?.active ? 1 : 0);
  if (!user || !user.active) return res.redirect(`${loginBase}?error=google_unregistered`);
  if (user.login_otp_required === 1 && user.email && isGmailAlertConfigured()) {
    const challenge = await issueLoginOtpChallenge({ id: user.id, username: user.username, email: user.email });
    return res.redirect(`${loginBase}?otpToken=${encodeURIComponent(challenge.otpToken)}&email=${encodeURIComponent(challenge.email)}`);
  }

  res.cookie('session', signToken({ id: user.id, username: user.username, role: user.role }), {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/'
  });
  return res.redirect(`${webBase}/`);
}));

router.get('/dashboard/summary', requireAuth, (req, res) => {
  const deviceId = z.string().uuid().optional().parse(req.query.deviceId);
  const devices = db.prepare(`SELECT id, name, timezone, last_seen_at, door_state, remaining_seconds,
    wifi_rssi, open_duration_seconds, failure_limit, lockout_seconds FROM devices
    ${deviceId ? 'WHERE id = ?' : ''} ORDER BY created_at`).all(...(deviceId ? [deviceId] : [])) as
      { id: string; name: string; timezone: string; last_seen_at: string | null; door_state: string; remaining_seconds: number; wifi_rssi: number | null; open_duration_seconds: number; failure_limit: number; lockout_seconds: number }[];
  const cutoff = Date.now() - config.OFFLINE_THRESHOLD_MINUTES * 60_000;
  const summary = devices.map((device) => {
    const online = device.last_seen_at !== null && Date.parse(device.last_seen_at) > cutoff;
    const todayKey = localDateKey(new Date(), device.timezone);
    const start = utcAtLocalMidnight(todayKey, device.timezone);
    const end = utcAtLocalMidnight(addLocalDays(todayKey, 1), device.timezone);
    const todayStats = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'DITERIMA' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status IN ('DITOLAK','ALARM_LOCKOUT') THEN 1 ELSE 0 END) AS denied
      FROM access_logs WHERE device_id = ? AND received_at >= ? AND received_at < ?`)
      .get(device.id, start, end) as { total: number; accepted: number | null; denied: number | null };
    const cardCount = db.prepare(`SELECT COUNT(*) AS count FROM device_cards dc JOIN cards c ON c.id = dc.card_id
      WHERE dc.device_id = ? AND dc.enabled = 1 AND c.active = 1`).get(device.id) as { count: number };
    return {
      ...device, online, cardCount: cardCount.count,
      today: { total: todayStats.total, accepted: todayStats.accepted ?? 0, denied: todayStats.denied ?? 0 }
    };
  });
  res.json({ devices: summary, generatedAt: isoNow() });
});

router.get('/dashboard/charts', requireAuth, (req, res) => {
  const query = z.object({ deviceId: z.string().uuid(), range: z.enum(['today', '7d', '30d']).default('7d') }).parse(req.query);
  const device = db.prepare('SELECT timezone FROM devices WHERE id = ?').get(query.deviceId) as { timezone: string } | undefined;
  if (!device) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  const now = new Date();
  const todayKey = localDateKey(now, device.timezone);
  const dayCount = query.range === 'today' ? 1 : query.range === '30d' ? 30 : 7;
  const firstDay = addLocalDays(todayKey, -(dayCount - 1));
  const start = utcAtLocalMidnight(firstDay, device.timezone);
  const startToday = utcAtLocalMidnight(todayKey, device.timezone);
  const end = utcAtLocalMidnight(addLocalDays(todayKey, 1), device.timezone);
  const minutes = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:00Z', received_at) AS minute,
    status, COUNT(*) AS total FROM access_logs WHERE device_id = ? AND received_at >= ? AND received_at < ?
    GROUP BY minute, status ORDER BY minute`).all(query.deviceId, start, end) as
      { minute: string; status: string; total: number }[];
  const periodHourTotals = new Map<string, { label: string; total: number }>();
  const dayTotals = new Map<string, { label: string; total: number; accepted: number; denied: number }>();
  const mix = new Map<string, number>();
  for (const row of minutes) {
    const local = zonedDayAndHour(new Date(row.minute), device.timezone);
    const hour = periodHourTotals.get(local.hour) ?? { label: local.hour, total: 0 };
    const day = dayTotals.get(local.day) ?? { label: local.day, total: 0, accepted: 0, denied: 0 };
    const accepted = row.status === 'DITERIMA';
    const denied = row.status === 'DITOLAK' || row.status === 'ALARM_LOCKOUT';
    hour.total += row.total; day.total += row.total;
    if (accepted) { day.accepted += row.total; }
    if (denied) { day.denied += row.total; }
    periodHourTotals.set(local.hour, hour); dayTotals.set(local.day, day);
    mix.set(row.status, (mix.get(row.status) ?? 0) + row.total);
  }
  const todayMinutes = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:00Z', received_at) AS minute,
    status, COUNT(*) AS total FROM access_logs WHERE device_id = ? AND received_at >= ? AND received_at < ?
    GROUP BY minute, status ORDER BY minute`).all(query.deviceId, startToday, end) as
      { minute: string; status: string; total: number }[];
  const todayHours = new Map<string, { label: string; total: number; accepted: number; denied: number }>();
  for (const row of todayMinutes) {
    const label = zonedDayAndHour(new Date(row.minute), device.timezone).hour;
    const hour = todayHours.get(label) ?? { label, total: 0, accepted: 0, denied: 0 };
    hour.total += row.total;
    if (row.status === 'DITERIMA') hour.accepted += row.total;
    if (row.status === 'DITOLAK' || row.status === 'ALARM_LOCKOUT') hour.denied += row.total;
    todayHours.set(label, hour);
  }
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const label = String(hour).padStart(2, '0');
    return todayHours.get(label) ?? { label, total: 0, accepted: 0, denied: 0 };
  });
  const days = Array.from({ length: dayCount }, (_, index) => {
    const label = addLocalDays(firstDay, index);
    return dayTotals.get(label) ?? { label, total: 0, accepted: 0, denied: 0 };
  });
  const busiest = [...periodHourTotals.values()].sort((a, b) => b.total - a.total)[0];
  return res.json({
    hours, days, mix: [...mix].map(([status, total]) => ({ status, total })),
    busiestHour: busiest && busiest.total > 0 ? { hour: busiest.label, total: busiest.total } : null,
    timezone: device.timezone
  });
});

const deviceBody = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: z.string().min(1).max(80).refine((value) => {
    try { Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Zona waktu tidak valid'),
  topicPrefix: z.string().regex(/^[A-Za-z0-9/_-]{1,120}$/)
});
router.get('/devices', requireAuth, (_req, res) => {
  const devices = db.prepare('SELECT * FROM devices ORDER BY created_at').all() as
    { id: string; last_seen_at: string | null }[];
  return res.json({ devices: devices.map((device) => ({
    ...device, online: Boolean(device.last_seen_at &&
      Date.now() - Date.parse(device.last_seen_at) <= config.OFFLINE_THRESHOLD_MINUTES * 60_000)
  })) });
});
router.post('/devices', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const body = deviceBody.parse(req.body);
  const deviceId = id();
  db.prepare(`INSERT INTO devices (id, name, timezone, topic_prefix, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(deviceId, body.name, body.timezone, body.topicPrefix.replace(/\/+$/, ''), isoNow());
  subscribeDevice(body.topicPrefix.replace(/\/+$/, ''));
  globalThis.ioServer?.sockets.sockets.forEach((socket) => {
    socket.join(`device:${deviceId}`);
    if ((socket.data.user as { role?: string } | undefined)?.role === 'admin') socket.join(`device:${deviceId}:admins`);
  });
  audit(req, 'device.create', deviceId, { name: body.name, topicPrefix: body.topicPrefix });
  return res.status(201).json({ device: db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) });
}));
router.patch('/devices/:id', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const deviceId = pathId(req);
  const body = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    timezone: deviceBody.shape.timezone.optional(),
    openDurationSeconds: z.number().int().min(1).max(10).optional(),
    failureLimit: z.number().int().min(1).max(20).optional(),
    lockoutSeconds: z.number().int().min(1).max(600).optional()
  }).refine((value) => Object.keys(value).length > 0).parse(req.body);
  const current = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as Record<string, unknown> | undefined;
  if (!current) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  const fields: Record<string, string> = {
    name: 'name', timezone: 'timezone', openDurationSeconds: 'open_duration_seconds',
    failureLimit: 'failure_limit', lockoutSeconds: 'lockout_seconds'
  };
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(fields)) {
    if (key in body) { assignments.push(`${column} = ?`); values.push(body[key as keyof typeof body]); }
  }
  values.push(deviceId);
  db.prepare(`UPDATE devices SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  audit(req, 'device.update', deviceId, body);
  const updated = db.prepare('SELECT id, topic_prefix FROM devices WHERE id = ?').get(deviceId) as { id: string; topic_prefix: string };
  const commandResults: Array<{ action: string; ok: boolean; message?: string }> = [];
  const commandTasks: Array<Promise<{ action: string; ok: boolean; message?: string }>> = [];
  if (body.timezone !== undefined) syncDeviceCards(deviceId);
  if (body.openDurationSeconds !== undefined) {
    commandTasks.push(sendCommand(updated, 'set_duration', { durationSeconds: body.openDurationSeconds }, req.user!.id)
      .then((result) => ({ action: 'set_duration', ...result })));
  }
  if (body.failureLimit !== undefined || body.lockoutSeconds !== undefined) {
    commandTasks.push(sendCommand(updated, 'set_security_settings', {
      maxFailures: body.failureLimit,
      lockoutSeconds: body.lockoutSeconds
    }, req.user!.id).then((result) => ({ action: 'set_security_settings', ...result })));
  }
  if (commandTasks.length) {
    const settled = await Promise.allSettled(commandTasks);
    for (const result of settled) {
      if (result.status === 'fulfilled') commandResults.push(result.value);
      else commandResults.push({ action: 'configuration', ok: false, message: 'Perintah MQTT gagal dikirim' });
    }
    if (commandResults.some((result) => !result.ok)) {
      const code = commandResults.some((result) => result.message?.includes('tidak terhubung')) ? 503 : 504;
      return res.status(code).json({
        error: 'Pengaturan tersimpan di server, tetapi sebagian perubahan belum dikonfirmasi perangkat',
        saved: true, commandResults
      });
    }
  }
  return res.json({ device: db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId), commandResults });
}));
router.delete('/devices/:id', requireAuth, requireRole('admin'), (req, res) => {
  const deviceId = pathId(req);
  const device = db.prepare('SELECT topic_prefix FROM devices WHERE id = ?').get(deviceId) as { topic_prefix: string } | undefined;
  if (!device) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  const hasHistory = db.prepare('SELECT 1 FROM access_logs WHERE device_id = ? UNION ALL SELECT 1 FROM commands WHERE device_id = ? LIMIT 1')
    .get(deviceId, deviceId);
  if (hasHistory) return res.status(409).json({ error: 'Perangkat memiliki riwayat; penghapusan ditolak agar log dan audit tetap utuh' });
  const result = db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
  if (!result.changes) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  unsubscribeDevice(device.topic_prefix);
  audit(req, 'device.delete', deviceId, {});
  return res.status(204).end();
});

const slotSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
}).refine((slot) => slot.startTime < slot.endTime, { message: 'Rentang jam tidak valid' });
const cardBody = z.object({
  uid: z.string().regex(/^[A-Fa-f0-9]{4,32}$/),
  ownerName: z.string().trim().min(1).max(100),
  notes: z.string().max(500).default(''),
  active: z.boolean().default(true),
  deviceId: z.string().uuid(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  schedules: z.array(slotSchema).max(42).default([])
});
const logFilterSchema = z.object({
  deviceId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z.enum(['DITERIMA', 'DITOLAK', 'TERKUNCI', 'ALARM_LOCKOUT']).optional(),
  cardId: z.string().uuid().optional(),
  owner: z.string().max(100).optional(),
  search: z.string().max(80).optional()
}).refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: 'Rentang tanggal tidak valid'
});

router.get('/cards', requireAuth, (req, res) => {
  const deviceId = z.string().uuid().optional().parse(req.query.deviceId);
  const rows = db.prepare(`SELECT c.id, c.uid_cipher, c.uid_iv, c.uid_tag, c.owner_name AS ownerName, c.notes, c.active,
    c.created_at AS createdAt, dc.device_id AS deviceId,
    dc.valid_from AS validFrom, dc.valid_until AS validUntil, dc.enabled, dc.synced_at AS syncedAt
    FROM cards c JOIN device_cards dc ON dc.card_id = c.id
    ${deviceId ? 'WHERE dc.device_id = ?' : ''} ORDER BY c.created_at DESC`).all(...(deviceId ? [deviceId] : [])) as
      { id: string; uid_cipher: string; uid_iv: string; uid_tag: string; deviceId: string; enabled: number }[];
  res.json({ cards: rows.map(({ uid_cipher, uid_iv, uid_tag, ...card }) => ({
    ...card, uidMasked: maskUid(revealUid(uid_cipher, uid_iv, uid_tag)),
    schedules: db.prepare(`SELECT weekday, start_time AS startTime, end_time AS endTime FROM card_schedules
      WHERE device_card_id = (SELECT id FROM device_cards WHERE card_id = ? AND device_id = ?)`)
      .all(card.id, card.deviceId)
  })) });
});
router.post('/cards', requireAuth, requireRole('admin'), (req, res) => {
  const body = cardBody.parse(req.body);
  if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(body.deviceId)) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  if (body.validFrom && body.validUntil && Date.parse(body.validFrom) >= Date.parse(body.validUntil)) {
    return res.status(400).json({ error: 'Masa berlaku kartu tidak valid' });
  }
  const uid = protectUid(body.uid.toUpperCase());
  if (db.prepare('SELECT id FROM cards WHERE uid_hmac = ?').get(uid.hash)) return res.status(409).json({ error: 'UID kartu sudah terdaftar' });
  const cardId = id();
  const deviceCardId = id();
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO cards (id, uid_cipher, uid_iv, uid_tag, uid_hmac, owner_name, notes, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cardId, uid.cipher, uid.iv, uid.tag, uid.hash, body.ownerName, body.notes, body.active ? 1 : 0, isoNow(), isoNow());
    db.prepare(`INSERT INTO device_cards (id, device_id, card_id, valid_from, valid_until, enabled)
      VALUES (?, ?, ?, ?, ?, 1)`).run(deviceCardId, body.deviceId, cardId, body.validFrom ?? null, body.validUntil ?? null);
    for (const slot of body.schedules) {
      db.prepare(`INSERT INTO card_schedules (id, device_card_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)`)
        .run(id(), deviceCardId, slot.weekday, slot.startTime, slot.endTime);
    }
  });
  router.post('/cards/:id/devices', requireAuth, requireRole('admin'), (req, res) => {
    const cardId = pathId(req);
    const body = z.object({
      deviceId: z.string().uuid(),
      enabled: z.boolean().default(true),
      validFrom: z.string().datetime().nullable().optional(),
      validUntil: z.string().datetime().nullable().optional(),
      schedules: z.array(slotSchema).max(42).default([])
    }).parse(req.body);
    if (!db.prepare('SELECT id FROM cards WHERE id = ?').get(cardId)) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
    if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(body.deviceId)) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
    if (body.validFrom && body.validUntil && Date.parse(body.validFrom) >= Date.parse(body.validUntil)) {
      return res.status(400).json({ error: 'Masa berlaku kartu tidak valid' });
    }
    if (db.prepare('SELECT id FROM device_cards WHERE card_id = ? AND device_id = ?').get(cardId, body.deviceId)) {
      return res.status(409).json({ error: 'Kartu sudah terhubung ke perangkat tersebut' });
    }
    const deviceCardId = id();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO device_cards (id, device_id, card_id, valid_from, valid_until, enabled)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(deviceCardId, body.deviceId, cardId, body.validFrom ?? null, body.validUntil ?? null, body.enabled ? 1 : 0);
      for (const slot of body.schedules) {
        db.prepare(`INSERT INTO card_schedules (id, device_card_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)`)
          .run(id(), deviceCardId, slot.weekday, slot.startTime, slot.endTime);
      }
    });
    tx();
    audit(req, 'card.assign_device', cardId, { deviceId: body.deviceId });
    syncDeviceCards(body.deviceId);
    return res.status(201).json({ ok: true, deviceCardId });
  });
  transaction();
  audit(req, 'card.create', cardId, { deviceId: body.deviceId, ownerName: body.ownerName });
  syncDeviceCards(body.deviceId);
  return res.status(201).json({ card: { id: cardId, ownerName: body.ownerName, uidMasked: `${'*'.repeat(Math.max(0, body.uid.length - 4))}${body.uid.slice(-4)}` } });
});
router.patch('/cards/:id', requireAuth, requireRole('admin'), (req, res) => {
  const cardId = pathId(req);
  const body = z.object({
    ownerName: z.string().trim().min(1).max(100).optional(),
    notes: z.string().max(500).optional(),
    active: z.boolean().optional(),
    enabled: z.boolean().optional(),
    validFrom: z.string().datetime().nullable().optional(),
    validUntil: z.string().datetime().nullable().optional(),
    schedules: z.array(slotSchema).max(42).optional()
  }).refine((value) => Object.keys(value).length > 0).parse(req.body);
  const card = db.prepare('SELECT id FROM cards WHERE id = ?').get(cardId);
  if (!card) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
  const deviceCards = db.prepare('SELECT id, device_id FROM device_cards WHERE card_id = ?').all(cardId) as { id: string; device_id: string }[];
  if (body.validFrom && body.validUntil && Date.parse(body.validFrom) >= Date.parse(body.validUntil)) {
    return res.status(400).json({ error: 'Masa berlaku kartu tidak valid' });
  }
  const tx = db.transaction(() => {
    const fields: string[] = []; const values: unknown[] = [];
    for (const [key, column] of [['ownerName', 'owner_name'], ['notes', 'notes'], ['active', 'active']] as const) {
      if (body[key] !== undefined) { fields.push(`${column} = ?`); values.push(key === 'active' ? (body.active ? 1 : 0) : body[key]); }
    }
    if (fields.length) {
      values.push(isoNow(), cardId);
      db.prepare(`UPDATE cards SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...values);
    }
    for (const link of deviceCards) {
      db.prepare('UPDATE device_cards SET synced_at = NULL WHERE id = ?').run(link.id);
      if (body.enabled !== undefined || body.validFrom !== undefined || body.validUntil !== undefined) {
        const updates: string[] = []; const args: unknown[] = [];
        if (body.enabled !== undefined) { updates.push('enabled = ?'); args.push(body.enabled ? 1 : 0); }
        if (body.validFrom !== undefined) { updates.push('valid_from = ?'); args.push(body.validFrom); }
        if (body.validUntil !== undefined) { updates.push('valid_until = ?'); args.push(body.validUntil); }
        args.push(link.id);
        db.prepare(`UPDATE device_cards SET ${updates.join(', ')} WHERE id = ?`).run(...args);
      }
      if (body.schedules) {
        db.prepare('DELETE FROM card_schedules WHERE device_card_id = ?').run(link.id);
        for (const slot of body.schedules) db.prepare(`INSERT INTO card_schedules
          (id, device_card_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)`)
          .run(id(), link.id, slot.weekday, slot.startTime, slot.endTime);
      }
    }
  });
  tx();
  audit(req, 'card.update', cardId, body);
  for (const deviceId of new Set(deviceCards.map((link) => link.device_id))) syncDeviceCards(deviceId);
  res.json({ ok: true });
});
router.delete('/cards/:id', requireAuth, requireRole('admin'), (req, res) => {
  const cardId = pathId(req);
  const links = db.prepare('SELECT device_id FROM device_cards WHERE card_id = ?').all(cardId) as { device_id: string }[];
  const result = db.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
  if (!result.changes) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
  audit(req, 'card.delete', cardId, {});
  for (const deviceId of new Set(links.map((link) => link.device_id))) syncDeviceCards(deviceId);
  return res.status(204).end();
});

router.post('/devices/:id/enrollment', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const device = db.prepare('SELECT id, topic_prefix FROM devices WHERE id = ?').get(pathId(req)) as { id: string; topic_prefix: string } | undefined;
  if (!device) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  audit(req, 'enrollment.start', device.id, {});
  const result = await sendCommand(device, 'enroll_next', { mode: 'once' }, req.user!.id);
  return res.status(result.ok ? 200 : 504).json(result);
}));

router.post('/devices/:id/wifi/scan', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const device = db.prepare('SELECT id, topic_prefix FROM devices WHERE id = ?').get(pathId(req)) as { id: string; topic_prefix: string } | undefined;
  if (!device) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  const result = await sendCommand(device, 'scan_wifi', {}, req.user!.id);
  return res.status(result.ok ? 200 : 504).json({ ok: result.ok, networks: result.networks ?? [], message: result.message });
}));

router.post('/devices/:id/wifi/connect', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const device = db.prepare('SELECT id, topic_prefix FROM devices WHERE id = ?').get(pathId(req)) as { id: string; topic_prefix: string } | undefined;
  if (!device) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  const body = z.object({
    ssid: z.string().trim().min(1).max(64),
    password: z.string().max(64).default(''),
    mqttHost: z.string().trim().max(120).optional()
  }).parse(req.body);
  audit(req, 'device.wifi.update', device.id, { ssid: body.ssid, mqttHost: body.mqttHost || null });
  const result = await sendCommand(device, 'set_wifi', {
    ssid: body.ssid,
    password: body.password,
    ...(body.mqttHost ? { mqttHost: body.mqttHost } : {})
  }, req.user!.id);
  return res.status(result.ok ? 200 : 504).json(result);
}));

router.post('/devices/:id/commands/open', requireAuth, requireRole('admin', 'operator'), asyncRoute(async (req, res) => {
  const deviceId = pathId(req);
  const body = z.object({ confirm: z.literal(true) }).parse(req.body);
  const device = db.prepare('SELECT id, topic_prefix, open_duration_seconds FROM devices WHERE id = ?').get(deviceId) as
    { id: string; topic_prefix: string; open_duration_seconds: number } | undefined;
  if (!device) return res.status(404).json({ error: 'Perangkat tidak ditemukan' });
  audit(req, 'door.open.web', device.id, { durationSeconds: device.open_duration_seconds, confirmation: body.confirm });
  const result = await sendCommand(device, 'open', { durationSeconds: device.open_duration_seconds }, req.user!.id);
  if (result.ok) {
    const user = req.user!.username;
    const deviceName = (db.prepare('SELECT name FROM devices WHERE id = ?').get(device.id) as { name: string }).name;
    const { notify } = await import('../services/notify/index.js');
    await notify('web_open', `Pintu ${deviceName} dibuka dari web oleh ${user}`, device.id);
  }
  return res.status(result.ok ? 200 : 504).json(result);
}));

router.get('/access-logs', requireAuth, (req, res) => {
  const query = logFilterSchema.extend({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25)
  }).parse(req.query);
  const where: string[] = []; const values: unknown[] = [];
  if (query.deviceId) { where.push('l.device_id = ?'); values.push(query.deviceId); }
  if (query.from) { where.push('l.received_at >= ?'); values.push(query.from); }
  if (query.to) { where.push('l.received_at <= ?'); values.push(query.to); }
  if (query.status) { where.push('l.status = ?'); values.push(query.status); }
  if (query.cardId) { where.push('l.card_id = ?'); values.push(query.cardId); }
  if (query.owner) { where.push('instr(lower(COALESCE(l.owner_name_snapshot, c.owner_name)), lower(?)) > 0'); values.push(query.owner); }
  if (query.search) {
    where.push('(instr(l.uid_masked, ?) > 0 OR instr(lower(COALESCE(l.owner_name_snapshot, c.owner_name)), lower(?)) > 0)');
    values.push(query.search, query.search);
  }
  const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM access_logs l LEFT JOIN cards c ON c.id = l.card_id ${condition}`).get(...values) as { total: number }).total;
  const logs = db.prepare(`SELECT l.id, l.device_id AS deviceId, d.name AS deviceName, l.uid_masked AS uidMasked,
    l.status, l.failed_count AS failedCount, l.device_uptime_seconds AS deviceUptimeSeconds,
    l.received_at AS receivedAt, COALESCE(l.owner_name_snapshot, c.owner_name) AS ownerName, c.id AS cardId
    FROM access_logs l LEFT JOIN cards c ON c.id = l.card_id JOIN devices d ON d.id = l.device_id
    ${condition} ORDER BY l.received_at DESC LIMIT ? OFFSET ?`)
    .all(...values, query.limit, (query.page - 1) * query.limit);
  res.json({ logs, page: query.page, limit: query.limit, total });
});
router.get('/access-logs.csv', requireAuth, (req, res) => {
  const query = logFilterSchema.parse(req.query);
  const where: string[] = []; const values: unknown[] = [];
  if (query.deviceId) { where.push('l.device_id = ?'); values.push(query.deviceId); }
  if (query.from) { where.push('l.received_at >= ?'); values.push(query.from); }
  if (query.to) { where.push('l.received_at <= ?'); values.push(query.to); }
  if (query.status) { where.push('l.status = ?'); values.push(query.status); }
  if (query.cardId) { where.push('l.card_id = ?'); values.push(query.cardId); }
  if (query.owner) { where.push('instr(lower(COALESCE(l.owner_name_snapshot, c.owner_name)), lower(?)) > 0'); values.push(query.owner); }
  if (query.search) {
    where.push('(instr(l.uid_masked, ?) > 0 OR instr(lower(COALESCE(l.owner_name_snapshot, c.owner_name)), lower(?)) > 0)');
    values.push(query.search, query.search);
  }
  const rows = db.prepare(`SELECT d.name AS device, l.uid_masked AS uid, COALESCE(l.owner_name_snapshot, c.owner_name) AS owner,
    l.status, l.failed_count AS failed, l.received_at AS received_at, l.device_uptime_seconds AS uptime
    FROM access_logs l LEFT JOIN cards c ON c.id = l.card_id JOIN devices d ON d.id = l.device_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.received_at DESC LIMIT 10000`)
    .all(...values) as Record<string, unknown>[];
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = ['perangkat,uid,pemilik,status,gagal,waktu_diterima,uptime_detik',
    ...rows.map((row) => Object.values(row).map(cell).join(','))].join('\r\n');
  res.type('text/csv; charset=utf-8').attachment('riwayat-akses.csv').send(`\uFEFF${csv}`);
});

router.get('/audit-logs', requireAuth, requireRole('admin'), (req, res) => {
  const limit = z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit);
  res.json({ logs: db.prepare(`SELECT id, actor_name AS actor, action, target, ip_address AS ip,
    details, created_at AS createdAt FROM audit_logs ORDER BY created_at DESC LIMIT ?`).all(limit) });
});

router.get('/notifications', requireAuth, (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).default(40).parse(req.query.limit);
  res.json({ notifications: db.prepare(`SELECT id, device_id AS deviceId, kind, message,
    created_at AS createdAt, read_at AS readAt FROM notifications ORDER BY created_at DESC LIMIT ?`).all(limit) });
});
router.patch('/notifications/:id/read', requireAuth, (req, res) => {
  const result = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(isoNow(), pathId(req));
  if (!result.changes) return res.status(404).json({ error: 'Notifikasi tidak ditemukan' });
  res.json({ ok: true });
});
router.post('/notifications/read-all', requireAuth, (_req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(isoNow());
  res.json({ ok: true });
});
router.get('/notifications/email-status', requireAuth, requireRole('admin'), (_req, res) => {
  res.json(getGmailSettingsStatus());
});
router.put('/notifications/email-settings', requireAuth, requireRole('admin'), (req, res) => {
  const body = z.object({
    sender: z.string().trim().email('Email Gmail pengirim tidak valid').max(120),
    appPassword: z.string().max(64).optional(),
    recipients: z.string().trim().max(300).optional(),
    notifyRoles: z.boolean().optional()
  }).parse(req.body);
  saveGmailSettings(body);
  audit(req, 'notification.email_settings', body.sender, { notifyRoles: body.notifyRoles ?? true });
  return res.json(getGmailSettingsStatus());
});
router.post('/notifications/test-email', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  if (!isGmailAlertConfigured()) return res.status(400).json({ error: 'Pengaturan Gmail pengirim & App Password belum diisi.' });
  await sendAlertEmail('[NexaGate] Uji Notifikasi Gmail', `Ini adalah email uji coba dari NexaGate yang dikirim oleh ${req.user!.username}.`);
  audit(req, 'notification.test_email', req.user!.username, {});
  return res.json({ ok: true });
}));

const emailField = z.preprocess((v) => (v === '' ? null : v), z.string().trim().email().max(120).nullable().optional());

router.get('/users', requireAuth, requireRole('admin'), (_req, res) => {
  res.json({ users: db.prepare('SELECT id, username, email, role, active, created_at AS createdAt FROM users ORDER BY username').all() });
});
const pendingCreateOtps = new Map<string, { username: string; email: string; code: string; expiresAt: number; attempts: number }>();

router.post('/users/create-otp/request', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const body = z.object({
    username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_.-]+$/),
    email: z.string().trim().email('Alamat Gmail tidak valid').max(120)
  }).parse(req.body);
  if (!isGmailAlertConfigured()) {
    return res.status(400).json({ error: 'Pengirim Gmail belum aktif. Gunakan tombol Daftar via Google.' });
  }
  const takenUser = db.prepare('SELECT id FROM users WHERE username = ?').get(body.username);
  if (takenUser) return res.status(409).json({ error: 'Nama pengguna sudah digunakan' });
  const takenEmail = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(body.email);
  if (takenEmail) return res.status(409).json({ error: 'Gmail tersebut sudah digunakan oleh akun lain' });

  const challengeId = id();
  const code = String(randomInt(100000, 1000000));
  pendingCreateOtps.set(challengeId, {
    username: body.username,
    email: body.email,
    code,
    expiresAt: Date.now() + 10 * 60_000,
    attempts: 0
  });
  await sendOtpEmail(body.email, code, body.username);
  const createToken = jwt.sign({ challengeId, username: body.username, email: body.email }, config.JWT_SECRET, { expiresIn: '10m' });
  audit(req, 'user.create_otp_request', body.username, { email: body.email });
  return res.json({ ok: true, createToken });
}));

router.post('/users', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const isTestFallback = config.NODE_ENV === 'test' && !req.body?.email && !req.body?.createToken;
  if (isTestFallback) {
    const body = z.object({
      username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_.-]+$/),
      password: z.string().min(12).max(200),
      role: z.enum(['admin', 'operator', 'viewer'])
    }).parse(req.body);
    const userId = id();
    const hash = await argon2.hash(body.password, { type: argon2.argon2id });
    db.prepare('INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
      .run(userId, body.username, hash, body.role, isoNow());
    return res.status(201).json({ user: { id: userId, username: body.username, email: null, role: body.role } });
  }

  const body = z.object({
    username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_.-]+$/),
    email: z.string().trim().email('Alamat Gmail wajib diisi dan valid').max(120),
    password: z.string().min(12).max(200),
    role: z.enum(['admin', 'operator', 'viewer']),
    createToken: z.string().min(10),
    otpCode: z.string().trim().regex(/^\d{6}$/, 'Kode OTP harus 6 digit angka')
  }).parse(req.body);

  let decoded: { challengeId?: string; username?: string; email?: string };
  try {
    decoded = jwt.verify(body.createToken, config.JWT_SECRET) as { challengeId?: string; username?: string; email?: string };
  } catch {
    return res.status(400).json({ error: 'Sesi OTP kedaluwarsa. Kirim ulang OTP.' });
  }
  const pending = decoded.challengeId ? pendingCreateOtps.get(decoded.challengeId) : undefined;
  if (!pending || pending.expiresAt < Date.now() || pending.username !== body.username || pending.email.toLowerCase() !== body.email.toLowerCase()) {
    if (decoded.challengeId) pendingCreateOtps.delete(decoded.challengeId);
    return res.status(400).json({ error: 'Kode OTP kedaluwarsa atau data tidak cocok. Kirim ulang OTP.' });
  }
  pending.attempts += 1;
  if (pending.attempts > 5) {
    pendingCreateOtps.delete(decoded.challengeId!);
    return res.status(429).json({ error: 'Terlalu banyak percobaan OTP. Silakan kirim ulang kode baru.' });
  }
  if (pending.code !== body.otpCode) {
    return res.status(400).json({ error: 'Kode OTP salah.' });
  }
  pendingCreateOtps.delete(decoded.challengeId!);

  const userId = id();
  const hash = await argon2.hash(body.password, { type: argon2.argon2id });
  db.prepare('INSERT INTO users (id, username, email, password_hash, role, active, login_otp_required, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)')
    .run(userId, body.username, pending.email, hash, body.role, isoNow());
  audit(req, 'user.create', userId, { username: body.username, email: pending.email, role: body.role });
  void sendWelcomeEmail(pending.email, body.username, { status: 'active', role: body.role }).catch(() => undefined);
  return res.status(201).json({ user: { id: userId, username: body.username, email: pending.email, role: body.role } });
}));
const pendingEmailOtps = new Map<string, { email: string; code: string; expiresAt: number; attempts: number }>();

router.post('/users/:id/email-otp/request', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const userId = pathId(req);
  const body = z.object({ email: z.string().trim().email('Alamat Gmail tidak valid').max(120) }).parse(req.body);
  if (!isGmailAlertConfigured()) {
    return res.status(400).json({ error: 'Pengirim Gmail belum aktif. Gunakan tombol Tautkan via Google.' });
  }
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as { id: string; username: string } | undefined;
  if (!user) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  const conflict = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(body.email, userId);
  if (conflict) return res.status(409).json({ error: 'Gmail tersebut sudah digunakan oleh akun lain' });

  const code = String(randomInt(100000, 1000000));
  pendingEmailOtps.set(userId, { email: body.email, code, expiresAt: Date.now() + 10 * 60_000, attempts: 0 });
  await sendOtpEmail(body.email, code, user.username);
  audit(req, 'user.email_otp_request', userId, { email: body.email });
  return res.json({ ok: true });
}));

router.post('/users/:id/email-otp/verify', requireAuth, requireRole('admin'), (req, res) => {
  const userId = pathId(req);
  const body = z.object({
    email: z.string().trim().email().max(120),
    code: z.string().trim().regex(/^\d{6}$/, 'Kode OTP harus 6 digit angka')
  }).parse(req.body);
  const pending = pendingEmailOtps.get(userId);
  if (!pending || pending.expiresAt < Date.now() || pending.email.toLowerCase() !== body.email.toLowerCase()) {
    return res.status(400).json({ error: 'Kode OTP kedaluwarsa atau email tidak cocok. Kirim ulang OTP.' });
  }
  pending.attempts += 1;
  if (pending.attempts > 5) {
    pendingEmailOtps.delete(userId);
    return res.status(429).json({ error: 'Terlalu banyak percobaan OTP. Silakan minta kode baru.' });
  }
  if (pending.code !== body.code) {
    return res.status(400).json({ error: 'Kode OTP salah.' });
  }
  pendingEmailOtps.delete(userId);
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(pending.email, userId);
  audit(req, 'user.email_otp_verified', userId, { email: pending.email });
  const verifiedUser = db.prepare('SELECT username, role FROM users WHERE id = ?').get(userId) as { username: string; role: string } | undefined;
  void sendWelcomeEmail(pending.email, verifiedUser?.username ?? pending.email, { status: 'linked', role: verifiedUser?.role }).catch(() => undefined);
  return res.json({ ok: true });
});

router.patch('/users/:id', requireAuth, requireRole('admin'), asyncRoute(async (req, res) => {
  const userId = pathId(req);
  const body = z.object({
    email: z.null().optional(),
    role: z.enum(['admin', 'operator', 'viewer']).optional(),
    active: z.boolean().optional(),
    password: z.string().min(12).max(200).optional()
  }).refine((value) => Object.keys(value).length > 0).parse(req.body);
  const existing = db.prepare('SELECT username, email, role, active FROM users WHERE id = ?').get(userId) as
    { username: string; email: string | null; role: string; active: number } | undefined;
  if (!existing) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  const losingAdmin = existing.role === 'admin' && existing.active === 1 &&
    (body.role !== undefined && body.role !== 'admin' || body.active === false);
  if (losingAdmin && (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get() as { count: number }).count <= 1) {
    return res.status(400).json({ error: 'Admin aktif terakhir tidak dapat dinonaktifkan atau diturunkan perannya' });
  }
  const updates: string[] = []; const values: unknown[] = [];
  if (body.email !== undefined) { updates.push('email = ?'); values.push(body.email); }
  if (body.role) { updates.push('role = ?'); values.push(body.role); }
  if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active ? 1 : 0); }
  if (body.password) { updates.push('password_hash = ?'); values.push(await argon2.hash(body.password, { type: argon2.argon2id })); }
  values.push(userId);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  audit(req, 'user.update', userId, { email: body.email, role: body.role, active: body.active });
  if (existing.active === 0 && body.active === true && existing.email) {
    void sendWelcomeEmail(existing.email, existing.username, { status: 'active', role: body.role ?? existing.role }).catch(() => undefined);
  }
  res.json({ ok: true });
}));
router.delete('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const userId = pathId(req);
  if (userId === req.user!.id) return res.status(400).json({ error: 'Akun yang sedang digunakan tidak dapat dihapus' });
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  if (target.role === 'admin' && (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get() as { count: number }).count <= 1) {
    return res.status(400).json({ error: 'Admin aktif terakhir tidak dapat dihapus' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  audit(req, 'user.delete', userId, {});
  res.status(204).end();
});

router.get('/cards/:id/allowed-now', requireAuth, (req, res) => {
  const cardId = pathId(req);
  const row = db.prepare(`SELECT dc.valid_from, dc.valid_until, dc.enabled, c.active, d.timezone
    FROM device_cards dc JOIN cards c ON c.id = dc.card_id JOIN devices d ON d.id = dc.device_id
    WHERE dc.card_id = ?`).get(cardId) as {
      valid_from: string | null; valid_until: string | null; enabled: number; active: number; timezone: string
    } | undefined;
  if (!row) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
  const schedules = db.prepare(`SELECT weekday, start_time, end_time FROM card_schedules
    WHERE device_card_id = (SELECT id FROM device_cards WHERE card_id = ? LIMIT 1)`).all(cardId) as
      { weekday: number; start_time: string; end_time: string }[];
  res.json({ allowed: Boolean(row.active && row.enabled) &&
    isAllowedAt(new Date(), row.valid_from, row.valid_until, schedules, row.timezone) });
});

router.get('/sync/status', requireAuth, (_req, res) => {
  res.json(getSyncStatus());
});

router.post('/sync/now', requireAuth, requireRole('admin'), asyncRoute(async (_req, res) => {
  const result = await syncNow();
  res.json({ ...getSyncStatus(), synced: result.synced });
}));

router.post('/assistant/chat', requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    message: z.string().trim().min(1).max(400),
    deviceContext: z.object({
      name: z.string(),
      online: z.boolean(),
      doorState: z.string(),
      wifiRssi: z.number().nullable(),
      cardCount: z.number(),
      todayTotal: z.number(),
      todayAccepted: z.number(),
      todayDenied: z.number()
    })
  }).parse(req.body);

  const systemPrompt = [
    'Anda adalah Asisten Pintar NexaGate, sistem keamanan pintu RFID profesional.',
    'Jawablah dengan Bahasa Indonesia yang ramah, ringkas, sopan, berwibawa, dan maksimal 2-3 kalimat agar enak didengar saat dibacakan suara.',
    'Jangan pernah menyebut soal API, LLM, atau detail teknis internal.',
    `Pengguna saat ini: ${req.user!.username} (peran: ${req.user!.role}).`,
    `Data perangkat "${body.deviceContext.name}": status=${body.deviceContext.online ? 'online' : 'offline'}, pintu=${body.deviceContext.doorState === 'open' ? 'terbuka' : 'terkunci'}, sinyal=${body.deviceContext.wifiRssi ?? '-'} dBm, kartu aktif=${body.deviceContext.cardCount}, akses hari ini=${body.deviceContext.todayTotal} (${body.deviceContext.todayAccepted} diterima, ${body.deviceContext.todayDenied} ditolak).`
  ].join('\n');

  if (config.GROQ_API_KEY) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body.message }
        ],
        temperature: 0.5,
        max_tokens: 180
      })
    });
    if (response.ok) {
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (reply) return res.json({ reply, provider: 'groq' });
    }
  }

  if (config.GEMINI_API_KEY) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(config.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: body.message }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 180 }
        })
      }
    );
    if (response.ok) {
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (reply) return res.json({ reply, provider: 'gemini' });
    }
  }

  return res.json({ reply: null, provider: 'local' });
}));

function audit(req: Request, action: string, target: string, details: unknown) {
  const safeDetails = JSON.stringify(details, (_key, value) =>
    typeof value === 'string' && /^[A-Fa-f0-9]{8,32}$/.test(value) ? '***' : value
  );
  db.prepare(`INSERT INTO audit_logs (id, actor_id, actor_name, action, target, ip_address, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id(), req.user?.id ?? null, req.user?.username ?? 'system', action, target, req.ip, safeDetails, isoNow());
}
