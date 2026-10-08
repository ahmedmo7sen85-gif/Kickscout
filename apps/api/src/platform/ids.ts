import { v7 } from 'uuid';

/** Time-ordered UUIDs: index-friendly and safe to expose. */
export const newId = (): string => v7();
