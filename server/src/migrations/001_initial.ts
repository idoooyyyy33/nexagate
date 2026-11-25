import type Database from 'better-sqlite3';

export function up(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
      topic_prefix TEXT NOT NULL UNIQUE, last_seen_at TEXT, door_state TEXT NOT NULL DEFAULT 'closed',
      remaining_seconds INTEGER NOT NULL DEFAULT 0, wifi_rssi INTEGER, device_ip TEXT,
      open_duration_seconds INTEGER NOT NULL DEFAULT 3 CHECK(open_duration_seconds BETWEEN 1 AND 10),
      failure_limit INTEGER NOT NULL DEFAULT 3 CHECK(failure_limit BETWEEN 1 AND 20),
      lockout_seconds INTEGER NOT NULL DEFAULT 10 CHECK(lockout_seconds BETWEEN 1 AND 600),
      created_at TEXT NOT NULL
    );
    CREATE TABLE cards (
      id TEXT PRIMARY KEY, uid_cipher TEXT NOT NULL, uid_iv TEXT NOT NULL, uid_tag TEXT NOT NULL,
      uid_hmac TEXT NOT NULL UNIQUE, owner_name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE device_cards (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      valid_from TEXT, valid_until TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      synced_at TEXT, UNIQUE(device_id, card_id)
    );
    CREATE TABLE card_schedules (
      id TEXT PRIMARY KEY, device_card_id TEXT NOT NULL REFERENCES device_cards(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
      start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      CHECK(start_time < end_time)
    );
    CREATE TABLE access_logs (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
      card_id TEXT REFERENCES cards(id) ON DELETE SET NULL, owner_name_snapshot TEXT,
      uid_hmac TEXT, uid_masked TEXT, status TEXT NOT NULL, failed_count INTEGER NOT NULL,
      device_uptime_seconds INTEGER NOT NULL, received_at TEXT NOT NULL
    );
    CREATE INDEX idx_logs_received ON access_logs(received_at DESC);
    CREATE INDEX idx_logs_device_status ON access_logs(device_id, status);
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      ip_address TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE commands (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
      action TEXT NOT NULL, requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE TABLE login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
      ip_address TEXT NOT NULL, attempted_at TEXT NOT NULL, succeeded INTEGER NOT NULL
    );
  `);
}
