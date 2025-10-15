import fs from 'fs';
import path, { resolve } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const allowlistPath = resolve(__dirname, '../allowlist.json');

if (!fs.existsSync(allowlistPath)) {
  fs.writeFileSync(allowlistPath, JSON.stringify({ users: config.admins }));
}

export const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8')) as {
  users?: number[];
  groups?: number[];
};

export const downloadImage = async (
  url: string,
  userId: string,
  fileName: string
): Promise<string> => {
  // Create user directory if it doesn't exist
  const userDir = path.join(__dirname, '..', 'data', userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  // Download the image
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();

  // Save to disk
  const filePath = path.join(userDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(buffer));

  // Return relative path for database storage
  return path.join('data', userId, fileName);
};

export const deleteImage = (filePath: string): void => {
  const fullPath = path.join(__dirname, '..', filePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
};

export const random = <T>(items: T[]): T => {
  return items[Math.floor(Math.random() * items.length)];
};
