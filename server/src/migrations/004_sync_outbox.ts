import type Database from 'better-sqlite3';

const TABLES_WITH_ID = [
  'users',
  'devices',
  'cards',
  'device_cards',
  'card_schedules',
  'access_logs',
  'audit_logs',
  'commands',
  'notifications'
] as const;

function triggersFor(table: string, pk: 'id' | 'key') {
  return `
    CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_ins AFTER INSERT ON ${table}
    BEGIN
      DELETE FROM sync_outbox WHERE table_name = '${table}' AND row_id = NEW.${pk};
      INSERT INTO sync_outbox (table_name, row_id, op, created_at)
      VALUES ('${table}', NEW.${pk}, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_upd AFTER UPDATE ON ${table}
    BEGIN
      DELETE FROM sync_outbox WHERE table_name = '${table}' AND row_id = NEW.${pk};
      INSERT INTO sync_outbox (table_name, row_id, op, created_at)
      VALUES ('${table}', NEW.${pk}, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_del AFTER DELETE ON ${table}
    BEGIN
      DELETE FROM sync_outbox WHERE table_name = '${table}' AND row_id = OLD.${pk};
      INSERT INTO sync_outbox (table_name, row_id, op, created_at)
      VALUES ('${table}', OLD.${pk}, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
  `;
}

export function up(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK(op IN ('upsert', 'delete')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_lookup ON sync_outbox(table_name, row_id);
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    ${TABLES_WITH_ID.map((table) => triggersFor(table, 'id')).join('\n')}
    ${triggersFor('app_settings', 'key')}
  `);
}
