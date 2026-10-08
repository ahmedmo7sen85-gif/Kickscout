import { ApiError } from './errors.js';

/** Opaque keyset cursor over (timestamp, id). */
export const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');

export function decodeCursor(cursor: string): { at: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(ts ?? '');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(at.getTime())) throw new ApiError(400, 'INVALID_CURSOR', 'cursor is invalid');
  return { at, id };
}
