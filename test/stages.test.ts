import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginStage, finishOpenStage, progressFromStages, publicStages, sealStage, type StageClock } from '../src/stages.js';

function clock(stage = 'queued'): StageClock {
  return { stage, stages: [] };
}

test('beginStage records durations and reuses open stage for tqdm updates', () => {
  const c = clock();
  beginStage(c, 'global_pass', { label: 'Canny' }, 1_000);
  beginStage(c, 'global_pass', { step: 1, steps: 4 }, 2_000);
  beginStage(c, 'global_pass', { step: 4, steps: 4 }, 5_000);
  assert.equal(c.stages.length, 1);
  assert.deepEqual(c.stages[0]!.detail, { label: 'Canny', step: 4, steps: 4 });
  assert.deepEqual(progressFromStages(c), { step: 4, steps: 4 });
  beginStage(c, 'detecting_faces', undefined, 6_000);
  assert.equal(c.stages.length, 2);
  assert.equal(c.stages[0]!.duration_seconds, 5);
  assert.equal(c.stages[0]!.finished_at, new Date(6_000).toISOString());
  assert.equal(progressFromStages(c), null);
});

test('progress ignores weight-load bars outside global_pass/face_pass', () => {
  const c = clock();
  beginStage(c, 'loading_face_models', { step: 141, steps: 314 }, 1_000);
  assert.equal(progressFromStages(c), null);
  beginStage(c, 'face_pass', { face_index: 1, face_count: 1, step: 2, steps: 8 }, 2_000);
  assert.deepEqual(progressFromStages(c), { step: 2, steps: 8 });
});

test('face_pass appends a new entry when face_index changes', () => {
  const c = clock();
  beginStage(c, 'face_pass', { face_index: 1, face_count: 2 }, 10);
  beginStage(c, 'face_pass', { face_index: 1, face_count: 2, step: 3, steps: 8 }, 20);
  assert.equal(c.stages.length, 1);
  beginStage(c, 'face_pass', { face_index: 2, face_count: 2 }, 30);
  assert.equal(c.stages.length, 2);
  assert.equal(c.stages[0]!.duration_seconds, 0.02);
  assert.equal(c.stages[1]!.detail?.face_index, 2);
});

test('sealStage closes the timeline on a terminal stage', () => {
  const c = clock();
  beginStage(c, 'preparing', undefined, 100);
  sealStage(c, 'completed', 250);
  const stages = publicStages(c);
  assert.equal(stages.length, 2);
  assert.equal(stages[0]!.stage, 'preparing');
  assert.equal(stages[0]!.duration_seconds, 0.15);
  assert.equal(stages[1]!.stage, 'completed');
  assert.ok(stages[1]!.finished_at);
  assert.equal(progressFromStages(c), null);
  finishOpenStage(c, 300);
  assert.equal(stages[1]!.duration_seconds, stages[1]!.duration_seconds);
});
