import { ANALYSIS_SCHEMA } from '../../../src/song/contract.mjs';
const HASH = 'a'.repeat(64);
const prov = (extra = {}) => ({ tool: 'test', version: '1', startedAt: 0, confidence: 1, ...extra });
export function baseAnalysis(overrides = {}) {
  return {
    schema: ANALYSIS_SCHEMA,
    audio: { hash: HASH, duration: 10, sampleRate: 44100, channels: 2, decoderOffset: 0 },
    rhythm: { bpm: 120, beats: [0, 0.5, 1.0, 1.5], downbeats: [0, 2], meter: 4, confidence: 0.9 },
    sections: [{ start: 0, end: 10, name: 'intro' }],
    envelopes: { frameRate: 100, rms: [0, 0.5, 1, 0.5], low: [0, 0.1, 0.2, 0.1], mid: [0, 0.2, 0.4, 0.2], high: [0, 0, 0.1, 0] },
    onsets: { kick: [[1, 0.8]], snare: [[1.5, 0.7]], hat: [[0.25, 0.3]], vocal: [[2, 0.5]] },
    overrides: [],
    provenance: {
      audio: prov(), rhythm: prov(), sections: prov(), envelopes: prov(), onsets: prov(),
    },
    ...overrides,
  };
}

