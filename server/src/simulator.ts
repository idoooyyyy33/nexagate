import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isAllowedAt } from './services/schedule.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
const env = z.object({
  MQTT_URL: z.string().url().default('mqtt://localhost:1883'),
  MQTT_USERNAME: z.string().min(1),
  MQTT_PASSWORD: z.string().min(1),
  MQTT_CLIENT_ID: z.string().default('rfid-esp32-simulator'),
  DEFAULT_DEVICE_TOPIC_PREFIX: z.string().default('ti2024j/kel3/akses'),
  SIMULATOR_INTERVAL_MS: z.coerce.number().int().min(2000).default(12000)
}).parse(process.env);

const prefix = env.DEFAULT_DEVICE_TOPIC_PREFIX.replace(/\/+$/, '');
const client = mqtt.connect(env.MQTT_URL, {
  username: env.MQTT_USERNAME, password: env.MQTT_PASSWORD,
  clientId: `${env.MQTT_CLIENT_ID}-${randomBytes(3).toString('hex')}`,
  reconnectPeriod: 3000
});
let uptime = 0;
let doorOpenUntil = 0;
let lockoutUntil = 0;
let openDuration = 3;
let maxFailures = 3;
let lockoutDuration = 10;
let cards: Array<{ uid: string; validFrom: string | null; validUntil: string | null; schedules: Array<{ weekday: number; start_time: string; end_time: string }> }> = [];
let failures = 0;

function publish(topic: string, value: unknown) {
  client.publish(`${prefix}/${topic}`, JSON.stringify(value), { qos: 1 });
}
function status() {
  const open = Date.now() < doorOpenUntil;
  publish('status', {
    state: open ? 'open' : 'closed',
    remainingSeconds: open ? Math.ceil((doorOpenUntil - Date.now()) / 1000) : 0,
    wifiRssi: -47 - Math.floor(Math.random() * 35),
    ip: '192.168.1.88'
  });
}
function ack(commandId: string, action: string, ok: boolean, message: string, uid?: string) {
  publish('ack', { commandId, action, ok, message, ...(uid ? { uid } : {}) });
}

client.on('connect', () => {
  console.info(`Simulator connected; listening to ${prefix}/perintah`);
  client.subscribe(`${prefix}/perintah`, { qos: 1 });
  status();
});
client.on('error', (error) => console.error('Simulator MQTT error:', error.message));
client.on('message', (topic, raw) => {
  if (topic !== `${prefix}/perintah`) return;
  void (async () => {
    const commandSchema = z.object({ commandId: z.string().uuid(), action: z.string(), durationSeconds: z.number().optional(), cards: z.array(z.object({
        uid: z.string(), validFrom: z.string().nullable(), validUntil: z.string().nullable(),
        schedules: z.array(z.object({ weekday: z.number(), startTime: z.string(), endTime: z.string() })).default([])
    })).optional(), uid: z.string().optional(), maxFailures: z.number().optional(), lockoutSeconds: z.number().optional() });
    const parsed = commandSchema.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success) { console.error('Simulator rejected command:', parsed.error.issues); return; }
    const command = parsed.data;
    switch (command.action) {
      case 'open':
        if (Date.now() < lockoutUntil) { ack(command.commandId, command.action, false, 'lockout_active'); break; }
        openDuration = command.durationSeconds ?? openDuration;
        doorOpenUntil = Date.now() + openDuration * 1000;
        ack(command.commandId, command.action, true, 'opened');
        status();
        break;
      case 'enroll_next': {
        const uid = randomBytes(4).toString('hex').toUpperCase();
        ack(command.commandId, command.action, true, 'card_captured', uid);
        break;
      }
      case 'sync_cards':
        cards = (command.cards ?? []).map((card) => ({
          uid: card.uid, validFrom: card.validFrom, validUntil: card.validUntil,
          schedules: card.schedules.map((slot) => ({
            weekday: slot.weekday, start_time: slot.startTime, end_time: slot.endTime
          }))
        }));
        ack(command.commandId, command.action, true, `synced_${cards.length}_cards`);
        break;
      case 'add_card':
        if (command.uid) cards.push({ uid: command.uid, validFrom: null, validUntil: null, schedules: [] });
        ack(command.commandId, command.action, true, 'card_added');
        break;
      case 'delete_card':
        cards = cards.filter((card) => card.uid !== command.uid);
        ack(command.commandId, command.action, true, 'card_deleted');
        break;
      case 'set_duration':
        openDuration = Math.max(1, Math.min(10, command.durationSeconds ?? openDuration));
        ack(command.commandId, command.action, true, 'duration_updated');
        break;
      case 'set_security_settings':
        maxFailures = Math.max(1, Math.min(20, command.maxFailures ?? maxFailures));
        lockoutDuration = Math.max(1, Math.min(600, command.lockoutSeconds ?? lockoutDuration));
        ack(command.commandId, command.action, true, 'settings_updated');
        break;
      default:
        ack(command.commandId, command.action, false, 'unsupported_action');
    }
  })().catch((error: unknown) => console.error('Simulator command handler failed:', error));
});

const timer = setInterval(() => {
  uptime += Math.round(env.SIMULATOR_INTERVAL_MS / 1000);
  status();
  if (Date.now() >= doorOpenUntil && doorOpenUntil > 0) { doorOpenUntil = 0; status(); }
  if (Date.now() >= lockoutUntil) {
    const card = cards[Math.floor(Math.random() * cards.length)];
    const uid = card?.uid ?? randomBytes(4).toString('hex').toUpperCase();
    const valid = card ? isAllowedAt(new Date(), card.validFrom, card.validUntil, card.schedules, 'Asia/Jakarta') : false;
    if (card && valid) {
      failures = 0;
      doorOpenUntil = Date.now() + openDuration * 1000;
      publish('log', { uid, status: 'DITERIMA', gagal: 0, t: uptime });
      status();
    } else {
      failures += 1;
      const statusType = failures >= maxFailures ? 'ALARM_LOCKOUT' : 'DITOLAK';
      publish('log', { uid, status: statusType, gagal: failures, t: uptime });
      if (failures >= maxFailures) { lockoutUntil = Date.now() + lockoutDuration * 1000; failures = 0; }
    }
  }
}, env.SIMULATOR_INTERVAL_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    client.end(true, () => process.exit(0));
  });
}
