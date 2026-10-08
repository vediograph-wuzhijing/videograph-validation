// scene-lint.mjs — SONG-03 静态检查：场景源码里 ly.get('字面量') 的文本必须存在于本工程歌词。
// 不满足的提交必须拒绝（避免换歌后运行时才崩）。纯函数；接线（submitShotSource 调用）由集成者完成。
import { SongError } from './contract.mjs';
import ts from 'typescript';

/** 返回 { ok, violations }：violations 每项 { kind, detail }。 */
export function lintSceneCode(code, analysis) {
  const violations = [];
  if (typeof code !== 'string' || !code.trim()) return { ok: false, violations: [{ kind: 'empty-code', detail: '场景源码为空' }] };
  const lineTexts = new Set((analysis.lyrics?.lines ?? []).map((line) => line.text));
  const allText = [...lineTexts].join('\n');
  const source=ts.createSourceFile('scene.ts',code,ts.ScriptTarget.Latest,true);
  function visit(node) {
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='get'&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='ly') {
      const argument=node.arguments[0];
      if(argument&&(ts.isStringLiteral(argument)||ts.isNoSubstitutionTemplateLiteral(argument))) {
      const literal=argument.text;
      if (!lineTexts.has(literal) && !allText.includes(literal)) {
        violations.push({ kind: 'lyric-not-in-song', detail: `ly.get("${literal}") 不存在于本工程歌词（换歌会抛错；请改用窗口歌词 linesIn/词级时间）` });
      }
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
  return { ok: violations.length === 0, violations };
}

/** 供 submitShotSource 使用的断言式入口：违规抛 SongError。 */
export function assertSceneLint(code, analysis) {
  const { ok, violations } = lintSceneCode(code, analysis);
  if (!ok) throw new SongError(`场景静态检查未通过：${violations.map((violation) => violation.detail).join('；')}`);
  return true;
}
