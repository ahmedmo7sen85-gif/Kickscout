import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { PermanentJobError } from '../errors.js';
import type { VideoStorage } from './storage.js';

/** Filesystem storage for tests and offline development: `<root>/originals/<key>` and `<root>/delivery/<key>`. */
export class LocalVideoStorage implements VideoStorage {
  constructor(readonly root: string) {}

  originalPath(key: string) {
    return this.safe('originals', key);
  }

  deliveryPath(key: string) {
    return this.safe('delivery', key);
  }

  async downloadOriginal(key: string, destPath: string, maxBytes: number) {
    const src = this.originalPath(key);
    const info = await stat(src).catch(() => null);
    if (!info) throw new PermanentJobError(`original ${key} not found in storage`);
    if (info.size > maxBytes) throw new PermanentJobError(`original exceeds the ${maxBytes} byte limit`);
    await copyFile(src, destPath);
    return { sizeBytes: info.size };
  }

  async uploadDelivery(key: string, srcPath: string) {
    const dest = this.deliveryPath(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(srcPath, dest);
  }

  async deleteObjects(area: 'originals' | 'delivery', keys: string[]) {
    for (const key of keys) await rm(this.safe(area, key), { force: true });
  }

  private safe(area: string, key: string) {
    const base = path.resolve(this.root, area);
    const full = path.resolve(base, key);
    if (!full.startsWith(base + path.sep)) throw new Error(`invalid object key ${key}`);
    return full;
  }
}
