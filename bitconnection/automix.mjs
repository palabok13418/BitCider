import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const AUTOMIX_SAMPLE_RATE = 22050;
export const AUTOMIX_WINDOW_FRAMES = 1500;
export const AUTOMIX_HOP_SAMPLES = 441;
export const AUTOMIX_FRAME_RATE = 50;

export const AUTOMIX_MODEL_MANIFEST = Object.freeze({
  family: 'Beat This! final0',
  source: 'https://huggingface.co/nilsbc/beat-this-onnx',
  license: 'MIT',
  note: 'The model authors note that some training sources have copyright or limited Creative Commons terms. Review the model card before commercial redistribution.',
  models: [
    {
      id: 'logmel',
      file: 'logmel.onnx',
      url: 'https://huggingface.co/nilsbc/beat-this-onnx/resolve/main/logmel.onnx',
      bytes: 4468830,
      sha256: 'f5afa499f5a42b05ea89a214561170cd4b76f92d67d3227f7c9833e8d79bbb43'
    },
    {
      id: 'beat',
      file: 'beat_this_final0.onnx',
      url: 'https://huggingface.co/nilsbc/beat-this-onnx/resolve/main/beat_this_final0.onnx',
      bytes: 83162700,
      sha256: 'a7e2c68b27f9db6a73416017f784ea8551a01373f4955a98db018827760c4a14'
    }
  ]
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calculateSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileMatches(filePath, artifact) {
  try {
    const info = await fsp.stat(filePath);
    if (!info.isFile() || info.size !== artifact.bytes) return false;
    return (await calculateSha256(filePath)) === artifact.sha256;
  } catch {
    return false;
  }
}

async function filePresent(filePath, artifact) {
  try {
    const info = await fsp.stat(filePath);
    return info.isFile() && info.size === artifact.bytes;
  } catch {
    return false;
  }
}

async function downloadArtifact(artifact, destination) {
  if (await fileMatches(destination, artifact)) return destination;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = destination + '.' + process.pid + '.part';
  await fsp.rm(temporaryPath, { force: true });

  const response = await fetch(artifact.url, {
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok || !response.body) {
    throw new Error('Could not download the ' + artifact.id + ' ONNX model (HTTP ' + response.status + ').');
  }

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > artifact.bytes) {
        callback(new Error('The ' + artifact.id + ' model download exceeded its pinned size.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
    const actualHash = hash.digest('hex');
    if (bytes !== artifact.bytes || actualHash !== artifact.sha256) {
      throw new Error('The ' + artifact.id + ' ONNX model failed its pinned size or SHA-256 check.');
    }
    await fsp.rename(temporaryPath, destination);
    return destination;
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function metadataShape(metadata, fallback) {
  const shape = Array.isArray(metadata?.shape) ? metadata.shape : [];
  if (!shape.length) return fallback;
  return shape.map((dimension, index) => {
    if (Number.isSafeInteger(dimension) && dimension > 0) return dimension;
    return fallback[index] || 1;
  });
}

function audioWindow(samples, startSample, length) {
  const result = new Float32Array(length);
  const sourceStart = Math.max(0, startSample);
  const destinationStart = Math.max(0, -startSample);
  const available = Math.max(0, Math.min(samples.length - sourceStart, length - destinationStart));
  if (available > 0) result.set(samples.subarray(sourceStart, sourceStart + available), destinationStart);
  return result;
}

function frameMajorFeatures(tensor, frames, bins) {
  const data = tensor?.data;
  if (!data || data.length < frames * bins) {
    throw new Error('The Beat This! log-mel model returned an unexpected feature tensor.');
  }
  const shape = Array.isArray(tensor.dims) ? tensor.dims.filter(value => value !== 1) : [];
  const featureCount = frames * bins;
  const result = new Float32Array(featureCount);
  const isBinMajor = shape.length >= 2 && shape[shape.length - 2] === bins && shape[shape.length - 1] === frames;
  if (isBinMajor) {
    for (let frame = 0; frame < frames; frame += 1) {
      for (let bin = 0; bin < bins; bin += 1) {
        result[frame * bins + bin] = data[bin * frames + frame];
      }
    }
  } else {
    result.set(data.subarray(0, featureCount));
  }
  return result;
}

function vectorFromTensor(tensor, label) {
  if (!tensor?.data || typeof tensor.data.length !== 'number') {
    throw new Error('The Beat This! model did not return the ' + label + ' activation tensor.');
  }
  return tensor.data;
}

function sigmoid(value) {
  const bounded = clamp(Number(value) || 0, -30, 30);
  return 1 / (1 + Math.exp(-bounded));
}

function pickPeaks(logits, radius = 3) {
  const candidates = [];
  for (let frame = 0; frame < logits.length; frame += 1) {
    const value = Number(logits[frame]);
    if (!Number.isFinite(value) || value <= 0) continue;
    let isMaximum = true;
    for (let offset = -radius; offset <= radius; offset += 1) {
      if (!offset) continue;
      const neighbour = Number(logits[frame + offset]);
      if (Number.isFinite(neighbour) && (neighbour > value || (neighbour === value && offset < 0))) {
        isMaximum = false;
        break;
      }
    }
    if (isMaximum) candidates.push({ frame, logit: value, confidence: Number(sigmoid(value).toFixed(4)) });
  }
  const peaks = [];
  for (const candidate of candidates) {
    const previous = peaks.at(-1);
    if (previous && candidate.frame - previous.frame <= radius) {
      if (candidate.logit > previous.logit) peaks[peaks.length - 1] = candidate;
    } else {
      peaks.push(candidate);
    }
  }
  return peaks.map(({ frame, confidence }) => ({ frame, confidence }));
}

function estimateBpm(beats) {
  if (beats.length < 4) return { bpm: null, confidence: 0 };
  const intervals = [];
  for (let index = 1; index < beats.length; index += 1) {
    const gap = beats[index].time - beats[index - 1].time;
    if (gap >= 0.28 && gap <= 1.5) intervals.push(gap);
  }
  const base = median(intervals);
  if (!base) return { bpm: null, confidence: 0 };
  let bpm = 60 / base;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const dispersion = intervals.length
    ? median(intervals.map(value => Math.abs(value - base))) / base
    : 1;
  return {
    bpm: Number(bpm.toFixed(2)),
    confidence: Number(clamp(1 - dispersion * 4, 0, 1).toFixed(3))
  };
}

function goertzelPower(samples, sampleRate, frequency, start) {
  const length = 4096;
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let previousPrevious = 0;
  for (let index = 0; index < length; index += 1) {
    const position = start + index;
    const sample = position < samples.length ? samples[position] : 0;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1));
    const current = sample * window + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return Math.max(0, previous * previous + previousPrevious * previousPrevious - coefficient * previous * previousPrevious);
}

function correlation(left, right) {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftPower = 0;
  let rightPower = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftPower += a * a;
    rightPower += b * b;
  }
  return numerator / Math.sqrt(Math.max(1e-12, leftPower * rightPower));
}

function estimateKey(samples) {
  if (samples.length < AUTOMIX_SAMPLE_RATE * 12) return null;
  const chroma = new Array(12).fill(0);
  const starts = [0.12, 0.24, 0.36, 0.48, 0.60, 0.72, 0.84]
    .map(position => Math.floor(Math.max(0, samples.length - 4096) * position));
  for (const start of starts) {
    for (let midi = 36; midi <= 83; midi += 1) {
      const frequency = 440 * Math.pow(2, (midi - 69) / 12);
      chroma[midi % 12] += goertzelPower(samples, AUTOMIX_SAMPLE_RATE, frequency, start);
    }
  }
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const normalized = chroma.map(value => value / total);
  let best = null;
  let second = -Infinity;
  for (let root = 0; root < 12; root += 1) {
    for (const mode of ['major', 'minor']) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = profile.map((_value, index) => profile[(index - root + 12) % 12]);
      const score = correlation(normalized, rotated);
      if (best && score > best.score) second = best.score;
      else if (best && score > second) second = score;
      if (!best || score > best.score) {
        best = { root, mode, score };
      }
    }
  }
  const camelot = best.mode === 'major' ? CAMELOT_MAJOR[best.root] + 'B' : CAMELOT_MINOR[best.root] + 'A';
  return {
    name: NOTE_NAMES[best.root] + ' ' + (best.mode === 'major' ? 'Major' : 'Minor'),
    camelot,
    confidence: Number(clamp((best.score - second) * 3, 0, 1).toFixed(3))
  };
}

function measureEnergy(samples) {
  const windowSize = AUTOMIX_SAMPLE_RATE * 2;
  const windows = [];
  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(samples.length, start + windowSize);
    let sum = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index];
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    windows.push({
      time: start / AUTOMIX_SAMPLE_RATE,
      rms,
      dbfs: Number((20 * Math.log10(Math.max(rms, 1e-7))).toFixed(2)),
      peak: Number(peak.toFixed(5))
    });
  }
  const average = windows.length
    ? Math.sqrt(windows.reduce((sum, item) => sum + item.rms * item.rms, 0) / windows.length)
    : 0;
  const averageDbfs = 20 * Math.log10(Math.max(average, 1e-7));
  const energyScore = Math.round(clamp(1 + (averageDbfs + 42) / 4.2, 1, 10));
  return {
    score: energyScore,
    rmsDbfs: Number(averageDbfs.toFixed(2)),
    peak: Number(Math.max(0, ...windows.map(item => item.peak)).toFixed(5)),
    windows
  };
}

function findSections(energyWindows, durationSeconds, bpm, beats, downbeats) {
  if (!energyWindows.length) return [];
  let strongestRise = { score: -Infinity, time: Math.min(30, durationSeconds * 0.2) };
  for (let index = 2; index < energyWindows.length; index += 1) {
    const previous = energyWindows[index - 2].dbfs;
    const current = energyWindows[index].dbfs;
    const time = energyWindows[index].time;
    if (time < durationSeconds * 0.12 || time > durationSeconds * 0.78) continue;
    const score = current - previous;
    if (score > strongestRise.score) strongestRise = { score, time };
  }
  const middle = energyWindows.filter(item => item.time > durationSeconds * 0.28 && item.time < durationSeconds * 0.82);
  const quietest = middle.reduce((best, item) => !best || item.dbfs < best.dbfs ? item : best, null);
  const beatDuration = bpm ? 60 / bpm : 0.5;
  const firstBeat = beats[0]?.time || 0;
  const firstDownbeat = downbeats[0]?.time ?? firstBeat;
  const findBeatIndex = time => {
    let index = 0;
    while (index < beats.length && beats[index].time < time) index += 1;
    return index;
  };
  const dropTime = strongestRise.score > 1.2 ? strongestRise.time : Math.min(durationSeconds * 0.58, firstDownbeat + beatDuration * 64);
  const mixOutTime = Math.max(firstDownbeat, durationSeconds - beatDuration * 32);
  const mixInTime = Math.min(dropTime, firstDownbeat + beatDuration * 32);
  const beatNumber = time => findBeatIndex(time);
  return [
    { type: 'start', time: 0, beat: 0 },
    { type: 'mix-in', time: Number(mixInTime.toFixed(3)), beat: beatNumber(mixInTime) },
    { type: 'build', time: Number(Math.max(mixInTime, dropTime - beatDuration * 16).toFixed(3)), beat: beatNumber(Math.max(mixInTime, dropTime - beatDuration * 16)) },
    { type: 'drop', time: Number(dropTime.toFixed(3)), beat: beatNumber(dropTime) },
    ...(quietest ? [{ type: 'break', time: Number(quietest.time.toFixed(3)), beat: beatNumber(quietest.time) }] : []),
    { type: 'mix-out', time: Number(mixOutTime.toFixed(3)), beat: beatNumber(mixOutTime) }
  ];
}

function analysisFromPredictions({ samples, beatPeaks, downbeatPeaks, modelDurationSeconds }) {
  const durationSeconds = samples.length / AUTOMIX_SAMPLE_RATE;
  const beats = beatPeaks.map(item => ({
    time: Number((item.frame / AUTOMIX_FRAME_RATE).toFixed(3)),
    confidence: item.confidence
  }));
  const alignedDownbeatPeaks = downbeatPeaks.map(downbeat => {
    const nearestBeat = beatPeaks.reduce((best, beat) => {
      const distance = Math.abs(beat.frame - downbeat.frame);
      return !best || distance < best.distance ? { beat, distance } : best;
    }, null);
    return nearestBeat && nearestBeat.distance <= 3
      ? { frame: nearestBeat.beat.frame, confidence: downbeat.confidence }
      : downbeat;
  }).filter((item, index, values) => values.findIndex(other => other.frame === item.frame) === index);
  const downbeats = alignedDownbeatPeaks.map(item => ({
    time: Number((item.frame / AUTOMIX_FRAME_RATE).toFixed(3)),
    confidence: item.confidence
  }));
  const tempo = estimateBpm(beats);
  const energy = measureEnergy(samples);
  const key = estimateKey(samples);
  const sections = findSections(energy.windows, durationSeconds, tempo.bpm, beats, downbeats);
  return {
    version: 1,
    model: AUTOMIX_MODEL_MANIFEST.family,
    sampleRate: AUTOMIX_SAMPLE_RATE,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    analyzedFrames: beatPeaks.length,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    key,
    energy: { score: energy.score, rmsDbfs: energy.rmsDbfs, peak: energy.peak },
    beatTimes: beats,
    downbeatTimes: downbeats,
    sections,
    cues: sections.map(section => ({
      label: section.type.toUpperCase().replace('-', ' '),
      time: section.time,
      beat: section.beat
    })),
    analysisMode: 'onnx-beat-tracker-plus-dsp',
    modelWindowSeconds: modelDurationSeconds,
    createdAt: new Date().toISOString()
  };
}

export function camelotDistance(left, right) {
  if (!left || !right) return 6;
  const parse = value => {
    const match = String(value).match(/^([1-9]|1[0-2])([AB])$/);
    return match ? { number: Number(match[1]), mode: match[2] } : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 6;
  const steps = Math.min(Math.abs(a.number - b.number), 12 - Math.abs(a.number - b.number));
  if (steps === 0 && a.mode === b.mode) return 0;
  if (steps === 0 && a.mode !== b.mode) return 0.35;
  if (steps === 1 && a.mode === b.mode) return 0.55;
  if (steps === 1 && a.mode !== b.mode) return 0.8;
  return 1;
}

function bestNextTrack(current, remaining) {
  return remaining.reduce((best, candidate) => {
    const currentBpm = Number(current.analysis.bpm);
    const candidateBpm = Number(candidate.analysis.bpm);
    const bpmDistance = currentBpm > 0 && candidateBpm > 0
      ? Math.abs(candidateBpm - currentBpm) / currentBpm
      : 1;
    const harmonicDistance = camelotDistance(current.analysis.key?.camelot, candidate.analysis.key?.camelot);
    const energyDistance = Math.abs(Number(candidate.analysis.energy?.score || 5) - Number(current.analysis.energy?.score || 5));
    const sameArtistPenalty = String(current.artist || '').toLowerCase() === String(candidate.artist || '').toLowerCase() ? 0.12 : 0;
    const score = bpmDistance * 3.2 + harmonicDistance * 1.6 + Math.abs(energyDistance - 0.7) * 0.14 + sameArtistPenalty;
    return !best || score < best.score ? { item: candidate, score } : best;
  }, null)?.item;
}

function beatAtCue(analysis, type, fallback) {
  const cue = analysis.sections?.find(item => item.type === type);
  return Number.isFinite(cue?.beat) ? cue.beat : fallback;
}

function transitionFor(outgoing, incoming) {
  const from = outgoing.analysis;
  const to = incoming.analysis;
  const fromBpm = Number(from.bpm) || 0;
  const toBpm = Number(to.bpm) || 0;
  const ratio = fromBpm > 0 && toBpm > 0 ? fromBpm / toBpm : 1;
  const tempoSafe = ratio >= 0.92 && ratio <= 1.08;
  const keyDistance = camelotDistance(from.key?.camelot, to.key?.camelot);
  const keySafe = keyDistance <= 0.55;
  const lengthBeats = fromBpm && toBpm && tempoSafe ? 32 : 16;
  const startBeat = beatAtCue(from, 'mix-out', Math.max(0, (from.beatTimes?.length || 1) - 32));
  const incomingBeat = beatAtCue(to, 'mix-in', 0);
  const transitionStyle = !tempoSafe ? 'echo-out'
    : keySafe ? 'bass-swap'
      : 'filter-sweep';
  const points = [
    { beat: 0, outgoingGain: 1, incomingGain: 0, outgoingLow: 1, incomingLow: 0, outgoingHigh: 1, incomingHigh: 0.25, filter: 1, echoSend: 0 },
    { beat: Math.round(lengthBeats * 0.25), outgoingGain: 0.92, incomingGain: 0.28, outgoingLow: 0.9, incomingLow: 0.08, outgoingHigh: 0.8, incomingHigh: 0.55, filter: 0.9, echoSend: 0 },
    { beat: Math.round(lengthBeats * 0.5), outgoingGain: 0.72, incomingGain: 0.7, outgoingLow: 0.15, incomingLow: 0.85, outgoingHigh: 0.7, incomingHigh: 0.85, filter: 1, echoSend: 0.08 },
    { beat: Math.round(lengthBeats * 0.75), outgoingGain: 0.28, incomingGain: 0.94, outgoingLow: 0, incomingLow: 1, outgoingHigh: 0.38, incomingHigh: 1, filter: 1.15, echoSend: transitionStyle === 'echo-out' ? 0.55 : 0.18 },
    { beat: lengthBeats, outgoingGain: 0, incomingGain: 1, outgoingLow: 0, incomingLow: 1, outgoingHigh: 0, incomingHigh: 1, filter: 1, echoSend: 0 }
  ];
  return {
    fromQueueItemId: outgoing.queueItemId,
    toQueueItemId: incoming.queueItemId,
    style: transitionStyle,
    phraseAligned: true,
    startAtOutgoingBeat: startBeat,
    startAtIncomingBeat: incomingBeat,
    lengthBeats,
    sourceBpm: fromBpm,
    targetBpm: toBpm,
    incomingTempoRatio: Number((tempoSafe ? ratio : 1).toFixed(5)),
    tempoChangePercent: Number(((tempoSafe ? ratio : 1) * 100 - 100).toFixed(2)),
    harmonicDistance: Number(keyDistance.toFixed(3)),
    keyCompatible: keySafe,
    automation: points,
    effects: transitionStyle === 'echo-out'
      ? [{ type: 'echo', startBeat: Math.round(lengthBeats * 0.68), endBeat: lengthBeats, feedback: 0.32 }, { type: 'filter-sweep', startBeat: Math.round(lengthBeats * 0.75), endBeat: lengthBeats }]
      : [{ type: 'filter-sweep', startBeat: 0, endBeat: Math.round(lengthBeats * 0.35) }, { type: 'reverb-send', startBeat: Math.round(lengthBeats * 0.72), endBeat: lengthBeats, amount: 0.14 }]
  };
}

export function buildAutoMixPlan(queue, { smartOrder = true } = {}) {
  const analyzed = (Array.isArray(queue) ? queue : [])
    .filter(item => item && item.autoMixAnalysis && Number.isFinite(Number(item.autoMixAnalysis.bpm)))
    .map(item => ({ ...item, analysis: item.autoMixAnalysis }));
  if (analyzed.length < 2) {
    const error = new Error('At least two analyzed tracks are required before AutoMix can create a DJ transition plan.');
    error.code = 'AUTOMIX_NEEDS_TWO_ANALYZED_TRACKS';
    throw error;
  }

  let ordered = analyzed;
  if (smartOrder) {
    const remaining = [...analyzed];
    ordered = [remaining.shift()];
    while (remaining.length) {
      ordered.push(bestNextTrack(ordered[ordered.length - 1], remaining));
      remaining.splice(remaining.indexOf(ordered[ordered.length - 1]), 1);
    }
  }

  const transitions = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    transitions.push(transitionFor(ordered[index], ordered[index + 1]));
  }
  return {
    version: 1,
    engine: 'BitConnection AutoMix DJ Planner',
    model: AUTOMIX_MODEL_MANIFEST.family,
    orderedQueueItemIds: ordered.map(item => item.queueItemId),
    tracks: ordered.map(item => ({
      queueItemId: item.queueItemId,
      videoId: item.videoId,
      title: item.title,
      artist: item.artist,
      bpm: item.analysis.bpm,
      key: item.analysis.key,
      energy: item.analysis.energy?.score,
      cues: item.analysis.cues || []
    })),
    transitions,
    execution: {
      mode: 'plan-only',
      playerControlConnected: false,
      message: 'The DJ plan is ready. Live execution remains blocked until the BitChord player-control bridge can load, sync, tempo-match and automate the player.'
    },
    createdAt: new Date().toISOString()
  };
}

export function createAutoMixService({ directory }) {
  if (!directory) throw new TypeError('An AutoMix model directory is required.');
  const modelsDirectory = path.resolve(directory, 'models');
  const sessionsDirectory = path.resolve(directory, 'sessions');
  const modelPaths = Object.fromEntries(AUTOMIX_MODEL_MANIFEST.models.map(model => [model.id, path.join(modelsDirectory, model.file)]));
  let runtime = null;
  let sessions = null;
  let loadPromise = null;
  let lastError = null;

  async function status() {
    const availability = {};
    for (const artifact of AUTOMIX_MODEL_MANIFEST.models) {
      availability[artifact.id] = await filePresent(modelPaths[artifact.id], artifact);
    }
    return {
      engine: 'BitConnection AutoMix',
      state: sessions ? 'ready-for-analysis' : lastError ? 'load-failed' : Object.values(availability).every(Boolean) ? 'models-present-runtime-not-loaded' : 'models-not-downloaded',
      runtime: 'onnxruntime-node',
      runtimeLoaded: Boolean(runtime),
      modelFamily: AUTOMIX_MODEL_MANIFEST.family,
      modelLicense: AUTOMIX_MODEL_MANIFEST.license,
      models: availability,
      modelDownloadRequired: !Object.values(availability).every(Boolean),
      analysis: 'onnx-beat-and-downbeat-tracking-plus-dsp-key-energy-and-cue-estimation',
      planning: 'harmonic-ordering-phrase-alignment-bass-swap-eq-filter-and-effect-curves',
      playbackExecution: 'blocked-until-bitchord-player-control-bridge-is-connected',
      lastError
    };
  }

  async function initialize() {
    if (sessions) return sessions;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      await fsp.mkdir(modelsDirectory, { recursive: true });
      await fsp.mkdir(sessionsDirectory, { recursive: true });
      for (const artifact of AUTOMIX_MODEL_MANIFEST.models) {
        await downloadArtifact(artifact, modelPaths[artifact.id]);
      }
      runtime = await import('onnxruntime-node');
      const threadCount = clamp(Number(process.env.BITCONNECTION_AUTOMIX_THREADS) || 2, 1, 8);
      const options = {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: threadCount,
        interOpNumThreads: 1
      };
      const [logMelSession, beatSession] = await Promise.all([
        runtime.InferenceSession.create(modelPaths.logmel, options),
        runtime.InferenceSession.create(modelPaths.beat, options)
      ]);
      if (!logMelSession.inputNames.length || !logMelSession.outputNames.length
        || !beatSession.inputNames.length || beatSession.outputNames.length < 2) {
        throw new Error('The downloaded Beat This! ONNX graphs do not expose the expected input/output tensors.');
      }
      sessions = { logMelSession, beatSession };
      lastError = null;
      return sessions;
    })().catch(error => {
      sessions = null;
      runtime = null;
      lastError = String(error?.message || error).slice(0, 300);
      throw error;
    }).finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  async function analyzePcm(pcmBuffer, { sampleRate = AUTOMIX_SAMPLE_RATE } = {}) {
    if (!(pcmBuffer instanceof Uint8Array) || pcmBuffer.byteLength < 4 || pcmBuffer.byteLength % 4 !== 0) {
      throw new TypeError('Audio must be little-endian Float32 PCM with a byte length divisible by four.');
    }
    if (sampleRate !== AUTOMIX_SAMPLE_RATE) {
      throw new RangeError('The AutoMix analysis endpoint currently accepts 22050 Hz mono Float32 PCM.');
    }
    const sampleCount = pcmBuffer.byteLength / 4;
    const maximumSamples = AUTOMIX_SAMPLE_RATE * 8 * 60;
    if (sampleCount > maximumSamples) throw new RangeError('AutoMix analysis is limited to eight minutes per track.');
    const samples = new Float32Array(sampleCount);
    const view = new DataView(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
    for (let index = 0; index < sampleCount; index += 1) {
      const value = view.getFloat32(index * 4, true);
      samples[index] = Number.isFinite(value) ? clamp(value, -1, 1) : 0;
    }

    const { logMelSession, beatSession } = await initialize();
    const inputMetadata = logMelSession.inputMetadata[0];
    const inputName = logMelSession.inputNames[0];
    const logMelOutputName = logMelSession.outputNames[0];
    const audioShapeHint = metadataShape(inputMetadata, [661059]);
    const audioSampleLength = audioShapeHint[audioShapeHint.length - 1] || 661059;
    const audioFrames = Math.ceil(samples.length / AUTOMIX_HOP_SAMPLES);
    const windowStepFrames = AUTOMIX_WINDOW_FRAMES - 12;
    const windowCount = Math.max(1, Math.ceil(audioFrames / windowStepFrames));
    const combinedBeat = new Float32Array(audioFrames);
    const combinedDownbeat = new Float32Array(audioFrames);

    for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
      const globalFrameStart = windowIndex * windowStepFrames;
      const sampleStart = globalFrameStart * AUTOMIX_HOP_SAMPLES - 6 * AUTOMIX_HOP_SAMPLES;
      const audio = audioWindow(samples, sampleStart, audioSampleLength);
      const audioShape = inputMetadata?.shape?.length ? metadataShape(inputMetadata, [audioSampleLength]) : [audioSampleLength];
      const audioTensor = new runtime.Tensor('float32', audio, audioShape);
      const melResult = await logMelSession.run({ [inputName]: audioTensor });
      const melTensor = melResult[logMelOutputName];
      const features = frameMajorFeatures(melTensor, AUTOMIX_WINDOW_FRAMES, 128);
      const beatMetadata = beatSession.inputMetadata[0];
      const beatShape = metadataShape(beatMetadata, [1, AUTOMIX_WINDOW_FRAMES, 128]);
      const beatTensor = new runtime.Tensor('float32', features, beatShape);
      const beatResult = await beatSession.run({ [beatSession.inputNames[0]]: beatTensor });
      const beatOutputName = beatSession.outputNames.find(name => /beat/i.test(name) && !/down/i.test(name)) || beatSession.outputNames[0];
      const downbeatOutputName = beatSession.outputNames.find(name => /down/i.test(name)) || beatSession.outputNames[1];
      const beatValues = vectorFromTensor(beatResult[beatOutputName], 'beat');
      const downbeatValues = vectorFromTensor(beatResult[downbeatOutputName], 'downbeat');
      const beatCount = Math.min(AUTOMIX_WINDOW_FRAMES, beatValues.length);
      const downbeatCount = Math.min(AUTOMIX_WINDOW_FRAMES, downbeatValues.length);
      const firstFrame = 6;
      const lastFrame = Math.min(AUTOMIX_WINDOW_FRAMES - 6, beatCount, downbeatCount);
      for (let localFrame = firstFrame; localFrame < lastFrame; localFrame += 1) {
        const globalFrame = globalFrameStart + localFrame - 6;
        if (globalFrame < 0 || globalFrame >= audioFrames) continue;
        combinedBeat[globalFrame] = beatValues[localFrame];
        combinedDownbeat[globalFrame] = downbeatValues[localFrame];
      }
    }

    const beatPeaks = pickPeaks(combinedBeat);
    const downbeatPeaks = pickPeaks(combinedDownbeat);
    return analysisFromPredictions({
      samples,
      beatPeaks,
      downbeatPeaks,
      modelDurationSeconds: AUTOMIX_WINDOW_FRAMES / AUTOMIX_FRAME_RATE
    });
  }

  return {
    status,
    initialize,
    analyzePcm,
    modelsDirectory
  };
}
