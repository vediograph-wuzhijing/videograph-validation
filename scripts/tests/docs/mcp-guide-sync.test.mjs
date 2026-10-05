// SKILL-01 文档同步与卫生测试：指南↔工具名一致性、skill 卫生、craft_guide 节选上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const skillDir = join(root, 'skills/shotcraft');
const guidePath = join(root, 'docs/MCP-GUIDE.md');
const toolsPath = join(root, 'src/server/mcp-tools.ts');
// FB-03 起工具定义分布在两个文件；指南一致性检查合并读取。
// AE 冲刺起再加 mcp-ae-tools.ts（节奏表 / 帧序列 / 全片缩略图 / 节奏报告 / craft_guide）。
const toolsCode = () => [toolsPath, join(root, 'src/server/mcp-feedback-tools.ts'), join(root, 'src/server/mcp-ae-tools.ts'), join(root, 'src/server/mcp-director-tools.ts'), join(root, 'src/server/mcp-fx-tools.ts')].map((file) => readFileSync(file, 'utf8')).join('\n');
const guideMissing = existsSync(guidePath) ? false : 'MCP-GUIDE.md 尚未提交（等集成者 INT-00），提交后本测试自动启用';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (/\.(md|mjs|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('skill 目录与 MCP 指南无本机绝对路径与密钥', () => {
  const patterns = [/F:[\\/]/, /C:[\\/]Users/i, /\/home\//, /sk-[A-Za-z0-9]{16,}/, /AIza[A-Za-z0-9_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/];
  const files = [...walk(skillDir), ...walk(join(root, '.agents/skills')), ...(existsSync(guidePath) ? [guidePath] : [])];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} 命中 ${pattern}`);
  }
});

test('craft_guide 节选引擎：默认概览 ≤12k 且含文件地图', async () => {
  const { craftGuide, CRAFT_CAP } = await import('../../skills/craft-excerpt.mjs');
  const overview = craftGuide({});
  assert.ok(overview.text.length > 500 && overview.text.length <= CRAFT_CAP);
  assert.match(overview.text, /文件地图|五条通用法则/);
});
test('craft_guide 节选引擎：topic 命中平台工具、query 压缩结果', async () => {
  const { craftGuide, CRAFT_CAP } = await import('../../skills/craft-excerpt.mjs');
  const platform = craftGuide({ topic: 'platform' });
  assert.match(platform.text, /project_shot_submit/);
  assert.ok(platform.text.length <= CRAFT_CAP);
  const narrow = craftGuide({ topic: 'effects', query: '卡拉OK' });
  assert.ok(narrow.text.length < craftGuide({ topic: 'effects' }).text.length, 'query 命中应显著短于全文');
});
test('craft_guide 节选引擎：未知 topic 报错', async () => {
  const { craftGuide } = await import('../../skills/craft-excerpt.mjs');
  assert.throws(() => craftGuide({ topic: 'nope' }), /未知 topic/);
});

test('MCP 工具名与指南 §3 一致', { skip: guideMissing }, () => {
  const guide = readFileSync(guidePath, 'utf8');
  const code = toolsCode();
  const codeTools = [...code.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
  const section3 = guide.split(/^## 3\. 工具参考.*$/m)[1]?.split(/^## \d/m)[0] ?? '';
  const guideTools = [...section3.matchAll(/^\| `([a-z_]+)` \|[^\n]*$/gm)].map((m) => m[1]);
  for (const name of codeTools) assert.ok(guideTools.includes(name), `代码工具 ${name} 未写入指南 §3`);
  for (const name of guideTools) assert.ok(codeTools.includes(name), `指南 §3 的 ${name} 在 MCP 工具定义中不存在`);
});
test('server 版本与指南 toolset 行一致', { skip: guideMissing }, () => {
  const version = /name: 'videograph', version: '([0-9.]+)'/.exec(readFileSync(join(root, 'src/pdoom/mcp-server.ts'), 'utf8'))?.[1];
  assert.ok(version, 'mcp-server.ts 找不到 server version');
  const toolset = /^toolset:.*$/m.exec(readFileSync(guidePath, 'utf8'))?.[0] ?? '';
  assert.ok(toolset.includes(`\`videograph\` ${version}`), `指南 toolset 行应写 server videograph ${version}`);
});
test('MCP 工具不暴露人工闸门：无 locked、无 author 自选、不调用 accept/reject 路由', () => {
  const code = toolsCode();
  assert.doesNotMatch(code, /locked: \{ type: 'boolean' \}/, 'AI 不能改锁：patch schema 不应含 locked');
  assert.doesNotMatch(code, /enum: \['mcp', 'human'\]/, 'AI 不能自标 author=human');
  assert.doesNotMatch(code, /author: args\.author/, 'author 必须固定为 mcp');
  assert.doesNotMatch(code, /accept-(feedback|review)|reject-feedback/, 'MCP 不应调用人工接受/拒绝路由');
});
test('SKILL.md toolset 与指南一致；路线 B 工具表已生成且覆盖全部工具', { skip: guideMissing }, () => {
  const guide = readFileSync(guidePath, 'utf8');
  const date = /^toolset:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/m.exec(guide)?.[1];
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  assert.equal(/^toolset:\s*(\S+)/m.exec(skill)?.[1], date, 'SKILL.md toolset 应与 MCP-GUIDE 对齐（跑 sync-platform.mjs）');
  const platform = readFileSync(join(skillDir, 'references', 'platform-videograph.md'), 'utf8');
  const block = platform.split(/<!-- BEGIN:generated-from-MCP-GUIDE[^>]*-->/)[1]?.split(/<!-- END:generated-from-MCP-GUIDE -->/)[0] ?? '';
  assert.ok(block.trim(), '生成块为空：跑 node scripts/skills/sync-platform.mjs');
  const code = toolsCode();
  for (const name of [...code.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1])) {
    assert.ok(block.includes(`\`${name}\``), `路线 B 工具速查缺 ${name}`);
  }
});
test('SOURCES.md 覆盖无许可与受限语料的处理声明', () => {
  const sources = readFileSync(join(skillDir, 'SOURCES.md'), 'utf8');
  for (const marker of ['无许可', 'StuGRua-PDoomVideo', '待用户确认']) {
    assert.ok(sources.includes(marker), `SOURCES.md 缺少「${marker}」小节`);
  }
});
test('MCP resources / craft_guide / prompts 已注册（AE-05；运行时行为见 scripts/tests/ae/ae-tools.test.mjs）', () => {
  const serverCode = readFileSync(join(root, 'src/pdoom/mcp-server.ts'), 'utf8');
  assert.match(serverCode, /capabilities: \{ tools: \{\}, resources: \{\}, prompts: \{\} \}/);
  assert.match(serverCode, /ListResourcesRequestSchema/);
  for (const prompt of ['respond_to_feedback', 'design_rhythm']) assert.match(serverCode, new RegExp(`${prompt}:`));
  assert.match(toolsCode(), /name: 'craft_guide'/);
  assert.match(readFileSync(guidePath, 'utf8'), /videograph:\/\/skills\/shotcraft/, '指南应列出 resources URI');
});
