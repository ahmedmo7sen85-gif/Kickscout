/** Where originals are read from and processed outputs are written to. */
export interface VideoStorage {
  /** Streams the uploaded original to a local file. Throws if it is missing or larger than `maxBytes`. */
  downloadOriginal(key: string, destPath: string, maxBytes: number): Promise<{ sizeBytes: number }>;
  /** Uploads a processed file to the delivery bucket. */
  uploadDelivery(key: string, srcPath: string, contentType: string): Promise<void>;
  /** Uploads a processed file to private quarantine storage (the originals bucket): never publicly reachable. */
  uploadPrivate(key: string, srcPath: string, contentType: string): Promise<void>;
  /** Streams any stored object to a local file (quarantined copies, published copies for a re-scan). */
  downloadObject(area: 'originals' | 'delivery', key: string, destPath: string, maxBytes: number): Promise<{ sizeBytes: number }>;
  /** Removes objects; keys that do not exist are ignored. */
  deleteObjects(area: 'originals' | 'delivery', keys: string[]): Promise<void>;
}

export const playbackKey = (videoId: string) => `playback/${videoId}.mp4`;
export const thumbnailKey = (videoId: string) => `thumbs/${videoId}.jpg`;

/** Processed copies awaiting (or kept after) a Guardian decision, in the private originals bucket. */
export const quarantinePlaybackKey = (videoId: string) => `quarantine/${videoId}/playback.mp4`;
export const quarantineThumbnailKey = (videoId: string) => `quarantine/${videoId}/thumb.jpg`;
