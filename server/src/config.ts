import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  JWT_SECRET: z.string().min(32).refine((value) => !value.startsWith('CHANGE_ME'), 'Ganti JWT_SECRET dengan rahasia acak'),
  UID_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).refine((value) => !/^0+$/.test(value), 'Generate kunci enkripsi UID baru'),
  UID_HMAC_KEY: z.string().min(32).refine((value) => !value.startsWith('CHANGE_ME'), 'Ganti UID_HMAC_KEY dengan rahasia acak'),
  DB_PATH: z.string().default('./data/rfid.sqlite'),
  DATABASE_URL: z.string().optional().default(''),
  BOOTSTRAP_ADMIN_USERNAME: z.string().min(3).max(40).default('admin'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).refine((value) => !value.startsWith('CHANGE_ME'), 'Ganti kata sandi admin bootstrap'),
  MQTT_URL: z.string().url().default('mqtt://localhost:1883'),
  MQTT_USERNAME: z.string().min(1),
  MQTT_PASSWORD: z.string().min(8).refine((value) => !value.startsWith('CHANGE_ME'), 'Ganti kata sandi broker MQTT'),
  MQTT_CLIENT_ID: z.string().min(1).default('rfid-server'),
  DEFAULT_DEVICE_NAME: z.string().min(1).default('Pintu Utama'),
  DEFAULT_DEVICE_TOPIC_PREFIX: z.string().min(1).default('ti2024j/kel3/akses').transform((value) => value.replace(/\/+$/, '')),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  GMAIL_USER: z.string().optional().default(''),
  GMAIL_APP_PASSWORD: z.string().optional().default(''),
  ALERT_EMAIL_TO: z.string().optional().default(''),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default(''),
  GROQ_API_KEY: z.string().optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  OFFLINE_THRESHOLD_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  COMMAND_ACK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000)
});

export const config = schema.parse(process.env);
