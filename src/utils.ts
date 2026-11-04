import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path, { resolve } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.json' with { type: 'json' };
import { dataRoot, resolveDataPath, safeFileName } from './paths.js';

export { dataRoot, resolveDataPath, safeFileName };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const allowlistPath = resolve(__dirname, '../allowlist.json');
export const blocklistPath = resolve(__dirname, '../blocklist.json');

/**
 * Read a JSON file, falling back to `fallback` when it is missing or corrupt.
 *
 * A corrupt file is moved aside (never overwritten) so the original bytes stay
 * available for recovery, and the caller can write a fresh valid file.
 */
export const readJsonSafe = <T>(targetPath: string, fallback: T): T => {
  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[qmoji] Failed to read ${targetPath}:`, error);
    }
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const quarantinePath = `${targetPath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(targetPath, quarantinePath);
      console.error(
        `[qmoji] ${targetPath} is not valid JSON (${error}); moved to ${quarantinePath}`
      );
    } catch (renameError) {
      console.error(
        `[qmoji] ${targetPath} is not valid JSON (${error}); could not move it aside:`,
        renameError
      );
    }
    return fallback;
  }
};

/**
 * Write JSON atomically: write to a sibling temp file, then rename over the
 * target. `rename` is atomic within a filesystem, so a crash mid-write can
 * never leave a half-written file behind.
 */
export const writeJsonAtomic = async (targetPath: string, value: unknown): Promise<void> => {
  const tmpPath = `${targetPath}.tmp`;
  await fsPromises.writeFile(tmpPath, JSON.stringify(value), 'utf-8');
  await fsPromises.rename(tmpPath, targetPath);
};

/** Synchronous variant, for use while the module is still initialising. */
export const writeJsonAtomicSync = (targetPath: string, value: unknown): void => {
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value), 'utf-8');
  fs.renameSync(tmpPath, targetPath);
};

if (!fs.existsSync(allowlistPath)) {
  writeJsonAtomicSync(allowlistPath, { users: config.admins });
}

if (!fs.existsSync(blocklistPath)) {
  writeJsonAtomicSync(blocklistPath, { users: [] });
}

/**
 * The access lists are read once at start-up.
 *
 * A malformed file used to throw during module import, which took the whole
 * process down and turned into a restart loop (the bot could not even be
 * talked to any more). A corrupt file is now moved aside and the defaults are
 * used instead, so the bot always comes up.
 */
export const allowlist = readJsonSafe<{ users?: number[]; groups?: number[] }>(allowlistPath, {
  users: config.admins
});

export const blocklist = readJsonSafe<{ users?: number[] }>(blocklistPath, { users: [] });

export const downloadImage = async (
  url: string,
  userId: string,
  fileName: string
): Promise<string> => {
  // Create scope directory if it doesn't exist
  const userDir = path.join(dataRoot, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  // Download the image
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Save to disk. The remote file name is content addressed by QQ, so the same
  // image always maps to the same path inside a scope; several rows may
  // therefore share one file (see countImagesByFilePath in db.ts).
  const name = safeFileName(fileName);
  const filePath = path.join(userDir, name);
  fs.writeFileSync(filePath, buffer);

  // Return a relative path for database storage. Always POSIX separators so the
  // stored value is identical no matter which platform wrote it.
  return `data/${userId}/${name}`;
};

export const deleteImage = (filePath: string): void => {
  const fullPath = resolveDataPath(filePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
};

/** Move a stored file, creating the target scope directory if needed. */
export const moveDataFile = async (fromRel: string, toRel: string): Promise<void> => {
  const from = resolveDataPath(fromRel);
  const to = resolveDataPath(toRel);
  await fsPromises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsPromises.rename(from, to);
  } catch {
    // Different filesystem (or rename not permitted): fall back to copy+unlink.
    await fsPromises.copyFile(from, to);
    await fsPromises.unlink(from);
  }
};

/** Copy a stored file, creating the target scope directory if needed. */
export const copyDataFile = async (fromRel: string, toRel: string): Promise<void> => {
  const from = resolveDataPath(fromRel);
  const to = resolveDataPath(toRel);
  await fsPromises.mkdir(path.dirname(to), { recursive: true });
  await fsPromises.copyFile(from, to);
};

export const formatBytes = (totalSize: number): string => {
  if (totalSize === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const k = 1024;
  const i = Math.floor(Math.log(totalSize) / Math.log(k));
  return `${(totalSize / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
};

export const random = <T>(items: T[]): T => {
  return items[Math.floor(Math.random() * items.length)];
};
