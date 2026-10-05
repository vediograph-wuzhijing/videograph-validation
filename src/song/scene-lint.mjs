// scene-lint.mjs — SONG-03 静态检查：场景源码里 ly.get('字面量') 的文本必须存在于本工程歌词。
// 不满足的提交必须拒绝（避免换歌后运行时才崩）。纯函数；接线（submitShotSource 调用）由集成者完成。
import { SongError } from './contract.mjs';

// 允许转义引号；模板字符串只检查不含 ${} 插值的字面量，变量参数无法静态判断。
const LY_GET_PATTERNS = [
  /\bly\.get\(\s*'((?:\\.|[^'\\\n])+)'\s*[),]/g,
  /\bly\.get\(\s*"((?:\\.|[^"\\\n])+)"\s*[),]/g,
  /\bly\.get\(\s*`((?:\\.|[^`\\$])+)`\s*[),]/g,
];
const unescape = (literal) => literal.replace(/\\(.)/g, '$1');

/** 返回 { ok, violations }：violations 每项 { kind, detail }。 */
export function lintSceneCode(code, analysis) {
  const violations = [];
  if (typeof code !== 'string' || !code.trim()) return { ok: false, violations: [{ kind: 'empty-code', detail: '场景源码为空' }] };
  const lineTexts = new Set((analysis.lyrics?.lines ?? []).map((line) => line.text));
  const allText = [...lineTexts].join('\n');
  for (const pattern of LY_GET_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const literal = unescape(match[1]);
      if (!lineTexts.has(literal) && !allText.includes(literal)) {
        violations.push({ kind: 'lyric-not-in-song', detail: `ly.get("${literal}") 不存在于本工程歌词（换歌会抛错；请改用窗口歌词 linesIn/词级时间）` });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/** 供 submitShotSource 使用的断言式入口：违规抛 SongError。 */
export function assertSceneLint(code, analysis) {
  const { ok, violations } = lintSceneCode(code, analysis);
  if (!ok) throw new SongError(`场景静态检查未通过：${violations.map((violation) => violation.detail).join('；')}`);
  return true;
}
