import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from '../../config.js';
import { up as initialMigration } from '../../migrations/001_initial.js';
import { up as userEmailMigration } from '../../migrations/002_user_email.js';
import { up as appSettingsMigration } from '../../migrations/003_app_settings.js';
import { up as syncOutboxMigration } from '../../migrations/004_sync_outbox.js';
import { up as loginOtpMigration } from '../../migrations/005_login_otp.js';

if (config.DB_PATH !== ':memory:') mkdirSync(dirname(config.DB_PATH), { recursive: true });

export const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
if ((version.version ?? 0) < 1) {
  const migration = db.transaction(() => {
    initialMigration(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
  });
  migration();
}
if ((version.version ?? 0) < 2) {
  const migration = db.transaction(() => {
    userEmailMigration(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(new Date().toISOString());
  });
  migration();
}
if ((version.version ?? 0) < 3) {
  const migration = db.transaction(() => {
    appSettingsMigration(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(new Date().toISOString());
  });
  migration();
}
if ((version.version ?? 0) < 4) {
  const migration = db.transaction(() => {
    syncOutboxMigration(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(new Date().toISOString());
  });
  migration();
}
if ((version.version ?? 0) < 5) {
  const migration = db.transaction(() => {
    loginOtpMigration(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)').run(new Date().toISOString());
  });
  migration();
}
