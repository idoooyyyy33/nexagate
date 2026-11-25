import mqtt, { type MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { db } from '../db/index.js';
import { maskUid, protectUid, revealUid } from '../crypto.js';
import { notify } from '../notify/index.js';
import { ServiceError } from '../errors.js';

const logSchema = z.object({
  uid: z.string().regex(/^[A-Fa-f0-9]{4,32}$/),
  status: z.enum(['DITERIMA', 'DITOLAK', 'TERKUNCI', 'ALARM_LOCKOUT']),
  gagal: z.number().int().min(0).max(100),
  t: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});
const statusSchema = z.object({
  state: z.enum(['open', 'closed']),
  remainingSeconds: z.number().int().min(0).max(3600).default(0),
  wifiRssi: z.number().int().min(-120).max(0).nullable().optional(),
  ip: z.string().max(64).nullable().optional()
});
const networkItemSchema = z.object({
  ssid: z.string().max(64),
  rssi: z.number().int(),
  secure: z.boolean()
});
const ackSchema = z.object({
  commandId: z.string().uuid(),
  ok: z.boolean(),
  action: z.string().max(40).optional(),
  message: z.string().max(200).optional(),
  uid: z.string().regex(/^[A-Fa-f0-9]{4,32}$/).optional(),
  networks: z.array(networkItemSchema).max(30).optional()
});

export type ScannedWifiNetwork = z.infer<typeof networkItemSchema>;

let client: MqttClient | undefined;
const pending = new Map<string, {
  resolve: (value: { ok: boolean; message?: string; uid?: string; networks?: ScannedWifiNetwork[] }) => void;
  timer: NodeJS.Timeout;
}>();
const cardSyncInFlight = new Set<string>();
const cardSyncRequestedAgain = new Set<string>();

function emitDevice(deviceId: string, event: string, payload: unknown) {
  globalThis.ioServer?.to(`device:${deviceId}`).emit(event, payload);
}

function topicDevice(topic: string, suffix: string) {
  const prefix = topic.slice(0, -suffix.length);
  return db.prepare('SELECT * FROM devices WHERE topic_prefix = ?').get(prefix) as
    | { id: string; name: string; topic_prefix: string; timezone: string }
    | undefined;
}

export function subscribeDevice(prefix: string) {
  if (!client?.connected) return;
  client.subscribe([`${prefix}/log`, `${prefix}/status`, `${prefix}/ack`], (error) => {
    if (error) console.error(`MQTT subscribe failed for ${prefix}:`, error.message);
  });
}

export function unsubscribeDevice(prefix: string) {
  client?.unsubscribe([`${prefix}/log`, `${prefix}/status`, `${prefix}/ack`], (error) => {
    if (error) console.error(`MQTT unsubscribe failed for ${prefix}:`, error.message);
  });
}

export function startMqtt(io: Server) {
  globalThis.ioServer = io;
  client = mqtt.connect(config.MQTT_URL, {
    username: config.MQTT_USERNAME,
    password: config.MQTT_PASSWORD,
    clientId: config.MQTT_CLIENT_ID,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000
  });

  client.on('connect', () => {
    console.info('Connected to private MQTT broker');
    const devices = db.prepare('SELECT topic_prefix FROM devices').all() as { topic_prefix: string }[];
    for (const device of devices) subscribeDevice(device.topic_prefix);
  });
  client.on('error', (error) => console.error('MQTT connection error:', error.message));
  client.on('message', (topic, raw) => {
    void handleMessage(topic, raw.toString()).catch((error: unknown) =>
      console.error('MQTT message processing failed:', error)
    );
  });
  return client;
}

export async function handleMessage(topic: string, text: string) {
  if (topic.endsWith('/log')) {
    const device = topicDevice(topic, '/log');
    if (!device) return;
    const parsed = logSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      console.warn('Rejected invalid MQTT log payload for device', device.id, parsed.error.issues);
      return;
    }
    const payload = parsed.data;
    const uid = protectUid(payload.uid.toUpperCase());
    const card = db.prepare('SELECT id, owner_name FROM cards WHERE uid_hmac = ?').get(uid.hash) as
      { id: string; owner_name: string } | undefined;
    const receivedAt = new Date().toISOString();
    const event = {
      id: randomUUID(), deviceId: device.id, cardId: card?.id ?? null, ownerName: card?.owner_name ?? null,
      uidMasked: maskUid(payload.uid), status: payload.status, failedCount: payload.gagal,
      deviceUptimeSeconds: payload.t, receivedAt
    };
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(receivedAt, device.id);
    db.prepare(`INSERT INTO access_logs
      (id, device_id, card_id, owner_name_snapshot, uid_hmac, uid_masked, status, failed_count, device_uptime_seconds, received_at)
      VALUES (@id, @deviceId, @cardId, @ownerName, @uidHmac, @uidMasked, @status, @failedCount, @uptime, @receivedAt)`)
      .run({
        id: event.id, deviceId: event.deviceId, cardId: event.cardId, ownerName: event.ownerName, uidHmac: uid.hash,
        uidMasked: event.uidMasked, status: event.status, failedCount: event.failedCount,
        uptime: event.deviceUptimeSeconds, receivedAt
      });
    emitDevice(device.id, 'access:new', event);
    if (payload.status === 'DITOLAK') {
      await notify('access_denied', `Kartu ditolak di ${device.name} (${event.uidMasked})`, device.id, {
        deviceName: device.name, uidMasked: event.uidMasked, status: payload.status, failedCount: payload.gagal
      });
    }
    if (payload.status === 'ALARM_LOCKOUT') {
      await notify('lockout', `Peringatan lockout di ${device.name}`, device.id, {
        deviceName: device.name, uidMasked: event.uidMasked, status: payload.status, failedCount: payload.gagal
      });
    }
    return;
  }

  if (topic.endsWith('/status')) {
    const device = topicDevice(topic, '/status');
    if (!device) return;
    const parsed = statusSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      console.warn('Rejected invalid MQTT status payload for device', device.id, parsed.error.issues);
      return;
    }
    const value = parsed.data;
    const lastSeenAt = new Date().toISOString();
    db.prepare(`UPDATE devices SET last_seen_at = ?, door_state = ?, remaining_seconds = ?,
      wifi_rssi = ?, device_ip = ? WHERE id = ?`)
      .run(lastSeenAt, value.state, value.remainingSeconds, value.wifiRssi ?? null, value.ip ?? null, device.id);
    emitDevice(device.id, 'device:status', { ...value, deviceId: device.id, lastSeenAt });
    const unsynced = db.prepare(`SELECT 1 FROM device_cards dc
      JOIN cards c ON c.id = dc.card_id
      WHERE dc.device_id = ? AND dc.synced_at IS NULL LIMIT 1`).get(device.id);
    if (unsynced) syncDeviceCards(device.id);
    return;
  }

  if (topic.endsWith('/ack')) {
    const device = topicDevice(topic, '/ack');
    if (!device) return;
    const parsed = ackSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      console.warn('Rejected invalid MQTT ACK for device', device.id, parsed.error.issues);
      return;
    }
    const ack = parsed.data;
    const result = ack.ok ? 'succeeded' : 'failed';
    db.prepare('UPDATE commands SET status = ?, result = ?, completed_at = ? WHERE id = ? AND device_id = ?')
      .run(result, ack.message ?? null, new Date().toISOString(), ack.commandId, device.id);
    const waiter = pending.get(ack.commandId);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(ack.commandId);
      waiter.resolve({ ok: ack.ok, message: ack.message, uid: ack.uid, networks: ack.networks });
    }
    if (ack.action === 'enroll_next' && ack.ok && ack.uid) {
      globalThis.ioServer?.to(`device:${device.id}:admins`).emit('enrollment:captured', {
        uid: maskUid(ack.uid), uidForAdmin: ack.uid
      });
    }
    emitDevice(device.id, 'command:result', {
      ...ack, ...(ack.uid ? { uid: maskUid(ack.uid) } : {})
    });
  }
}

export async function sendCommand(
  device: { id: string; topic_prefix: string },
  action: string,
  payload: Record<string, unknown>,
  requestedBy: string | null
) {
  if (!client?.connected) throw new ServiceError(503, 'Broker MQTT sedang tidak terhubung');
  const commandId = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO commands (id, device_id, action, requested_by, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)`).run(commandId, device.id, action, requestedBy, createdAt);
  const command = { commandId, action, ...payload };
  const resultPromise = new Promise<{ commandId: string; ok: boolean; message?: string; uid?: string; networks?: ScannedWifiNetwork[] }>((resolve) => {
    const timeoutMs = action === 'scan_wifi' ? Math.max(config.COMMAND_ACK_TIMEOUT_MS, 15000) : config.COMMAND_ACK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      pending.delete(commandId);
      db.prepare("UPDATE commands SET status = 'timeout', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), commandId);
      resolve({ commandId, ok: false, message: 'Perangkat tidak mengirim ACK sebelum batas waktu' });
    }, timeoutMs);
    pending.set(commandId, {
      timer,
      resolve: (result) => resolve({ commandId, ...result })
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      client!.publish(`${device.topic_prefix}/perintah`, JSON.stringify(command), { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    const waiter = pending.get(commandId);
    if (waiter) clearTimeout(waiter.timer);
    pending.delete(commandId);
    db.prepare("UPDATE commands SET status = 'failed', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), commandId);
    throw new ServiceError(503, 'Perintah gagal diterbitkan ke broker MQTT');
  }
  return resultPromise;
}

export function syncDeviceCards(deviceId: string) {
  if (cardSyncInFlight.has(deviceId)) {
    cardSyncRequestedAgain.add(deviceId);
    return;
  }
  const device = db.prepare('SELECT id, topic_prefix, timezone FROM devices WHERE id = ?').get(deviceId) as
    | { id: string; topic_prefix: string; timezone: string }
    | undefined;
  if (!device) return;
  const cards = db.prepare(`SELECT c.id, c.uid_cipher, c.uid_iv, c.uid_tag, dc.valid_from, dc.valid_until, dc.id AS device_card_id
    FROM cards c JOIN device_cards dc ON dc.card_id = c.id
    WHERE dc.device_id = ? AND dc.enabled = 1 AND c.active = 1`).all(deviceId) as {
      id: string; uid_cipher: string; uid_iv: string; uid_tag: string;
      valid_from: string | null; valid_until: string | null; device_card_id: string;
    }[];
  const snapshot = cards.map((card) => ({
    uid: revealUid(card.uid_cipher, card.uid_iv, card.uid_tag),
    validFrom: card.valid_from,
    validUntil: card.valid_until,
    schedules: db.prepare(`SELECT weekday, start_time AS startTime, end_time AS endTime
      FROM card_schedules WHERE device_card_id = ?`).all(card.device_card_id)
  }));
  cardSyncInFlight.add(deviceId);
  void sendCommand(device, 'sync_cards', { timezone: device.timezone, cards: snapshot }, null)
    .then((result) => {
      if (result.ok) {
        db.prepare('UPDATE device_cards SET synced_at = ? WHERE device_id = ?')
          .run(new Date().toISOString(), deviceId);
      } else {
        console.warn(`Card sync was not acknowledged for device ${deviceId}: ${result.message ?? 'unknown result'}`);
      }
    })
    .catch((error: unknown) => console.error(`Card sync failed for device ${deviceId}:`, error))
    .finally(() => {
      cardSyncInFlight.delete(deviceId);
      if (cardSyncRequestedAgain.delete(deviceId)) syncDeviceCards(deviceId);
    });
}

export function stopMqtt() {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  client?.end(true);
}
