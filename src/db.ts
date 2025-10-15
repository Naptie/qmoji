import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize database
const dbPath = path.join(__dirname, '..', 'data', 'qmoji.db');
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
const db = new Database(dbPath);

// Create images table
db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    saved_by TEXT NOT NULL,
    saved_from TEXT,
    use_count INTEGER NOT NULL DEFAULT 0
  )
`);

// Migration: Add saved_by and saved_from columns if they don't exist
try {
  // Check if columns exist by trying to select them
  db.prepare('SELECT saved_by, saved_from FROM images LIMIT 1').get();
} catch {
  // Columns don't exist, add them
  console.log('[DB] Migrating database: adding saved_by and saved_from columns...');
  db.exec(`
    ALTER TABLE images ADD COLUMN saved_by TEXT;
    ALTER TABLE images ADD COLUMN saved_from TEXT;
  `);
  // Backfill existing records: set saved_by to user_id for existing records
  // Only for actual user IDs (not chat- prefixed or 'global')
  db.prepare(
    "UPDATE images SET saved_by = user_id WHERE saved_by IS NULL AND user_id NOT LIKE 'chat-%' AND user_id != 'global'"
  ).run();
  console.log('[DB] Migration complete.');
}

// Migration: Add use_count column if it doesn't exist
try {
  db.prepare('SELECT use_count FROM images LIMIT 1').get();
} catch {
  console.log('[DB] Migrating database: adding use_count column...');
  db.exec(`ALTER TABLE images ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;`);
  console.log('[DB] Migration complete.');
}

export interface ImageRecord {
  id: string;
  name: string;
  file_path: string;
  user_id: string;
  created_at: number;
  saved_by: string;
  saved_from: string | null;
  use_count: number;
}

export const insertImage = (
  name: string,
  filePath: string,
  userId: string,
  savedBy: string,
  savedFrom: string | null = null
): ImageRecord => {
  const id = randomUUID();
  const created_at = Date.now();
  const use_count = 0;

  const stmt = db.prepare(`
    INSERT INTO images (id, name, file_path, user_id, created_at, saved_by, saved_from, use_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, name, filePath, userId, created_at, savedBy, savedFrom, use_count);

  return {
    id,
    name,
    file_path: filePath,
    user_id: userId,
    created_at,
    saved_by: savedBy,
    saved_from: savedFrom,
    use_count
  };
};

export const deleteImageById = (id: string): boolean => {
  const stmt = db.prepare('DELETE FROM images WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
};

export const incrementUseCount = (id: string): boolean => {
  const stmt = db.prepare('UPDATE images SET use_count = use_count + 1 WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
};

export const clearImagesByNameAndUserId = (name: string, userId: string): number => {
  const stmt = db.prepare('DELETE FROM images WHERE name = ? AND user_id = ?');
  const result = stmt.run(name, userId);
  return result.changes;
};

export const transferImagesOwnership = (idList: string[], newUserId: string): number => {
  const stmt = db.prepare('UPDATE images SET user_id = ? WHERE id = ?');
  const results = idList.map((id) => stmt.run(newUserId, id));
  return results.reduce((acc, r) => acc + (r.changes > 0 ? 1 : 0), 0);
};

export const getImageById = (id: string): ImageRecord | undefined => {
  const stmt = db.prepare('SELECT * FROM images WHERE id = ?');
  return stmt.get(id) as ImageRecord | undefined;
};

export const getImagesByUser = (
  userId: string | null = null,
  groupId: string | null = null,
  includeGlobal = true
): ImageRecord[] => {
  const stmt = db.prepare(
    `SELECT * FROM images WHERE (user_id = ? or user_id = ? ${includeGlobal ? "or user_id = 'global'" : ''}) ORDER BY user_id ASC, created_at DESC`
  );
  return stmt.all(userId, `chat-${groupId}`) as ImageRecord[];
};

export const getImagesByNameAndUser = (
  name: string,
  userId: string,
  groupId: string | null = null,
  includeGlobal = false
): ImageRecord[] => {
  const stmt = db.prepare(
    `SELECT * FROM images WHERE name = ? AND (user_id = ? or user_id = ? ${includeGlobal ? "or user_id = 'global'" : ''}) ORDER BY user_id ASC, created_at DESC`
  );
  return stmt.all(name, userId, `chat-${groupId}`) as ImageRecord[];
};

export const getAllImages = (): ImageRecord[] => {
  const stmt = db.prepare('SELECT * FROM images ORDER BY created_at DESC');
  return stmt.all() as ImageRecord[];
};

export const closeDb = () => {
  db.close();
};

export default db;
