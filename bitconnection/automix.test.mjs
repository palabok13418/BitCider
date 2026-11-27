import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMIX_MODEL_MANIFEST, buildAutoMixPlan, camelotDistance } from './automix.mjs';

function analyzedTrack(queueItemId, { bpm = 120, camelot = '8A', energy = 7, mixInBeat = 0, mixOutBeat = 96 } = {}) {
  return {
    queueItemId,
    videoId: queueItemId.padEnd(11, 'x').slice(0, 11),
    title: 'Demo Track ' + queueItemId,
    artist: 'Demo Artist',
    autoMixAnalysis: {
      bpm,
      key: { name: 'A minor', camelot, confidence: 0.8 },
      energy: { score: energy, rmsDbfs: -15, peak: 0.91 },
      beatTimes: Array.from({ length: 128 }, (_value, index) => ({ time: index * 0.5, confidence: 0.95 })),
      downbeatTimes: Array.from({ length: 32 }, (_value, index) => ({ time: index * 2, confidence: 0.9 })),
      sections: [
        { type: 'mix-in', time: mixInBeat * (60 / bpm), beat: mixInBeat },
        { type: 'mix-out', time: mixOutBeat * (60 / bpm), beat: mixOutBeat }
      ],
      cues: []
    }
  };
}

test('pins Beat This! final0 weights and log-mel frontend', () => {
  assert.equal(AUTOMIX_MODEL_MANIFEST.family, 'Beat This! final0');
  assert.equal(AUTOMIX_MODEL_MANIFEST.license, 'MIT');
  assert.equal(AUTOMIX_MODEL_MANIFEST.models.length, 2);
  assert.equal(AUTOMIX_MODEL_MANIFEST.models.find(item => item.id === 'beat').bytes, 83162700);
  assert.equal(AUTOMIX_MODEL_MANIFEST.models.find(item => item.id === 'logmel').bytes, 4468830);
  for (const artifact of AUTOMIX_MODEL_MANIFEST.models) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.match(artifact.url, /^https:\/\/huggingface\.co\//);
  }
});

test('Camelot compatibility ranks same, relative and adjacent keys correctly', () => {
  assert.equal(camelotDistance('8A', '8A'), 0);
  assert.equal(camelotDistance('8A', '8B'), 0.35);
  assert.equal(camelotDistance('8A', '9A'), 0.55);
  assert.equal(camelotDistance('8A', '9B'), 0.8);
  assert.equal(camelotDistance('8A', '10A'), 1);
  assert.equal(camelotDistance(null, '10A'), 6);
});

test('DJ planner creates phrase-aligned harmonic transitions and automation', () => {
  const first = analyzedTrack('track-one', { bpm: 120, camelot: '8A', mixOutBeat: 96 });
  const second = analyzedTrack('track-two', { bpm: 122, camelot: '9A', mixInBeat: 16 });
  const third = analyzedTrack('track-three', { bpm: 124, camelot: '10A', mixInBeat: 16 });
  const plan = buildAutoMixPlan([first, second, third]);
  assert.equal(plan.engine, 'BitConnection AutoMix DJ Planner');
  assert.deepEqual(plan.orderedQueueItemIds, ['track-one', 'track-two', 'track-three']);
  assert.equal(plan.transitions.length, 2);
  assert.equal(plan.transitions[0].style, 'bass-swap');
  assert.equal(plan.transitions[0].phraseAligned, true);
  assert.equal(plan.transitions[0].lengthBeats, 32);
  assert.equal(plan.transitions[0].automation.length, 5);
  assert.equal(plan.transitions[0].automation[0].outgoingGain, 1);
  assert.equal(plan.transitions[0].automation.at(-1).incomingGain, 1);
  assert.equal(plan.transitions[0].keyCompatible, true);
  assert.equal(plan.execution.mode, 'plan-only');
  assert.equal(plan.execution.playerControlConnected, false);
});

test('DJ planner respects manual queue order', () => {
  const plan = buildAutoMixPlan([
    analyzedTrack('track-later', { bpm: 128, camelot: '1A' }),
    analyzedTrack('track-first', { bpm: 120, camelot: '8A' })
  ], { smartOrder: false });
  assert.deepEqual(plan.orderedQueueItemIds, ['track-later', 'track-first']);
});

test('DJ planner refuses to invent a mix with fewer than two analyzed tracks', () => {
  assert.throws(
    () => buildAutoMixPlan([analyzedTrack('only-one')]),
    error => error.code === 'AUTOMIX_NEEDS_TWO_ANALYZED_TRACKS'
  );
});
