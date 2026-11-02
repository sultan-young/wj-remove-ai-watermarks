import type { Config } from '../config.js';
import { ServiceError } from '../errors.js';
import { bitifulReady, publishBitifulObject } from './bitiful.js';
import type { PublishedObject } from './types.js';

export type { PublishedObject };

/** 当前后端是否已配好。未配置时任务仍可完成，结果只留在本机。 */
export function storageConfigured(config: Config): boolean {
  if (config.storage.backend === 'bitiful') return bitifulReady(config);
  return false;
}

/**
 * 把结果文件写入对象存储。
 * 换存储时只改本文件和对应实现，任务流程不用动。
 */
export async function publishResult(config: Config, filePath: string, fileName: string): Promise<PublishedObject> {
  if (config.storage.backend === 'bitiful') {
    if (!bitifulReady(config)) {
      throw new ServiceError(500, 'STORAGE_NOT_CONFIGURED', 'Bitiful storage is not configured');
    }
    return publishBitifulObject(config, filePath, fileName);
  }
  throw new ServiceError(500, 'STORAGE_NOT_CONFIGURED', `Unsupported storage backend: ${config.storage.backend}`);
}
