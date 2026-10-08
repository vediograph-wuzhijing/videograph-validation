// SONG-03 scene-lint 测试：ly.get 字面量必须存在于本工程歌词。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSceneCode, assertSceneLint } from '../../../src/song/scene-lint.mjs';
import { SongError } from '../../../src/song/contract.mjs';

const analysis = {
  audio: { duration: 10 },
  lyrics: { lines: [{ text: 'I see sparks of AGI in your eyes', words: [] }, { text: '第二句中文歌词', words: [] }] },
};

test('引用存在的歌词通过', () => {
  const code = `const line = ly.get('I see sparks of AGI in your eyes');`;
  assert.deepEqual(lintSceneCode(code, analysis), { ok: true, violations: [] });
});
test('引用不存在的歌词拒绝', () => {
  const code = `const line = ly.get("some other song's lyric");`;
  const { ok, violations } = lintSceneCode(code, analysis);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, 'lyric-not-in-song');
  assert.throws(() => assertSceneLint(code, analysis), SongError);
});
test('子串引用也校验；无 ly.get 的场景通过；空代码拒绝', () => {
  assert.equal(lintSceneCode("const part = ly.get('sparks of AGI');", analysis).ok, true, '歌词行内子串合法');
  assert.equal(lintSceneCode('export default class X {}', analysis).ok, true);
  assert.equal(lintSceneCode('', analysis).ok, false);
});
test('注释和展示字符串不冒充调用；真实转义字面量按语法解析',()=>{
  assert.equal(lintSceneCode("// 不要 ly.get('原句')\nconst help=\"ly.get('old lyric')\";",analysis).ok,true);
  assert.equal(lintSceneCode("ly.get('第二句\\u4e2d文歌词');",analysis).ok,true);
});
