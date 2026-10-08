import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PermanentJobError } from '../errors.js';
import type { VideoStorage } from './storage.js';

export interface S3StorageOptions {
  region: string;
  /** Set for Supabase Storage (https://<ref>.supabase.co/storage/v1/s3), R2 (https://<account>.r2.cloudflarestorage.com) or MinIO. */
  endpoint?: string | undefined;
  forcePathStyle?: boolean;
  /** When omitted the AWS SDK default chain is used (AWS_* env vars, or an instance role). */
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
  originalsBucket: string;
  deliveryBucket: string;
}

export class S3VideoStorage implements VideoStorage {
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
    });
  }

  async downloadOriginal(key: string, destPath: string, maxBytes: number) {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.originalsBucket, Key: key }));
    } catch (err) {
      if (err instanceof NoSuchKey) throw new PermanentJobError(`original ${key} not found in storage`);
      throw err;
    }
    if (res.ContentLength !== undefined && res.ContentLength > maxBytes) {
      throw new PermanentJobError(`original is ${res.ContentLength} bytes, above the ${maxBytes} byte limit`);
    }
    if (!(res.Body instanceof Readable)) throw new Error('unexpected S3 response body');
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        cb(seen > maxBytes ? new PermanentJobError(`original exceeds the ${maxBytes} byte limit`) : null, chunk);
      },
    });
    await pipeline(res.Body, limit, createWriteStream(destPath));
    return { sizeBytes: seen };
  }

  async uploadDelivery(key: string, srcPath: string, contentType: string) {
    const { size } = await stat(srcPath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.deliveryBucket,
        Key: key,
        Body: createReadStream(srcPath),
        ContentLength: size,
        ContentType: contentType,
        CacheControl: 'public, max-age=3600',
      }),
    );
  }
}
