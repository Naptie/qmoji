import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Root of the emoji store. Every stored `file_path` is relative to this. */
export const dataRoot = path.join(__dirname, '..', 'data');

/**
 * Resolve a stored relative path (`data/global/abc.jpg`) to an absolute path
 * inside the data directory.
 *
 * The stored path is always `<scope>/<file>`; the leading `data/` segment is
 * optional. Any `.` / `..` segment is dropped, so a path can never escape the
 * data directory no matter what ended up in the database.
 */
export const resolveDataPath = (relPath: string): string => {
  const segments = relPath
    .split(/[/\\]/)
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  if (segments[0] === 'data') {
    segments.shift();
  }
  return path.join(dataRoot, ...segments);
};

/**
 * Strip any directory components from a remote-supplied file name so it can
 * only ever land directly inside the target scope directory.
 */
export const safeFileName = (fileName: string): string => {
  const base = fileName.split(/[/\\]/).filter(Boolean).pop();
  return base && base !== '.' && base !== '..' ? base : 'image';
};
