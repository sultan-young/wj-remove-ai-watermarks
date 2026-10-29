import { z } from 'zod';
import { profiles, type Config } from './config.js';
export const removalModes = ['all', 'visible', 'invisible', 'metadata'] as const;
export const visibleBackends = ['auto', 'cv2', 'migan', 'lama'] as const;
export const processingSchema = z.object({
  mode: z.enum(removalModes).default('invisible'),
  pipeline: z.enum(profiles).optional(),
  visible_mark: z.string().trim().min(1).max(64).default('auto'),
  visible_backend: z.enum(visibleBackends).default('auto'),
  vendor: z.enum(['auto', 'openai', 'google', 'microsoft', 'meta']).default('auto'),
  strength: z.number().min(0).max(1).nullable().default(null),
  seed: z.number().int().min(0).max(4294967295).default(0),
  max_resolution: z.number().int().min(0).max(16384).default(0),
  controlnet_scale: z.number().min(0).max(2).default(1),
  adaptive_polish: z.enum(['default', 'on', 'off']).default('default'),
  humanize: z.number().min(0).max(10).default(0),
  unsharp: z.number().min(0).max(5).default(0),
  tile: z.boolean().default(false),
  tile_size: z.number().int().min(256).max(4096).default(1024),
  tile_overlap: z.number().int().min(0).max(2048).default(128),
  cpu_offload: z.boolean().default(false),
  force: z.boolean().default(true),
  fidelity_anchor: z.boolean().default(false),
}).strict();
export const requestOptionsSchema = z.object({ processing: processingSchema.prefault({}) }).strict();
export type Options = { processing: z.output<typeof processingSchema> & { pipeline: typeof profiles[number] } };
export function parseOptions(raw: unknown, config: Config): Options {
  const result = requestOptionsSchema.parse(raw ?? {});
  const p = { ...result.processing, pipeline: result.processing.pipeline ?? config.defaultPipeline };
  if (!config.enabled.includes(p.pipeline)) throw new Error('Pipeline is not enabled on this server');
  if (p.tile_overlap >= p.tile_size) throw new Error('tile_overlap must be smaller than tile_size');
  if (p.tile_size % 8 || p.tile_overlap % 8) throw new Error('Tile geometry must be a multiple of 8');
  if (p.fidelity_anchor && p.pipeline !== 'qwen-zimage') throw new Error('fidelity_anchor requires qwen-zimage');
  return { processing: p };
}
export const engineConfig = (options: Options) => ({
  pipeline: options.processing.pipeline,
  controlnet_scale: options.processing.controlnet_scale,
  cpu_offload: options.processing.cpu_offload,
});
export type EngineConfig = ReturnType<typeof engineConfig>;
