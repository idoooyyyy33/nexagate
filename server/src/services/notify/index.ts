import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../../config.js';
import { db } from '../db/index.js';
import { ServiceError } from '../errors.js';

let mailer: Transporter | undefined;

export type AlertMeta = {
  deviceName?: string;
  uidMasked?: string;
  status?: string;
  failedCount?: number;
};

function readSetting(key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function writeSetting(key: string, value: string) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}

function getRoleRecipients() {
  return db.prepare(
    "SELECT id, username, role, email FROM users WHERE active = 1 AND role IN ('admin', 'operator') AND email IS NOT NULL AND trim(email) != '' ORDER BY role, username"
  ).all() as { id: string; username: string; role: 'admin' | 'operator'; email: string }[];
}

function getGmailConfig() {
  const sender = readSetting('gmail_user') || config.GMAIL_USER;
  const appPassword = readSetting('gmail_app_password') || config.GMAIL_APP_PASSWORD;
  const notifyRolesRaw = readSetting('notify_roles_enabled');
  const notifyRoles = notifyRolesRaw === '' ? true : notifyRolesRaw === 'true';
  const extraRaw = readSetting('alert_email_to') || config.ALERT_EMAIL_TO;
  const extraList = extraRaw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const roleUsers = getRoleRecipients();
  const merged = new Set<string>([
    ...(notifyRoles ? roleUsers.map((user) => user.email.trim()) : []),
    ...extraList
  ]);
  if (merged.size === 0 && sender.trim()) merged.add(sender.trim());
  return {
    sender: sender.trim(),
    appPassword: appPassword.replace(/\s+/g, ''),
    notifyRoles,
    extraRecipients: extraRaw.trim(),
    roleUsers,
    recipients: [...merged].join(', ')
  };
}

export function getGmailSettingsStatus() {
  const state = getGmailConfig();
  return {
    configured: Boolean(state.sender && state.appPassword),
    hasPassword: Boolean(state.appPassword),
    sender: state.sender,
    notifyRoles: state.notifyRoles,
    extraRecipients: state.extraRecipients,
    autoRecipients: state.roleUsers,
    recipients: state.recipients
  };
}

export function saveGmailSettings(input: { sender: string; appPassword?: string; recipients?: string; notifyRoles?: boolean }) {
  writeSetting('gmail_user', input.sender.trim());
  if (input.appPassword && input.appPassword.trim().length > 0) {
    writeSetting('gmail_app_password', input.appPassword.replace(/\s+/g, ''));
  }
  if (input.recipients !== undefined) {
    writeSetting('alert_email_to', input.recipients.trim());
  }
  if (input.notifyRoles !== undefined) {
    writeSetting('notify_roles_enabled', input.notifyRoles ? 'true' : 'false');
  }
  mailer = undefined;
}

function getMailer() {
  const { sender, appPassword } = getGmailConfig();
  if (!sender || !appPassword) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: sender, pass: appPassword }
    });
  }
  return { transport: mailer, sender };
}

export function isGmailAlertConfigured() {
  return getGmailSettingsStatus().configured;
}

async function sendMailSafe(transport: Transporter, options: Parameters<Transporter['sendMail']>[0]) {
  try {
    await transport.sendMail(options);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const responseCode = error && typeof error === 'object' && 'responseCode' in error ? Number(error.responseCode) : 0;
    if (code === 'EAUTH' || responseCode === 535) {
      throw new ServiceError(400, 'Login Gmail ditolak. Periksa Gmail pengirim & App Password 16 karakter di menu Perangkat → Lanjutan.');
    }
    throw new ServiceError(502, 'Gagal mengirim email melalui server Gmail SMTP.');
  }
}

export async function sendOtpEmail(toEmail: string, code: string, username: string) {
  const active = getMailer();
  if (!active) return false;
  await sendMailSafe(active.transport, {
    from: `"NexaGate Security" <${active.sender}>`,
    to: toEmail,
    subject: '[NexaGate] Kode Verifikasi OTP Penautan Gmail',
    text: `Kode OTP Anda untuk menautkan Gmail ke akun "${username}" di NexaGate adalah: ${code}\n\nKode berlaku selama 10 menit. Jangan bagikan kode ini kepada siapa pun.`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:14px">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:22px">
        <h2 style="margin:0 0 8px;color:#0f172a;font-size:18px">Verifikasi Gmail NexaGate</h2>
        <p style="margin:0 0 16px;color:#334155;font-size:14px">Masukkan kode OTP berikut untuk menautkan email ini ke akun <b>${escapeHtml(username)}</b>:</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;text-align:center;padding:14px;background:#f1f5f9;border-radius:10px;color:#0f172a;margin-bottom:16px">${escapeHtml(code)}</div>
        <div style="font-size:12px;color:#64748b">Berlaku selama 10 menit. Abaikan email ini jika Anda tidak merasa meminta kode.</div>
      </div>
    </div>`
  });
  return true;
}

export async function sendWelcomeEmail(
  toEmail: string,
  username: string,
  options: { status: 'active' | 'pending' | 'linked'; role?: string }
) {
  const active = getMailer();
  if (!active) return false;
  const panelUrl = config.WEB_ORIGIN.replace(/\/+$/, '');
  const roleLabel = options.role ? options.role.toUpperCase() : 'USER';
  const isPending = options.status === 'pending';
  const isLinked = options.status === 'linked';

  const subject = isPending
    ? '[NexaGate] Pendaftaran Akun Berhasil Diterima'
    : isLinked
      ? '[NexaGate] Gmail Berhasil Ditautkan ke Akun Anda'
      : '[NexaGate] Selamat Datang! Akun Anda Sudah Aktif';

  const badgeBg = isPending ? '#0284c7' : '#059669';
  const badgeText = isPending ? 'MENUNGGU AKTIVASI' : isLinked ? 'GMAIL TERVERIFIKASI' : 'AKUN AKTIF';
  const heading = isPending
    ? 'Pendaftaran Berhasil Diterima'
    : isLinked
      ? 'Gmail Berhasil Ditautkan'
      : 'Selamat Datang di NexaGate!';

  const bodyText = isPending
    ? `Halo ${username}, pendaftaran akun NexaGate Anda menggunakan Gmail ini berhasil diterima. Silakan tunggu Admin mengaktifkan akun Anda sebelum masuk ke dashboard.`
    : isLinked
      ? `Halo ${username}, alamat Gmail ini telah berhasil diverifikasi dan ditautkan ke akun NexaGate Anda. Anda sekarang dapat masuk menggunakan tombol Google (Gmail).`
      : `Halo ${username}, akun NexaGate Anda dengan peran ${roleLabel} telah aktif. Anda dapat langsung masuk ke dashboard menggunakan akun Google Anda.`;

  await sendMailSafe(active.transport, {
    from: `"NexaGate Security" <${active.sender}>`,
    to: toEmail,
    subject,
    text: `${bodyText}\n\nPanel NexaGate: ${panelUrl}`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:14px">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
        <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${badgeBg};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.06em">${badgeText}</div>
        <h2 style="margin:12px 0 8px;color:#0f172a;font-size:20px">${heading}</h2>
        <p style="margin:0 0 18px;color:#334155;font-size:14px;line-height:1.6">${escapeHtml(bodyText)}</p>
        <table style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0;margin-bottom:18px">
          <tr><td style="padding:7px 0;color:#64748b;font-size:13px">Nama Pengguna</td><td style="padding:7px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right">${escapeHtml(username)}</td></tr>
          <tr><td style="padding:7px 0;color:#64748b;font-size:13px">Email Terdaftar</td><td style="padding:7px 0;color:#0f172a;font-size:13px;text-align:right">${escapeHtml(toEmail)}</td></tr>
          ${options.role ? `<tr><td style="padding:7px 0;color:#64748b;font-size:13px">Peran</td><td style="padding:7px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right">${escapeHtml(roleLabel)}</td></tr>` : ''}
        </table>
        <a href="${escapeHtml(panelUrl)}" style="display:inline-block;padding:10px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600">Buka Dashboard NexaGate</a>
      </div>
      <div style="margin-top:12px;text-align:center;font-size:11px;color:#94a3b8">NexaGate — Smart Entry &amp; RFID Access Management</div>
    </div>`
  });
  return true;
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function sendAlertEmail(subject: string, message: string, meta?: AlertMeta) {
  const active = getMailer();
  if (!active) return false;
  const { recipients } = getGmailConfig();
  const list = recipients.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!list.length) return false;

  const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'medium' });
  const isLockout = meta?.status === 'ALARM_LOCKOUT';
  const badgeColor = isLockout ? '#dc2626' : '#d97706';
  const badgeText = isLockout ? 'ALARM LOCKOUT' : (meta?.status || 'PERINGATAN KEAMANAN');
  const panelUrl = config.WEB_ORIGIN.replace(/\/+$/, '');

  const rowsHtml = [
    meta?.deviceName ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px">Perangkat</td><td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right">${escapeHtml(meta.deviceName)}</td></tr>` : '',
    meta?.uidMasked ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px">UID Kartu</td><td style="padding:6px 0;color:#0f172a;font-size:13px;font-family:monospace;text-align:right">${escapeHtml(meta.uidMasked)}</td></tr>` : '',
    meta?.failedCount !== undefined ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px">Percobaan Gagal</td><td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right">${meta.failedCount}x</td></tr>` : '',
    `<tr><td style="padding:6px 0;color:#64748b;font-size:13px">Waktu</td><td style="padding:6px 0;color:#0f172a;font-size:13px;text-align:right">${escapeHtml(timestamp)} WIB</td></tr>`
  ].filter(Boolean).join('');

  await sendMailSafe(active.transport, {
    from: `"NexaGate Security" <${active.sender}>`,
    to: list.join(', '),
    subject,
    text: `${message}\n\nWaktu: ${timestamp} WIB\nPanel: ${panelUrl}`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:14px">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:22px">
        <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${badgeColor};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.06em">${escapeHtml(badgeText)}</div>
        <h2 style="margin:12px 0 8px;color:#0f172a;font-size:18px">Peringatan Akses Pintu RFID</h2>
        <p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.5">${escapeHtml(message)}</p>
        <table style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0;margin-bottom:18px">${rowsHtml}</table>
        <a href="${escapeHtml(panelUrl)}" style="display:inline-block;padding:10px 16px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600">Buka Dashboard NexaGate</a>
      </div>
      <div style="margin-top:12px;text-align:center;font-size:11px;color:#94a3b8">Dikirim otomatis kepada Admin &amp; Operator terdaftar di NexaGate</div>
    </div>`
  });
  return true;
}

export async function notify(kind: string, message: string, deviceId: string | null = null, meta?: AlertMeta) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO notifications (id, device_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, deviceId, kind, message, createdAt);
  const event = { id, deviceId, kind, message, createdAt };
  globalThis.ioServer?.emit('notification:new', event);

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text: message })
      });
      if (!response.ok) console.error('Telegram notification failed:', response.status, await response.text());
    } catch (error) {
      console.error('Telegram notification error:', error);
    }
  }

  if (kind === 'access_denied' || kind === 'lockout') {
    try {
      const subject = kind === 'lockout'
        ? '[NexaGate] Peringatan Lockout Pintu RFID'
        : '[NexaGate] Percobaan Buka Pintu Gagal';
      await sendAlertEmail(subject, message, meta);
    } catch (error) {
      console.error('Gmail alert notification failed:', error);
    }
  }
}

declare global {
  var ioServer: import('socket.io').Server | undefined;
}
