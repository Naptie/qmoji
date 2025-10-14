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
    created_at INTEGER NOT NULL
  )
`);

export interface ImageRecord {
  id: string;
  name: string;
  file_path: string;
  user_id: string;
  created_at: number;
}

export const insertImage = (name: string, filePath: string, userId: string): ImageRecord => {
  const id = randomUUID();
  const created_at = Date.now();

  const stmt = db.prepare(`
    INSERT INTO images (id, name, file_path, user_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(id, name, filePath, userId, created_at);

  return { id, name, file_path: filePath, user_id: userId, created_at };
};

export const deleteImageById = (id: string): boolean => {
  const stmt = db.prepare('DELETE FROM images WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
};

export const clearImagesByNameAndUserId = (name: string, userId: string): number => {
  const stmt = db.prepare('DELETE FROM images WHERE name = ? AND user_id = ?');
  const result = stmt.run(name, userId);
  return result.changes;
};

export const getImageById = (id: string): ImageRecord | undefined => {
  const stmt = db.prepare('SELECT * FROM images WHERE id = ?');
  return stmt.get(id) as ImageRecord | undefined;
};

export const getImagesByUserId = (userId: string): ImageRecord[] => {
  const stmt = db.prepare('SELECT * FROM images WHERE user_id = ? ORDER BY created_at DESC');
  return stmt.all(userId) as ImageRecord[];
};

export const getImagesByNameAndUserId = (name: string, userId: string): ImageRecord[] => {
  const stmt = db.prepare(
    'SELECT * FROM images WHERE name = ? AND user_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(name, userId) as ImageRecord[];
};

export const getAllImages = (): ImageRecord[] => {
  const stmt = db.prepare('SELECT * FROM images ORDER BY created_at DESC');
  return stmt.all() as ImageRecord[];
};

export const closeDb = () => {
  db.close();
};

export default db;
