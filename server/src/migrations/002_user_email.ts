import type Database from 'better-sqlite3';

export function up(db: Database.Database) {
  db.exec(`
    ALTER TABLE users ADD COLUMN email TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email)) WHERE email IS NOT NULL;
  `);
}
