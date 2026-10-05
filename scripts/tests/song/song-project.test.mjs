// SONG-05 新歌工程测试：建工程（通用引擎快照）→ 写入分析 → 确认（人/agent）→ 歌词修正回退 → 规划。
// 不跑 Python 分析器与浏览器（真实全链路见 scripts/song-e2e-audit.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'videograph-song-project-'));
process.env.VIDEOGRAPH_PROJECTS = join(root, 'projects');
const store = await import('../../../src/server/project-store.mjs');
const song = await import('../../../src/server/song-project.mjs');
const { analyzeProject } = await import('../../../src/server/analysis-jobs.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

const prov = () => ({ tool: 'test', version: '1', startedAt: 0, confidence: 0.9 });
function analysis({ lyrics = true } = {}) {
  const beats = Array.from({ length: 21 }, (_, i) => i * 0.5);
  return {
    schema: 'videograph-analysis/v2',
    audio: { hash: 'a'.repeat(64), duration: 10, sampleRate: 44100, channels: 2, decoderOffset: 0 },
    rhythm: { bpm: 120, beats, downbeats: beats.filter((_, i) => i % 4 === 0), meter: 4, confidence: 0.9 },
    sections: [{ start: 0, end: 4, name: 'intro' }, { start: 4, end: 10, name: 'verse' }],
    envelopes: { frameRate: 100, rms: Array.from({ length: 1001 }, () => 0.5) },
    onsets: { kick: [[0.5, 0.8], [6.5, 0.8]], snare: [[1.5, 0.7]], hat: [[0.25, 0.3]], vocal: [[2, 0.5]] },
    ...(lyrics ? { lyrics: { language: 'zh', textSource: 'user', humanConfirmed: false, lines: [
      { text: '第一句歌词', start: 2, end: 4, words: [{ w: '第一句', start: 2, end: 3 }, { w: '歌词', start: 3, end: 4 }] },
      { text: '第二句歌词', start: 6, end: 8, words: [{ w: '第二句', start: 6, end: 7 }, { w: '歌词', start: 7, end: 8 }] },
    ] } } : {}),
    overrides: [],
    provenance: { audio: prov(), rhythm: prov(), sections: prov(), envelopes: prov(), onsets: prov(), ...(lyrics ? { lyrics: prov() } : {}) },
  };
}
let audioCounter = 0;
function audioFile() {
  // 每次不同字节 → 不同指纹，且不会命中参考 BGM。
  const path = join(root, `song-${++audioCounter}.wav`);
  writeFileSync(path, Buffer.concat([Buffer.from('RIFF-test-audio-'), Buffer.from(String(audioCounter).repeat(64))]));
  return path;
}

test('非参考音频 → analysis-pending 新歌工程：通用引擎快照，不带 pdoom 绑定场景与原曲数据', () => {
  const project = store.createProjectFromAudio(audioFile(), '新歌', { lyricsText: '第一句歌词\n第二句歌词', language: 'zh' });
  assert.equal(project.status, 'analysis-pending');
  assert.equal(project.analysis.params.hasLyricsText, true);
  assert.equal(JSON.stringify(project).includes('第一句歌词'), false, '歌词原文不进工程快照');
  const engine = join(process.env.VIDEOGRAPH_PROJECTS, project.id, 'engine');
  assert.ok(existsSync(join(engine, project.audio.engineFile)));
  assert.ok(existsSync(join(engine, 'app/src/scenes/hook.ts')), '通用场景保留');
  assert.ok(existsSync(join(engine, 'app/src/scenes/_window-template.ts')));
  for (const bound of ['open', 'room', 'loom', 'paperclips']) assert.equal(existsSync(join(engine, `app/src/scenes/${bound}.ts`)), false, `${bound} 绑定原曲歌词，不应进入`);
  assert.doesNotMatch(readFileSync(join(engine, 'app/src/timeline.ts'), 'utf8'), /ly\.get\(/);
  assert.equal(existsSync(join(engine, 'data/lyrics.json')), false, '分析完成前没有任何歌词数据');
  assert.ok(store.listProjects().some((entry) => entry.id === project.id && entry.status === 'analysis-pending' && entry.duration === null), 'listProjects 不因缺少 song 崩溃');
  assert.equal(song.analysisInput(project.id).lyricsText, '第一句歌词\n第二句歌词');
});

test('参数校验：stages 必须含 t1，非法阶段拒绝', () => {
  assert.throws(() => store.createProjectFromAudio(audioFile(), 'x', { stages: ['t0'] }), /t1/);
  assert.throws(() => store.createProjectFromAudio(audioFile(), 'x', { stages: ['t9'] }), /stages/);
});

test('分析任务：成功写入草稿与引擎数据；失败转 analysis-failed 并可重试', async () => {
  const project = store.createProjectFromAudio(audioFile(), '任务');
  const failed = await analyzeProject(project.id, async () => { throw new Error('解释器不存在'); });
  assert.equal(failed.status, 'error');
  assert.equal(store.readProject(project.id).status, 'analysis-failed');
  song.retryAnalysis(project.id);
  const done = await analyzeProject(project.id, async (input) => {
    assert.match(input.audioPath, /engine[\\/]audio[\\/]song\.wav$/);
    return { cached: false, key: 'k', analysis: analysis() };
  });
  assert.equal(done.status, 'done');
  const draft = store.readProject(project.id);
  assert.equal(draft.status, 'analysis-draft');
  assert.equal(draft.song.lines.length, 2);
  assert.match(draft.engineHash, /^[0-9a-f]{64}$/);
  const engine = join(process.env.VIDEOGRAPH_PROJECTS, project.id, 'engine');
  assert.equal(JSON.parse(readFileSync(join(engine, 'data/audio.json'), 'utf8')).bpm, 120);
  assert.equal(JSON.parse(readFileSync(join(engine, 'data/lyrics.json'), 'utf8')).lines.length, 2);
  assert.throws(() => song.completeAnalysis(project.id, analysis()), /analysis-pending/, '草稿不会被重复写入覆盖');
});

test('非法分析结果被契约拒绝，工程保持 pending', async () => {
  const project = store.createProjectFromAudio(audioFile(), '坏数据');
  assert.throws(() => song.completeAnalysis(project.id, { ...analysis(), schema: 'v1' }), /schema/);
  assert.equal(store.readProject(project.id).status, 'analysis-pending');
});

async function draftProject(opts) {
  const project = store.createProjectFromAudio(audioFile(), '流程');
  await analyzeProject(project.id, async () => ({ cached: true, key: 'k', analysis: analysis(opts) }));
  return store.readProject(project.id);
}

test('读取分析：按层与时间段过滤（拍点为数字数组）', async () => {
  const project = await draftProject();
  const all = song.getSongAnalysis(project.id);
  assert.deepEqual(Object.keys(all.data).sort(), ['audio', 'lyrics', 'rhythm', 'sections']);
  assert.equal(all.data.envelopes, undefined, '包络默认不返回');
  const part = song.getSongAnalysis(project.id, new URLSearchParams({ startTime: '5', endTime: '7', layers: 'rhythm,lyrics,onsets' }));
  assert.deepEqual(part.data.rhythm.beats, [5, 5.5, 6, 6.5]);
  assert.deepEqual(part.data.lyrics.lines.map((line) => line.text), ['第二句歌词']);
  assert.deepEqual(part.data.onsets.kick, [[6.5, 0.8]]);
  assert.throws(() => song.getSongAnalysis(project.id, new URLSearchParams({ layers: 'stems2' })), /未知分析层/);
  assert.equal(JSON.stringify(part).includes(root), false, '输出不含本机路径');
});

test('确认：人与 agent 都可确认并留痕；非法来源与重复确认拒绝', async () => {
  const human = await draftProject();
  assert.equal(song.confirmSongAnalysis(human.id).analysis.confirmedBy, 'human');
  assert.throws(() => song.confirmSongAnalysis(human.id), /analysis-draft/);
  const agent = await draftProject();
  assert.throws(() => song.confirmSongAnalysis(agent.id, 'robot'), /human 或 mcp/);
  const confirmed = song.confirmSongAnalysis(agent.id, 'mcp');
  assert.equal(confirmed.status, 'analysis-confirmed');
  assert.equal(confirmed.analysis.confirmedBy, 'mcp');
});

test('歌词修正：经契约校验、刷新派生数据，确认后再改退回草稿', async () => {
  const project = await draftProject();
  const confirmed = song.confirmSongAnalysis(project.id, 'mcp');
  const lyrics = { lines: [{ text: '改过的歌词', start: 2, end: 4, words: [{ w: '改过的', start: 2, end: 3 }, { w: '歌词', start: 3, end: 4 }] }] };
  assert.throws(() => song.submitSongLyrics(project.id, confirmed.revision - 1, lyrics), /重新读取/);
  assert.throws(() => song.submitSongLyrics(project.id, confirmed.revision, { lines: [{ text: 'x', start: 9, end: 20, words: [] }] }), (error) => error.status === 400);
  const next = song.submitSongLyrics(project.id, confirmed.revision, lyrics, 'mcp');
  assert.equal(next.status, 'analysis-draft');
  assert.equal(next.analysis.confirmedBy, undefined);
  assert.deepEqual(next.song.lines.map((line) => line.text), ['改过的歌词']);
  assert.equal(song.getSongAnalysis(project.id).data.lyrics.humanConfirmed, false, 'agent 修正不标记为人工校对');
});

test('规划：未确认拒绝；agent 锚点规划生成待创作镜头与默认转场；兜底规划标注非 AI', async () => {
  const project = await draftProject();
  assert.throws(() => song.submitPlan(project.id, project.revision, [{ t: 0 }, { t: 4 }]), /analysis-confirmed/);
  const confirmed = song.confirmSongAnalysis(project.id, 'mcp');
  assert.throws(() => song.submitPlan(project.id, confirmed.revision, [{ t: 0 }, { t: 2.5 }]), /词的中间/);
  const planned = song.submitPlan(project.id, confirmed.revision, [{ t: 0, title: '开场' }, { lineText: '第二句歌词', title: '第二句' }], '按歌词切', 'mcp');
  assert.equal(planned.status, 'planned');
  assert.deepEqual(planned.shots.map(({ start, end }) => [start, end]), [[0, 6], [6, 10]]);
  assert.ok(planned.shots.every((shot) => shot.status === 'needs-generation' && shot.module === null && shot.inputRevision === 0));
  assert.equal(planned.transitions.length, 1);
  assert.equal(planned.plan.mode, 'agent');
  const source = store.readShotSource(project.id, planned.shots[0].id);
  assert.equal(source.template, true);
  assert.match(source.code, /extends Scene/);
  assert.throws(() => song.submitPlan(project.id, planned.revision, undefined), /analysis-confirmed/, '规划后不能重复规划');

  const fallback = await draftProject();
  const ok = song.confirmSongAnalysis(fallback.id);
  const auto = song.submitPlan(fallback.id, ok.revision, undefined);
  assert.equal(auto.plan.mode, 'fallback-deterministic');
  assert.ok(auto.shots.every((shot) => shot.source === 'fallback-deterministic'));
});

test('无歌词音频：不产生任何歌词（不套用旧工程）', async () => {
  const project = await draftProject({ lyrics: false });
  assert.equal(project.analysis.instrumental, true);
  assert.equal(project.song.lines.length, 0);
  const engine = join(process.env.VIDEOGRAPH_PROJECTS, project.id, 'engine');
  assert.deepEqual(JSON.parse(readFileSync(join(engine, 'data/lyrics.json'), 'utf8')).lines, []);
});

const pdoomBgm = fileURLToPath(new URL('../../../../pdoom-video/audio/pdoom.mp3', import.meta.url));
test('回归：pdoom 原 BGM 仍走指纹导入（22 镜头、无新歌状态、音频缺省 pdoom.mp3）', { skip: !existsSync(pdoomBgm) && '本机没有 ../pdoom-video 参考仓库' }, () => {
  const project = store.createProjectFromAudio(pdoomBgm, '参考');
  assert.equal(project.status, undefined);
  assert.equal(project.analysis.source, 'fingerprint-cache');
  assert.equal(project.shots.length, 22);
  assert.equal(project.audio.engineFile, undefined);
  assert.ok(existsSync(join(process.env.VIDEOGRAPH_PROJECTS, project.id, 'engine/audio/pdoom.mp3')));
});
