import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectAnalysisFile, projectManifestFile, projectDataRoot } from '../../../src/server/project-generation.mjs';

const root = mkdtempSync(join(tmpdir(), 'videograph-director-song-'));
process.env.VIDEOGRAPH_PROJECTS = join(root, 'projects');
const store = await import('../../../src/server/project-store.mjs');
const song = await import('../../../src/server/song-project.mjs');
const { runAnalysis } = await import('../../../src/song/analyzer-runner.mjs');
const { validateAnalysis } = await import('../../../src/song/contract.mjs');
const { cutFromAnchor, candidateCutPoints, validatePlan, planFromSections } = await import('../../../src/song/planner.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

const prov = () => ({ tool: 'fixture', version: '1', startedAt: 0, confidence: 0.9 });
function analysis() {
  return validateAnalysis({
    schema: 'videograph-analysis/v2',
    audio: { hash: 'a'.repeat(64), duration: 10, sampleRate: 44100, channels: 2 },
    rhythm: { bpm: 120, beatPeriod: 0.5, beats: [0, 1, 2.021, 4, 6, 8], downbeats: [0, 4, 8], meter: 4, confidence: 0.9 },
    sections: [{ start: 0, end: 2.022, name: 'intro' }, { start: 2.022, end: 10, name: 'verse' }],
    envelopes: { frameRate: 1, rms: [0, 0.5, 1] },
    onsets: { kick: [[0, 1]], snare: [[1, 0.8]], hat: [[0.5, 0.2]], vocal: [[2, 0.5]] },
    lyrics: { language: 'zh', textSource: 'user', humanConfirmed: false, lines: [
      { text: '开始', start: 2.022, end: 3, words: [{ w: '开始', start: 2.022, end: 3 }] },
    ] },
    overrides: [],
    provenance: Object.fromEntries(['audio', 'rhythm', 'sections', 'envelopes', 'onsets', 'lyrics'].map((layer) => [layer, prov()])),
  });
}

function runnerFixture(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const audioPath = join(dir, 'song.wav');
  const analyzerScript = join(dir, 'analyze.mjs');
  writeFileSync(audioPath, 'isolated fake audio');
  writeFileSync(analyzerScript, readFileSync(fileURLToPath(new URL('../song/fixtures/stub_analyzer.mjs', import.meta.url))));
  return { audioPath, analyzerScript, python: process.execPath, t3Python: process.execPath, cacheRoot: join(dir, 'cache') };
}

test('cache invalidates on lyric body changes, not just lyric presence', async () => {
  const input = runnerFixture('lyrics');
  const first = await runAnalysis({ ...input, lyricsText: '第一版' });
  const second = await runAnalysis({ ...input, lyricsText: '第二版' });
  assert.equal(second.cached, false);
  assert.notEqual(second.key, first.key);
  assert.equal(second.analysis.lyrics.lines[0].text, '第二版');
});

test('cache hashes LRC contents rather than its path', async () => {
  const input = runnerFixture('lrc');
  const lrcPath = join(root, 'lrc', 'song.lrc');
  writeFileSync(lrcPath, '[00:01.00]第一版');
  const first = await runAnalysis({ ...input, lrcPath });
  writeFileSync(lrcPath, '[00:01.00]第二版');
  const second = await runAnalysis({ ...input, lrcPath });
  assert.equal(second.cached, false);
  assert.notEqual(first.key, second.key);
  const copyPath = join(root, 'lrc', 'copy.lrc');
  writeFileSync(copyPath, '[00:01.00]第二版');
  const copied = await runAnalysis({ ...input, lrcPath: copyPath });
  assert.equal(copied.cached, true);
  assert.equal(copied.key, second.key);
});

test('ASR intent separates cache and actual stages exclude unused T3', async () => {
  const input = runnerFixture('asr');
  const plain = await runAnalysis(input);
  const asr = await runAnalysis({ ...input, asr: true });
  assert.equal(asr.cached, false);
  assert.notEqual(plain.key, asr.key);
  const explicit = await runAnalysis({ ...input, stages: ['t0', 't1'] });
  assert.equal(explicit.cached, true);
  assert.equal(explicit.key, plain.key);
  const reordered = await runAnalysis({ ...input, stages: ['t1', 't0', 't1'] });
  assert.equal(reordered.key, plain.key);
});

test('cache invalidates on analyzer entrypoint and library source changes', async () => {
  const input = runnerFixture('source');
  const library = join(root, 'source', 'analysis_lib.py');
  writeFileSync(library, '# library version 1');
  const first = await runAnalysis(input);
  writeFileSync(input.analyzerScript, readFileSync(input.analyzerScript, 'utf8') + '\n// version 2\n');
  const second = await runAnalysis(input);
  assert.equal(second.cached, false);
  assert.notEqual(second.key, first.key);
  writeFileSync(library, '# library version 2');
  const third = await runAnalysis(input);
  assert.equal(third.cached, false);
  assert.notEqual(third.key, second.key);
});

test('unused T3 does not require a separate interpreter and titles do not leak across cache', async () => {
  const input = runnerFixture('execution');
  const first = await runAnalysis({ ...input, stages: ['t0', 't1'], lyricsText: 'not aligned', t3Python: join(root, 'absent'), title: 'one' });
  const second = await runAnalysis({ ...input, stages: ['t0', 't1'], lyricsText: 'not aligned', title: 'two' });
  assert.equal(first.analysis.lyrics, undefined);
  assert.equal(second.analysis.title, 'two');
  assert.equal(second.cached, false);
});

test('plan rejects non-adjacent duplicate IDs and explicit/generated ID collisions', () => {
  const raw = analysis();
  assert.throws(() => validatePlan([{ t: 0, id: 'x' }, { t: 4, id: 'y' }, { t: 6, id: 'x' }], raw), /id 重复/);
  assert.throws(() => validatePlan([{ t: 0, id: 'shot03' }, { t: 4 }, { t: 6 }], raw), /id 重复/);
});

test('lyric anchors recheck word safety after rounding a beat to a frame', () => {
  const raw = analysis();
  // 2.021 is before the word, but rounds to 2.033333 at 30fps, inside it.
  assert.equal(cutFromAnchor(raw, { lineText: '开始' }), 1);
});

test('section anchors, candidate menu and fallback share post-frame word safety', () => {
  const raw = analysis();
  assert.equal(cutFromAnchor(raw, { sectionIndex: 1 }), 1);
  raw.sections[0].end = 2.5;
  raw.sections[1].start = 2.5;
  assert.equal(cutFromAnchor(raw, { sectionIndex: 1 }), 1);
  assert.deepEqual(candidateCutPoints(raw), [0, 1, 4, 8]);
  assert.deepEqual(planFromSections(raw, { shotRange: { min: 0, max: 12 } }).shots.map(({ start, end }) => [start, end]), [[0, 1], [1, 10]]);
  assert.throws(() => cutFromAnchor(raw, { t: 2.5 }), /词的中间/);
});

test('safe non-beat section boundaries and downbeats keep their own frame-snapped time', () => {
  const raw = analysis();
  raw.sections = [{ start: 0, end: 4.2, name: 'intro' }, { start: 4.2, end: 10, name: 'verse' }];
  raw.rhythm.downbeats = [0, 4.2, 8];
  assert.equal(cutFromAnchor(raw, { sectionIndex: 1 }), 4.2);
  assert.ok(candidateCutPoints(raw).includes(4.2));
  assert.deepEqual(planFromSections(raw).shots.map(({ start, end }) => [start, end]), [[0, 4.2], [4.2, 10]]);
});

test('section fallback deduplicates safe cutpoints and covers the exact duration', () => {
  const raw = analysis();
  raw.sections = [{ start: 0, end: 2.2, name: 'intro' }, { start: 2.2, end: 2.8, name: 'verse' }, { start: 2.8, end: 10, name: 'chorus' }];
  assert.deepEqual(planFromSections(raw, { shotRange: { min: 0, max: 12 } }).shots.map(({ start, end }) => [start, end]), [[0, 1], [1, 10]]);
});

let projectCounter = 0;
function draft() {
  const path = join(root, `fixture-${++projectCounter}.wav`);
  const bytes = Buffer.from(`temporary song fixture ${projectCounter}`);
  writeFileSync(path, bytes);
  const project = song.createSongProject(path, bytes, store.sha256(bytes), 'Operations fixture');
  return song.completeAnalysis(project.id, analysis());
}
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
function files(id) {
  const dir = store.projectDir(id), project = store.readProject(id), data = projectDataRoot(dir, project);
  return [projectAnalysisFile(dir, project), join(data, 'audio.json'), join(data, 'lyrics.json'), projectManifestFile(dir, project)].map((file) => readFileSync(file, 'utf8'));
}

test('rhythm/sections replacement preserves originals, derives engine/song and revokes confirmation', () => {
  assert.equal(typeof song.patchSongAnalysis, 'function');
  const initial = draft();
  const confirmed = song.confirmSongAnalysis(initial.id, 'mcp');
  const original = json(projectAnalysisFile(store.projectDir(initial.id), initial));
  const patch = {
    rhythm: { bpm: 100, beatPeriod: 0.6, beats: [0.1, 0.7, 1.3, 1.9, 2.5, 3.1], downbeats: [0.1, 2.5], meter: 4, confidence: 1 },
    sections: [{ start: 0, end: 4, name: 'intro' }, { start: 4, end: 10, name: 'chorus' }],
  };
  const beforePatch = JSON.stringify(patch);
  const corrected = song.patchSongAnalysis(initial.id, confirmed.revision, patch);
  assert.equal(JSON.stringify(patch), beforePatch, 'caller input is not mutated');
  assert.equal(corrected.revision, confirmed.revision + 1);
  assert.equal(corrected.status, 'analysis-draft');
  assert.equal(corrected.analysis.confirmedBy, undefined);
  assert.equal(corrected.analysis.confirmedAt, undefined);
  assert.equal(corrected.song.bpm, 100);
  assert.deepEqual(corrected.song.beats, patch.rhythm.beats);
  assert.deepEqual(corrected.song.sections, patch.sections);
  assert.notEqual(corrected.engineHash, confirmed.engineHash);
  const dir = store.projectDir(initial.id);
  const stored = json(projectAnalysisFile(dir, corrected));
  assert.equal(stored.overrides.length, 2);
  for (const [index, layer] of ['rhythm', 'sections'].entries()) {
    const override = stored.overrides[index];
    assert.equal(override.layer, layer);
    assert.equal(override.author, 'mcp');
    assert.ok(Number.isFinite(override.at));
    assert.deepEqual(override.patch.before, { data: original[layer], provenance: original.provenance[layer] });
    assert.deepEqual(override.patch.after, stored[layer]);
    assert.equal(stored.provenance[layer].tool, 'videograph/mcp-edit');
  }
  assert.deepEqual(stored.lyrics, original.lyrics);
  assert.deepEqual(stored.onsets, original.onsets);
  const engine = json(join(projectDataRoot(dir, corrected), 'audio.json'));
  assert.equal(engine.bpm, 100);
  assert.equal(engine.beat_period, 0.6);
  assert.deepEqual(engine.beats, patch.rhythm.beats);
  assert.deepEqual(engine.sections, patch.sections);
  assert.throws(() => song.submitPlan(initial.id, corrected.revision), (error) => error.status === 409);
  const next = song.patchSongAnalysis(initial.id, corrected.revision, { sections: [{ start: 0, end: 10, name: 'verse' }] }, 'human');
  const twice = json(projectAnalysisFile(dir, next));
  assert.equal(twice.overrides.length, 3);
  assert.equal(twice.overrides[2].author, 'human');
  assert.deepEqual(twice.overrides[2].patch.before.data, stored.sections);
  assert.deepEqual(twice.overrides[0], stored.overrides[0]);
  assert.equal(next.song.sections.length, 1);
  assert.equal(song.getSongAnalysis(initial.id).provenance.sections.tool, 'videograph/human-edit');
});

test('bad/stale corrections never write files or revisions; only rhythm/sections complete layers are accepted', () => {
  assert.equal(typeof song.patchSongAnalysis, 'function');
  const project = draft();
  const before = files(project.id);
  const invalid = [null, [], {}, { lyrics: {} }, { audio: {} }, { rhythm: { bpm: 100 } }, { rhythm: { offset: 0.1 } },
    { rhythm: { bpm: 100, beats: [1, 0], downbeats: [0] } },
    { rhythm: { tempoMap: [[0, 100]], beats: [0, 1], downbeats: [0] } },
    { rhythm: { bpm: 100, beats: [0, 1], downbeats: [0], offset: 0.1 } },
    { sections: [] }, { sections: [{ start: 0, end: 6, name: 'intro' }, { start: 5, end: 10, name: 'verse' }] }];
  for (const patch of invalid) {
    assert.throws(() => song.patchSongAnalysis(project.id, project.revision, patch), (error) => error.status === 400);
    assert.deepEqual(files(project.id), before);
    assert.equal(store.readProject(project.id).revision, project.revision);
  }
  const valid = { sections: [{ start: 0, end: 10, name: 'chorus' }] };
  for (const revision of [undefined, null, project.revision - 1, '1']) {
    assert.throws(() => song.patchSongAnalysis(project.id, revision, valid), (error) => error.status === 400 || error.status === 409);
    assert.deepEqual(files(project.id), before);
  }
  assert.throws(() => song.patchSongAnalysis(project.id, project.revision, valid, 'robot'), (error) => error.status === 400);
  const confirmed = song.confirmSongAnalysis(project.id);
  assert.throws(() => song.patchSongAnalysis(project.id, project.revision, valid), (error) => error.status === 409);
  assert.deepEqual(files(project.id), before);
  const planned = song.submitPlan(project.id, confirmed.revision, [{ t: 0 }, { t: 4 }]);
  assert.throws(() => song.patchSongAnalysis(project.id, planned.revision, valid), (error) => error.status === 409);
  assert.deepEqual(files(project.id), before);
});

test('pending/failed corrections are refused and retry reuses the existing analysis input', () => {
  assert.equal(typeof song.patchSongAnalysis, 'function');
  const bytes = Buffer.from('temporary retry fixture');
  const path = join(root, 'retry.wav');
  writeFileSync(path, bytes);
  const project = song.createSongProject(path, bytes, store.sha256(bytes), 'retry', { lyricsText: '原始歌词', stages: ['t0', 't1', 't3'] });
  const input = song.analysisInput(project.id);
  assert.throws(() => song.patchSongAnalysis(project.id, project.revision, { sections: [] }), (error) => error.status === 409);
  const failed = song.failAnalysis(project.id, 'fixture failure');
  assert.throws(() => song.patchSongAnalysis(project.id, failed.revision, { sections: [] }), (error) => error.status === 409);
  const retried = song.retryAnalysis(project.id);
  assert.equal(retried.status, 'analysis-pending');
  assert.equal(retried.analysis.error, undefined);
  assert.deepEqual(song.analysisInput(project.id), input);
  assert.throws(() => song.retryAnalysis(project.id), (error) => error.status === 409);
});
