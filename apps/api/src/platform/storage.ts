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

  constructor(private readonly bucket: string, region: string, endpoint?: string) {
    this.client = new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });
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
