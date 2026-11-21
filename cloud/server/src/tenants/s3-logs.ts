import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { LogReader } from './status-service.js';
import type { StateReader } from './stats-service.js';

/**
 * The end of a job's log object, read with a range (tenants/status-service.ts). The API's role
 * may read `tenants/*\/results/*` and nothing else, not even list the bucket, so S3 answers a
 * missing object with 403 AccessDenied rather than 404 NoSuchKey: from here the two cannot be
 * told apart. Both are reported as `missing`; the service decides from the job's age whether
 * that means expired (410) or not readable (an error to look into).
 */
export function createS3LogReader(s3: Pick<S3Client, 'send'>, bucket: string): LogReader {
  return async (key, maxBytes) => {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=-${maxBytes}` }));
      const range = /\/(\d+)$/.exec(out.ContentRange ?? '');
      const text = (await out.Body?.transformToString('utf8')) ?? '';
      return { text, size: range ? Number(range[1]) : (out.ContentLength ?? text.length) };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'AccessDenied') return null;
      // An empty object cannot satisfy a suffix range.
      if (name === 'InvalidRange') return { text: '', size: 0 };
      throw err;
    }
  };
}

/**
 * A tenant's shared state database, read only when it changed (`If-None-Match`). As for logs, the
 * role cannot list the bucket, so a state object that does not exist yet answers 403: no state.
 */
export function createS3StateReader(s3: Pick<S3Client, 'send'>, bucket: string): StateReader {
  return async (key, etag) => {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(etag ? { IfNoneMatch: etag } : {}) }));
      const body = (await out.Body?.transformToByteArray()) ?? new Uint8Array();
      return { body, etag: out.ETag ?? '', ...(out.LastModified ? { lastModified: out.LastModified.toISOString() } : {}) };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotModified' || e.$metadata?.httpStatusCode === 304) return { unchanged: true };
      if (e.name === 'NoSuchKey' || e.name === 'AccessDenied') return null;
      throw err;
    }
  };
}
