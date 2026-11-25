import { Pool, type PoolClient } from 'pg';
import { config } from '../../config.js';
import { db } from '../db/index.js';

type SyncTable =
  | 'users'
  | 'devices'
  | 'cards'
  | 'app_settings'
  | 'device_cards'
  | 'card_schedules'
  | 'access_logs'
  | 'audit_logs'
  | 'commands'
  | 'notifications';

type TableMeta = {
  pk: 'id' | 'key';
  columns: readonly string[];
  conflictTarget?: string;
};

const TABLE_ORDER: readonly SyncTable[] = [
  'users',
  'devices',
  'cards',
  'app_settings',
  'device_cards',
  'card_schedules',
  'access_logs',
  'audit_logs',
  'commands',
  'notifications'
];

const TABLE_META: Record<SyncTable, TableMeta> = {
  users: {
    pk: 'id',
    columns: ['id', 'username', 'email', 'password_hash', 'role', 'active', 'login_otp_required', 'created_at']
  },
  devices: {
    pk: 'id',
    columns: [
      'id', 'name', 'timezone', 'topic_prefix', 'last_seen_at', 'door_state',
      'remaining_seconds', 'wifi_rssi', 'device_ip', 'open_duration_seconds',
      'failure_limit', 'lockout_seconds', 'created_at'
    ]
  },
  cards: {
    pk: 'id',
    columns: ['id', 'uid_cipher', 'uid_iv', 'uid_tag', 'uid_hmac', 'owner_name', 'notes', 'active', 'created_at', 'updated_at']
  },
  app_settings: {
    pk: 'key',
    columns: ['key', 'value', 'updated_at']
  },
  device_cards: {
    pk: 'id',
    columns: ['id', 'device_id', 'card_id', 'valid_from', 'valid_until', 'enabled', 'synced_at']
  },
  card_schedules: {
    pk: 'id',
    columns: ['id', 'device_card_id', 'weekday', 'start_time', 'end_time']
  },
  access_logs: {
    pk: 'id',
    columns: [
      'id', 'device_id', 'card_id', 'owner_name_snapshot', 'uid_hmac',
      'uid_masked', 'status', 'failed_count', 'device_uptime_seconds', 'received_at'
    ]
  },
  audit_logs: {
    pk: 'id',
    columns: ['id', 'actor_id', 'actor_name', 'action', 'target', 'ip_address', 'details', 'created_at']
  },
  commands: {
    pk: 'id',
    columns: ['id', 'device_id', 'action', 'requested_by', 'status', 'result', 'created_at', 'completed_at']
  },
  notifications: {
    pk: 'id',
    columns: ['id', 'device_id', 'kind', 'message', 'created_at', 'read_at']
  }
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    login_otp_required INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS login_otp_required INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email)) WHERE email IS NOT NULL;

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    topic_prefix TEXT NOT NULL UNIQUE,
    last_seen_at TEXT,
    door_state TEXT NOT NULL DEFAULT 'closed',
    remaining_seconds INTEGER NOT NULL DEFAULT 0,
    wifi_rssi INTEGER,
    device_ip TEXT,
    open_duration_seconds INTEGER NOT NULL DEFAULT 3,
    failure_limit INTEGER NOT NULL DEFAULT 3,
    lockout_seconds INTEGER NOT NULL DEFAULT 10,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    uid_cipher TEXT NOT NULL,
    uid_iv TEXT NOT NULL,
    uid_tag TEXT NOT NULL,
    uid_hmac TEXT NOT NULL UNIQUE,
    owner_name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_cards (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    valid_from TEXT,
    valid_until TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    synced_at TEXT,
    UNIQUE(device_id, card_id)
  );

  CREATE TABLE IF NOT EXISTS card_schedules (
    id TEXT PRIMARY KEY,
    device_card_id TEXT NOT NULL REFERENCES device_cards(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_logs (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
    owner_name_snapshot TEXT,
    uid_hmac TEXT,
    uid_masked TEXT,
    status TEXT NOT NULL,
    failed_count INTEGER NOT NULL,
    device_uptime_seconds INTEGER NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_received ON access_logs(received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_device_status ON access_logs(device_id, status);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    action TEXT NOT NULL,
    requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
`;

let pool: Pool | null = null;
let schemaReady = false;
let syncing = false;
let timer: NodeJS.Timeout | null = null;
let lastSyncAt: string | null = null;
let lastError: string | null = null;
let online = false;

function getPool(): Pool | null {
  if (!config.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    });
    pool.on('error', (err) => {
      online = false;
      lastError = err.message;
    });
  }
  return pool;
}

function getSyncState(key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSyncState(key: string, value: string) {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

async function ensureSchema(client: PoolClient) {
  if (schemaReady) return;
  await client.query(SCHEMA_SQL);
  schemaReady = true;
}

async function upsertRow(client: PoolClient, table: SyncTable, row: Record<string, unknown>) {
  const meta = TABLE_META[table];
  const cols = meta.columns;
  const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
  const updates = cols
    .filter((col) => col !== meta.pk)
    .map((col) => `${col} = EXCLUDED.${col}`)
    .join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${meta.pk}) DO UPDATE SET ${updates}`;
  await client.query(sql, cols.map((col) => row[col] ?? null));
}

async function deleteRow(client: PoolClient, table: SyncTable, rowId: string) {
  const meta = TABLE_META[table];
  await client.query(`DELETE FROM ${table} WHERE ${meta.pk} = $1`, [rowId]);
}

async function runInitialBackfill(client: PoolClient) {
  if (getSyncState('initial_backfill_done') === 'true') return;
  for (const table of TABLE_ORDER) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      await upsertRow(client, table, row);
    }
  }
  setSyncState('initial_backfill_done', 'true');
}

type OutboxItem = { id: number; table_name: string; row_id: string; op: 'upsert' | 'delete' };

export async function syncNow(): Promise<{ ok: boolean; synced: number; pending: number; error: string | null }> {
  const activePool = getPool();
  if (!activePool) {
    return { ok: false, synced: 0, pending: 0, error: 'DATABASE_URL belum diatur' };
  }
  if (syncing) {
    const pending = (db.prepare('SELECT COUNT(*) AS cnt FROM sync_outbox').get() as { cnt: number }).cnt;
    return { ok: online, synced: 0, pending, error: lastError };
  }

  syncing = true;
  let synced = 0;
  let client: PoolClient | null = null;
  try {
    client = await activePool.connect();
    await ensureSchema(client);
    await runInitialBackfill(client);

    const items = db.prepare('SELECT id, table_name, row_id, op FROM sync_outbox ORDER BY id ASC LIMIT 200').all() as OutboxItem[];

    const upserts = items.filter((item) => item.op === 'upsert' && item.table_name in TABLE_META);
    const deletes = items.filter((item) => item.op === 'delete' && item.table_name in TABLE_META);

    // Sort upserts by parent-before-child table order to satisfy foreign keys
    upserts.sort((a, b) => TABLE_ORDER.indexOf(a.table_name as SyncTable) - TABLE_ORDER.indexOf(b.table_name as SyncTable));
    // Sort deletes by child-before-parent table order
    deletes.sort((a, b) => TABLE_ORDER.indexOf(b.table_name as SyncTable) - TABLE_ORDER.indexOf(a.table_name as SyncTable));

    const processedIds: number[] = [];

    for (const item of upserts) {
      const table = item.table_name as SyncTable;
      const meta = TABLE_META[table];
      const row = db.prepare(`SELECT * FROM ${table} WHERE ${meta.pk} = ?`).get(item.row_id) as Record<string, unknown> | undefined;
      if (row) {
        await upsertRow(client, table, row);
      }
      processedIds.push(item.id);
      synced += 1;
    }

    for (const item of deletes) {
      await deleteRow(client, item.table_name as SyncTable, item.row_id);
      processedIds.push(item.id);
      synced += 1;
    }

    if (processedIds.length > 0) {
      const delStmt = db.prepare('DELETE FROM sync_outbox WHERE id = ?');
      const clearBatch = db.transaction((ids: number[]) => {
        for (const id of ids) delStmt.run(id);
      });
      clearBatch(processedIds);
    }

    online = true;
    lastError = null;
    lastSyncAt = new Date().toISOString();
    const pending = (db.prepare('SELECT COUNT(*) AS cnt FROM sync_outbox').get() as { cnt: number }).cnt;
    return { ok: true, synced, pending, error: null };
  } catch (error) {
    online = false;
    lastError = error instanceof Error ? error.message : 'Gagal sinkronisasi ke Supabase';
    const pending = (db.prepare('SELECT COUNT(*) AS cnt FROM sync_outbox').get() as { cnt: number }).cnt;
    return { ok: false, synced, pending, error: lastError };
  } finally {
    client?.release();
    syncing = false;
  }
}

export function getSyncStatus() {
  const pendingCount = (db.prepare('SELECT COUNT(*) AS cnt FROM sync_outbox').get() as { cnt: number }).cnt;
  return {
    enabled: Boolean(config.DATABASE_URL),
    online,
    pendingCount,
    lastSyncAt,
    lastError
  };
}

export function startSupabaseSync() {
  if (!config.DATABASE_URL || config.NODE_ENV === 'test') return;
  void syncNow().then((result) => {
    if (result.ok) {
      console.log(`Supabase sync active (synced=${result.synced}, pending=${result.pending})`);
    } else if (result.error) {
      console.warn(`Supabase offline/pending (${result.pending} queued): ${result.error}`);
    }
  });
  if (!timer) {
    timer = setInterval(() => {
      void syncNow();
    }, 5000);
    timer.unref();
  }
}

export async function closeSupabaseSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}
