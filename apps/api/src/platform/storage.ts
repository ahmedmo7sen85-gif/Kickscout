import { HeadObjectCommand, S3Client, NotFound } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStorage {
  presignPut(key: string, contentType: string, sizeBytes: number, ttlSeconds?: number): Promise<PresignedPut>;
  head(key: string): Promise<{ sizeBytes: number; contentType: string | null } | null>;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  /** Works with any S3-compatible store: AWS S3, Supabase Storage (S3 API), Cloudflare R2, MinIO. */
  constructor(
    private readonly bucket: string,
    opts: { region: string; endpoint?: string; forcePathStyle?: boolean; accessKeyId?: string; secretAccessKey?: string },
  ) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle ?? true } : {}),
      ...(opts.accessKeyId && opts.secretAccessKey ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } } : {}),
    });
  }

  async presignPut(key: string, contentType: string, sizeBytes: number, ttlSeconds = 900): Promise<PresignedPut> {
    // Content type and length are part of the signature, so the client cannot upload something else.
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) });
    return { url, headers: { 'content-type': contentType }, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  async head(key: string) {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }
}

/**
 * Public URL for a stored media key. Keys that are already absolute URLs are returned as they are: the demo
 * catalogue points at media hosted with the web app, while real uploads live in the delivery bucket behind CDN_BASE_URL.
 */
export function mediaUrl(cdnBaseUrl: string, key: string): string {
  return /^https?:\/\//.test(key) ? key : `${cdnBaseUrl}/${key}`;
}
