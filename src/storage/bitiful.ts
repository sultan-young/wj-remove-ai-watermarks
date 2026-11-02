import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';
import type { PublishedObject } from './types.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

let client: S3Client | null = null;
let clientKey = '';

function s3(config: Config): S3Client {
  const cfg = config.storage.bitiful;
  const key = `${cfg.endpoint}|${cfg.region}|${cfg.accessKey}`;
  if (!client || clientKey !== key) {
    client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    clientKey = key;
  }
  return client;
}

export function bitifulReady(config: Config): boolean {
  const cfg = config.storage.bitiful;
  return Boolean(cfg.accessKey && cfg.secretKey && cfg.bucket && cfg.publicBaseUrl);
}

/** 直传缤纷云，返回未签名公网地址。 */
export async function publishBitifulObject(config: Config, filePath: string, fileName: string): Promise<PublishedObject> {
  const cfg = config.storage.bitiful;
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.png';
  const key = `${config.storage.keyPrefix}/${randomUUID()}${ext}`;
  const body = await readFile(filePath);
  await s3(config).send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: body,
    ContentType: 'image/png',
    ContentDisposition: 'inline',
    CacheControl: CACHE_CONTROL,
  }));
  const url = `${cfg.publicBaseUrl}/${key}`;
  return { url, key, bytes: body.length };
}
