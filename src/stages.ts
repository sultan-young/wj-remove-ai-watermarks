/** Per-stage timing for job views. Node owns the clock; workers only emit stage names. */

export type StageDetail = Record<string, unknown>;

export type StageEntry = {
  stage: string;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  detail?: StageDetail;
};

type TimedStage = StageEntry & { startedMs: number };

export type StageClock = {
  stage: string;
  stageStartedAt?: number;
  stages: TimedStage[];
};

function roundSeconds(ms: number): number {
  return Math.round(ms) / 1000;
}

function shouldReuseOpen(last: TimedStage | undefined, stage: string, detail?: StageDetail): boolean {
  if (!last || last.finished_at || last.stage !== stage) return false;
  if (stage === 'face_pass' && detail && typeof detail.face_index === 'number') {
    const prev = last.detail?.face_index;
    if (typeof prev === 'number' && prev !== detail.face_index) return false;
  }
  return true;
}

/** Start or refresh a stage. Same open stage updates detail; face_index changes append. */
export function beginStage(clock: StageClock, stage: string, detail?: StageDetail, now = Date.now()): void {
  const last = clock.stages[clock.stages.length - 1];
  if (shouldReuseOpen(last, stage, detail)) {
    if (detail && Object.keys(detail).length > 0) {
      last!.detail = { ...(last!.detail ?? {}), ...detail };
    }
    clock.stage = stage;
    return;
  }
  if (last && !last.finished_at) {
    last.finished_at = new Date(now).toISOString();
    last.duration_seconds = roundSeconds(now - last.startedMs);
  }
  const entry: TimedStage = {
    stage,
    started_at: new Date(now).toISOString(),
    finished_at: null,
    duration_seconds: null,
    startedMs: now,
  };
  if (detail && Object.keys(detail).length > 0) entry.detail = { ...detail };
  clock.stages.push(entry);
  clock.stage = stage;
  clock.stageStartedAt = now;
}

export function finishOpenStage(clock: StageClock, now = Date.now()): void {
  const last = clock.stages[clock.stages.length - 1];
  if (!last || last.finished_at) return;
  last.finished_at = new Date(now).toISOString();
  last.duration_seconds = roundSeconds(now - last.startedMs);
}

/** Close any open stage, then record a terminal stage already finished. */
export function sealStage(clock: StageClock, stage: string, now = Date.now()): void {
  beginStage(clock, stage, undefined, now);
  finishOpenStage(clock, now);
}

export function publicStages(clock: StageClock): StageEntry[] {
  return clock.stages.map(({ startedMs: _startedMs, ...rest }) => rest);
}

/** Only expose step progress for diffusion-like stages — not model-weight load bars. */
const PROGRESS_STAGES = new Set(['global_pass', 'face_pass']);

export function progressFromStages(clock: StageClock): { step: number; steps: number } | null {
  const last = clock.stages[clock.stages.length - 1];
  if (!last || last.finished_at || !PROGRESS_STAGES.has(last.stage)) return null;
  const step = last.detail?.step;
  const steps = last.detail?.steps;
  if (typeof step === 'number' && typeof steps === 'number' && steps > 0) return { step, steps };
  return null;
}

export const KNOWN_STAGES = [
  'queued', 'preparing', 'loading_models', 'routing', 'visible', 'metadata',
  'global_pass', 'detecting_faces', 'loading_face_models', 'face_pass',
  'postprocessing', 'text_restoration', 'mock_processing', 'validating_output',
  'completed', 'failed', 'cancelled',
] as const;
