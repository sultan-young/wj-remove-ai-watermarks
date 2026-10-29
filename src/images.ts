import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import sharp from 'sharp';
import { ServiceError } from './errors.js';
export async function saveLimited(source: Readable, dest: string, max: number) {
  let bytes = 0;
  await pipeline(source, new Transform({ transform(chunk, _enc, cb) {
    bytes += chunk.length;
    cb(bytes > max ? new ServiceError(413, 'IMAGE_TOO_LARGE', 'Image exceeds byte limit') : null, chunk);
  }}), createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  return bytes;
}
export async function validateImage(file: string, maxPixels: number) {
  try {
    const meta = await sharp(file, { limitInputPixels: maxPixels, failOn: 'warning' }).metadata();
    if (!meta.width || !meta.height || !['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1)
      throw new Error('Only single-frame PNG/JPEG/WebP are supported');
    if (meta.width * meta.height > maxPixels) throw new Error('Pixel limit exceeded');
    // Decode fully so truncated files cannot pass on header metadata alone. Original bytes stay untouched.
    await sharp(file, { limitInputPixels: maxPixels, failOn: 'warning' }).stats();
    const rotated = [5, 6, 7, 8].includes(meta.orientation ?? 1);
    return { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height, format: meta.format };
  } catch {
    throw new ServiceError(422, 'INVALID_IMAGE', 'Unreadable, oversized, animated or unsupported image');
  }
}
