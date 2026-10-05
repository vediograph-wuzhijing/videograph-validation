// 渲染管线的纯函数回归：超时、原子写、分段缓存键组成与未命中原因、镜头素材指纹、覆盖检查、fetcher 局部失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withTimeout, evalBudget, writeAtomic, shotAssetIndex, segmentParts, segmentKey, missReason, cacheSummary, assertCoverage } from '../../../src/server/render-cache.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'videograph-render-cache-'));

test('withTimeout：卡住的 promise 按时拒绝并调用清理', async () => {
  let cleaned = false;
  await assert.rejects(withTimeout(new Promise(() => {}), 30, () => { cleaned = true; return new Error('场景可能死循环'); }), /死循环/);
  assert.equal(cleaned, true);
  assert.equal(await withTimeout(Promise.resolve(7), 1000, () => new Error('x')), 7);
});

test('evalBudget：下限 60 秒，按帧数增长', () => {
  assert.equal(evalBudget(1, 2000), 60000);
  assert.equal(evalBudget(300, 2000), 600000);
});

test('writeAtomic：不留下临时文件', () => {
  const file = join(tmp, 'a.png');
  writeAtomic(file, 'one'); writeAtomic(file, 'two');
  assert.equal(readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(readdirSync(tmp).filter((name) => name.endsWith('.tmp')), []);
});

const base = { engine: 'e', host: 'h', browser: '140.0', code: 'scene A', dependency: null,
  shot: { start: 0, end: 2, params: { a: 1 }, post: {}, effects: [] }, assets: null, fps: 30, samples: 1, encoder: 'x264', scope: 'shot' };

test('missReason：只报变化的组成部分；首次为 new；全同为 artifact', () => {
  const before = segmentParts(base);
  assert.deepEqual(missReason(undefined, before), ['new']);
  assert.deepEqual(missReason(before, segmentParts({ ...base, code: 'scene B' })), ['code']);
  assert.deepEqual(missReason(before, segmentParts({ ...base, browser: '141.0' })), ['browser']);
  assert.deepEqual(missReason(before, segmentParts({ ...base, shot: { ...base.shot, params: { a: 2 } } })), ['shot']);
  assert.deepEqual(missReason(before, segmentParts(base)), ['artifact']);
  assert.notEqual(segmentKey(before), segmentKey(segmentParts({ ...base, assets: 'x' })));
});

test('cacheSummary：统计复用与重渲原因', () => {
  const summary = cacheSummary([{ cached: true }, { cached: false, missReason: ['code'] }, { cached: false, missReason: ['code', 'shot'] }]);
  assert.deepEqual(summary, { reused: 1, rendered: 2, reasons: { code: 2, shot: 1 } });
});

test('shotAssetIndex：只改某一镜的素材只改变该镜指纹', () => {
  const engine = join(tmp, 'engine');
  const pub = join(engine, 'app/public/film');
  mkdirSync(join(pub, 's01'), { recursive: true });
  mkdirSync(join(pub, 's02'), { recursive: true });
  writeFileSync(join(pub, 's01/0001.jpg'), 'a');
  writeFileSync(join(pub, 's02/0001.jpg'), 'b');
  writeFileSync(join(pub, 'kf-s03.jpg'), 'c');
  const first = shotAssetIndex(engine);
  const [a, b, c] = ['s01', 's02', 's03'].map(first);
  assert.ok(a && b && c);
  assert.equal(first('s99'), null);
  writeFileSync(join(pub, 's02/0002.jpg'), 'bb');
  utimesSync(join(pub, 's02/0001.jpg'), new Date(), new Date(Date.now() + 5000));
  const second = shotAssetIndex(engine);
  assert.equal(second('s01'), a);
  assert.notEqual(second('s02'), b);
  assert.equal(second('s03'), c);
});

test('assertCoverage：首镜不从 0、镜头间隙、未覆盖到结尾都报错', () => {
  const shots = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1, end: 2 }];
  assertCoverage(shots, 30, 60);
  assert.throws(() => assertCoverage([{ id: 'a', start: 0.5, end: 2 }], 30, 60), /不从 0 秒开始/);
  assert.throws(() => assertCoverage([{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1.2, end: 2 }], 30, 60), /不连续/);
  assert.throws(() => assertCoverage(shots, 30, 90), /覆盖整首音频/);
});
