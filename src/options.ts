import { z } from 'zod';
import { profiles, upstreamPipeline, type Config } from './config.js';
export const removalModes = ['all', 'visible', 'invisible', 'metadata'] as const;
export const visibleBackends = ['auto', 'cv2', 'migan', 'lama'] as const;
/** Keys from remove-ai-watermarks 0.47.1 watermark_registry.mark_keys(), plus auto. */
export const visibleMarks = [
  'auto', 'gemini', 'doubao', 'jimeng', 'qwen', 'wan', 'kling', 'yuanbao', 'dola', 'workbuddy',
  'samsung', 'runninghub', 'baidu', 'liblib', 'liblib_pill', 'microsoft', 'generic_ai_label', 'openart', 'jimeng_pill',
] as const;
export const processingSchema = z.object({
  mode: z.enum(removalModes).default('invisible'),
  pipeline: z.enum(profiles).optional(),
  mark: z.enum(visibleMarks).default('auto'),
  sensitivity: z.enum(['auto', 'strict']).default('auto'),
  detect: z.boolean().default(true),
  backend: z.enum(visibleBackends).default('auto'),
  vendor: z.enum(['auto', 'openai', 'google', 'microsoft', 'meta']).default('auto'),
  strength: z.number().nullable().default(null),
  seed: z.number().int().nullable().default(null),
  max_resolution: z.number().int().default(0),
  controlnet_conditioning_scale: z.number().default(1),
  adaptive_polish: z.boolean().nullable().default(null),
  humanize: z.number().default(0),
  unsharp: z.number().default(0),
  tile: z.boolean().default(false),
  tile_size: z.number().int().default(1024),
  tile_overlap: z.number().int().default(128),
  cpu_offload: z.boolean().default(false),
  force: z.boolean().default(false),
  fidelity_anchor: z.boolean().default(false),
}).strict();
export const requestOptionsSchema = z.object({ processing: processingSchema.prefault({}) }).strict();
export type Options = { processing: z.output<typeof processingSchema> & { pipeline: typeof profiles[number] } };
export function parseOptions(raw: unknown, config: Config): Options {
  const result = requestOptionsSchema.parse(raw ?? {});
  const p = { ...result.processing, pipeline: result.processing.pipeline ?? upstreamPipeline };
  if (!config.enabled.includes(p.pipeline)) throw new Error(`Pipeline ${p.pipeline} is not enabled on this server`);
  if (p.mode === 'all' && (p.mark !== 'auto' || !p.detect)) throw new Error('all mode only runs the upstream auto visible pass');
  return { processing: p };
}
export const engineConfig = (options: Options) => ({
  pipeline: options.processing.pipeline,
  controlnet_conditioning_scale: options.processing.controlnet_conditioning_scale,
  cpu_offload: options.processing.cpu_offload,
});
export type EngineConfig = ReturnType<typeof engineConfig>;
