import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The database location can be overridden so tests can run against an
// in-memory database instead of the production store.
const dbPath = process.env.QMOJI_DB_PATH ?? path.join(__dirname, '..', 'data', 'qmoji.db');
if (dbPath !== ':memory:' && !fs.existsSync(path.dirname(dbPath))) {
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

// `file_path` is looked up on every delete (to decide whether the file is
// still referenced) and on every stats run, so it gets an index. It is
// deliberately NOT unique: QQ content-addresses image file names, so several
// rows (same or different names) may legitimately point at one file.
// `name`/`user_id` back the "list emoji by name" lookup.
db.exec('CREATE INDEX IF NOT EXISTS idx_images_file_path ON images(file_path)');
db.exec('CREATE INDEX IF NOT EXISTS idx_images_name_user ON images(name, user_id)');

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

/**
 * Move an image to another scope.
 *
 * `filePath` is updated together with `user_id` so the row and the file on
 * disk always agree. The caller is responsible for having moved/copied the
 * file first.
 */
export const updateImageScope = (id: string, userId: string, filePath: string): boolean => {
  const stmt = db.prepare('UPDATE images SET user_id = ?, file_path = ? WHERE id = ?');
  const result = stmt.run(userId, filePath, id);
  return result.changes > 0;
};

/**
 * How many rows still point at this file?
 *
 * A single file can be shared by several rows (QQ content-addresses file
 * names, so saving the same image under two names produces two rows for one
 * file). A file must only be unlinked once the LAST row referencing it is
 * gone — this count is what makes that decision safe, regardless of which
 * scope the deletion happened in.
 */
export const countImagesByFilePath = (filePath: string): number => {
  const stmt = db.prepare('SELECT COUNT(*) FROM images WHERE file_path = ?');
  return (stmt.get(filePath) as { 'COUNT(*)': number })['COUNT(*)'];
};

export const getImageById = (id: string): ImageRecord | undefined => {
  const stmt = db.prepare('SELECT * FROM images WHERE id = ?');
  return stmt.get(id) as ImageRecord | undefined;
};

/**
 * All images visible to a user in a given scope.
 *
 * `groupId` is a raw group id (not the `chat-<id>` form); `null` means "no
 * group scope". Only scopes that were actually requested are queried, so no
 * placeholder value such as `chat-null` can ever leak into the query.
 */
export const getImagesByUser = (
  userId: string | null = null,
  groupId: string | null = null,
  includeGlobal = true
): ImageRecord[] => {
  const conditions: string[] = [];
  const params: string[] = [];
  if (userId !== null) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (groupId !== null) {
    conditions.push('user_id = ?');
    params.push(`chat-${groupId}`);
  }
  if (includeGlobal) {
    conditions.push("user_id = 'global'");
  }
  if (!conditions.length) {
    return [];
  }
  const stmt = db.prepare(
    `SELECT * FROM images WHERE (${conditions.join(' or ')}) ORDER BY user_id ASC, created_at DESC`
  );
  return stmt.all(...params) as ImageRecord[];
};

export const getImagesByNameAndUser = (
  name: string,
  userId: string,
  groupId: string | null = null,
  includeGlobal = false
): ImageRecord[] => {
  const conditions: string[] = ['user_id = ?'];
  const params: string[] = [userId];
  if (groupId !== null) {
    conditions.push('user_id = ?');
    params.push(`chat-${groupId}`);
  }
  if (includeGlobal) {
    conditions.push("user_id = 'global'");
  }
  const stmt = db.prepare(
    `SELECT * FROM images WHERE name = ? AND (${conditions.join(' or ')}) ORDER BY user_id ASC, created_at DESC`
  );
  return stmt.all(name, ...params) as ImageRecord[];
};

export const getAllImages = (): ImageRecord[] => {
  const stmt = db.prepare('SELECT * FROM images ORDER BY created_at DESC');
  return stmt.all() as ImageRecord[];
};

export const getImagesBySavedBy = (savedBy: string): ImageRecord[] => {
  const stmt = db.prepare('SELECT * FROM images WHERE saved_by = ?');
  return stmt.all(savedBy) as ImageRecord[];
};

export const deleteImagesBySavedBy = (savedBy: string): number => {
  const stmt = db.prepare('DELETE FROM images WHERE saved_by = ?');
  const result = stmt.run(savedBy);
  return result.changes;
};

export const closeDb = () => {
  db.close();
};

export default db;
