import type Database from 'better-sqlite3';

export function up(db: Database.Database) {
  db.exec(`ALTER TABLE users ADD COLUMN login_otp_required INTEGER NOT NULL DEFAULT 0;`);
}
