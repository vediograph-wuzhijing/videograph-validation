// craft-excerpt.mjs — craft_guide 工具的节选引擎（纯函数，无 MCP 依赖）。
// 集成者在 mcp-server.ts 注册 craft_guide 时 import 本文件；返回文本 ≤ 12000 字符。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = join(fileURLToPath(new URL('../..', import.meta.url)), 'skills', 'shotcraft');
export const CRAFT_TOPICS = {
  shots: 'references/shots.md',
  transitions: 'references/transitions.md',
  effects: 'references/effects.md',
  'media-styles': 'references/media-styles.md',
  pipeline: 'references/pipeline-playbook.md',
  'pv-production': 'references/pv-production.md',
  platform: 'references/platform-videograph.md',
};
export const CRAFT_CAP = 12000;

function splitSections(raw) {
  const lines = raw.split('\n');
  const sections = [];
  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) sections.push({ title: line.replace(/^#+\s*/, ''), body: '' });
    else if (sections.length) sections[sections.length - 1].body += line + '\n';
    else sections.push({ title: '(导言)', body: line + '\n' });
  }
  return sections.filter((section) => section.body.trim() || section.title !== '(导言)');
}

/**
 * topic 省略 → SKILL.md 总览；query 命中标题/正文的节按得分排序拼接。
 * 返回 { file, text, truncated, total }；text 永远 ≤ CRAFT_CAP。
 */
export function craftGuide({ topic, query } = {}) {
  const file = topic ? CRAFT_TOPICS[topic] : 'SKILL.md';
  if (!file) throw new Error(`未知 topic：${topic}；可用：${Object.keys(CRAFT_TOPICS).join(' / ')}`);
  const raw = readFileSync(join(skillRoot, file), 'utf8');
  const sections = splitSections(raw);
  let picked = sections;
  if (query) {
    const terms = String(query).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    if (terms.length) {
      picked = sections
        .map((section) => ({
          section,
          score: terms.reduce((sum, term) => sum
            + (section.title.toLowerCase().includes(term) ? 3 : 0)
            + (section.body.toLowerCase().split(term).length - 1), 0),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.section);
    }
  }
  let text = `# shotcraft 节选 · ${file}${query ? ` · query: ${String(query).slice(0, 1000)}` : ''}\n\n`;
  const suffix = `…（已达 ${CRAFT_CAP} 字符上限；完整内容读仓库 skills/shotcraft/${file}）\n`;
  const budget = CRAFT_CAP - suffix.length;
  let truncated = false;
  for (const section of picked) {
    const chunk = `## ${section.title}\n${section.body.trimEnd()}\n\n`;
    if (text.length + chunk.length > budget) {
      text += chunk.slice(0, Math.max(0, budget - text.length));
      truncated = true; break;
    }
    text += chunk;
  }
  if (truncated) text += suffix;
  return { file, text: text.trimEnd(), truncated, total: raw.length };
}
