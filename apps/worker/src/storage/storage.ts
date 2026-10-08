/** Where originals are read from and processed outputs are written to. */
export interface VideoStorage {
  /** Streams the uploaded original to a local file. Throws if it is missing or larger than `maxBytes`. */
  downloadOriginal(key: string, destPath: string, maxBytes: number): Promise<{ sizeBytes: number }>;
  /** Uploads a processed file to the delivery bucket. */
  uploadDelivery(key: string, srcPath: string, contentType: string): Promise<void>;
}

export const playbackKey = (videoId: string) => `playback/${videoId}.mp4`;
export const thumbnailKey = (videoId: string) => `thumbs/${videoId}.jpg`;
