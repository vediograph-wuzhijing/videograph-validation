// SONG-00 契约测试：v2 校验规则。不依赖外部数据。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ANALYSIS_SCHEMA, SongError, validateAnalysis, isInstrumental, beatsBetween, sectionsBetween } from '../../../src/song/contract.mjs';

const status = (error) => error instanceof SongError ? error.status : undefined;
const work = mkdtempSync(join(tmpdir(), 'videograph-song-'));
after(() => rmSync(work, { recursive: true, force: true }));

import { baseAnalysis } from './analysis-fixture.mjs';
const prov = (extra = {}) => ({ tool: 'test', version: '1', startedAt: 0, confidence: 1, ...extra });

test('最小器乐分析合法，lyrics 缺席即器乐', () => {
  const analysis = validateAnalysis(baseAnalysis());
  assert.equal(isInstrumental(analysis), true);
  assert.equal(analysis.sections[0].label, 'intro');
  assert.equal(analysis.rhythm.meter, 4);
});
test('带歌词且人已确认的分析合法；conf 保留', () => {
  const analysis = validateAnalysis(baseAnalysis({
    lyrics: {
      language: 'zh', textSource: 'user', humanConfirmed: true,
      lines: [{ text: '你好世界', start: 1, end: 3, words: [{ w: '你', start: 1, end: 1.5, conf: 0.9 }, { w: '好', start: 1.5, end: 2, conf: 0.8 }] }],
    },
    provenance: { audio: prov(), rhythm: prov(), sections: prov(), envelopes: prov(), onsets: prov(), lyrics: prov() },
  }));
  assert.equal(isInstrumental(analysis), false);
  assert.equal(analysis.lyrics.lines[0].words[0].conf, 0.9);
});
test('未知顶层字段、缺失 provenance 层、坏 schema 拒绝', () => {
  assert.throws(() => validateAnalysis({ ...baseAnalysis(), surprise: 1 }), /未知顶层字段/);
  const noSectionsProv = baseAnalysis();
  delete noSectionsProv.provenance.sections;
  assert.throws(() => validateAnalysis(noSectionsProv), /provenance\.sections/);
  assert.throws(() => validateAnalysis({ ...baseAnalysis(), schema: 'v1' }), /schema/);
});
test('词时间倒序与越界拒绝', () => {
  assert.throws(() => validateAnalysis(baseAnalysis({
    lyrics: {
      language: 'zh', textSource: 'user', humanConfirmed: true,
      lines: [{ text: 'ab', start: 1, end: 3, words: [{ w: 'b', start: 1, end: 1.5 }, { w: 'a', start: 1.2, end: 2 }] }],
    },
  })), /words\[1\].*递增|start/);
  assert.throws(() => validateAnalysis(baseAnalysis({
    lyrics: {
      language: 'zh', textSource: 'user', humanConfirmed: true,
      lines: [{ text: 'ab', start: 1, end: 2, words: [{ w: 'a', start: 1, end: 1.4 }, { w: 'b', start: 1.2, end: 1.3 }] }],
    },
  })), /start/);
  assert.throws(() => validateAnalysis(baseAnalysis({
    lyrics: {
      language: 'zh', textSource: 'user', humanConfirmed: true,
      lines: [{ text: 'a', start: 1, end: 20, words: [{ w: 'a', start: 1, end: 2 }] }],
    },
  })), /end/);
});
test('歌词行时间倒序拒绝', () => {
  assert.throws(() => validateAnalysis(baseAnalysis({
    lyrics: {
      language: 'en', textSource: 'user', humanConfirmed: false,
      lines: [
        { text: 'b', start: 3, end: 4, words: [{ w: 'b', start: 3, end: 4 }] },
        { text: 'a', start: 2, end: 2.5, words: [{ w: 'a', start: 2, end: 2.5 }] },
      ],
    },
  })), /按时间排列/);
});
test('段落重叠、包络长度不一致、onset 强度越界、节拍倒序拒绝', () => {
  assert.throws(() => validateAnalysis(baseAnalysis({ sections: [{ start: 0, end: 6, name: 'intro' }, { start: 5, end: 10, name: 'verse1' }] })), /重叠/);
  assert.throws(() => validateAnalysis(baseAnalysis({ envelopes: { frameRate: 100, rms: [0, 1], low: [0, 1, 0.5], mid: [0, 1], high: [0, 1] } })), /长度必须一致/);
  assert.throws(() => validateAnalysis(baseAnalysis({ onsets: { kick: [[1, 1.5]], snare: [[1.5, 0.7]], hat: [[0.25, 0.3]], vocal: [[2, 0.5]] } })), /strength/);
  assert.throws(() => validateAnalysis(baseAnalysis({ rhythm: { bpm: 120, beats: [1, 0.5], downbeats: [0], meter: 4 } })), /递增/);
  assert.throws(() => validateAnalysis(baseAnalysis({ rhythm: { bpm: 120, beats: [0, 0.5], downbeats: [12, 14], meter: 4 } })), /越过音频时长/);
});
test('bpm 与 tempoMap 至少其一；tempoMap 合法', () => {
  const { bpm, ...noBpm } = baseAnalysis().rhythm;
  const analysis = validateAnalysis(baseAnalysis({ rhythm: { ...noBpm, tempoMap: [[0, 120], [5, 90]] } }));
  assert.deepEqual(analysis.rhythm.tempoMap, [[0, 120], [5, 90]]);
  assert.throws(() => validateAnalysis(baseAnalysis({ rhythm: noBpm })), /bpm 或 tempoMap/);
});
test('overrides 记录作者与时间；坏 author 拒绝', () => {
  const analysis = validateAnalysis(baseAnalysis({ overrides: [{ layer: 'rhythm', author: 'human', at: 1, patch: { bpm: 121 }, note: 'tap tempo' }] }));
  assert.equal(analysis.overrides[0].author, 'human');
  assert.throws(() => validateAnalysis(baseAnalysis({ overrides: [{ layer: 'rhythm', author: 'ai', at: 1, patch: {} }] })), /human\/mcp/);
});
test('stems 只存内容哈希；坏哈希拒绝', () => {
  const withStems = (stems) => baseAnalysis({ stems, provenance: { audio: prov(), rhythm: prov(), sections: prov(), envelopes: prov(), onsets: prov(), stems: prov() } });
  const analysis = validateAnalysis(withStems({ vocal: 'b'.repeat(64) }));
  assert.equal(analysis.stems.vocal, 'b'.repeat(64));
  assert.throws(() => validateAnalysis(withStems({ vocal: 'F:\\music\\vocal.wav' })), /哈希/);
  assert.throws(() => validateAnalysis(withStems({ lead: 'b'.repeat(64) })), /不支持通道/);
});
test('beatsBetween / sectionsBetween 查询', () => {
  const analysis = validateAnalysis(baseAnalysis());
  assert.deepEqual(beatsBetween(analysis, 0.4, 1.6), [0.5, 1.0, 1.5]);
  assert.equal(sectionsBetween(analysis, 9, 11).length, 1);
});
test('原对象不被修改', () => {
  const raw = baseAnalysis();
  const snapshot = JSON.stringify(raw);
  validateAnalysis(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});
