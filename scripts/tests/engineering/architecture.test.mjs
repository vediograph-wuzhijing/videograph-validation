import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sourceGraph, architectureProblems } from '../../check-architecture.mjs';

function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'vg-architecture-'));
  try {
    for (const [name, source] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), source); }
    return architectureProblems(sourceGraph(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('真实运行时循环与找不到的本地模块会阻止检查通过', () => {
  const cycle = check({ 'src/server/a.mjs': "import './b.mjs';", 'src/server/b.mjs': "export * from './a.mjs';" });
  assert.ok(cycle.some((p) => p.includes('runtime cycle')));
  assert.ok(check({ 'src/a.ts': "import './missing';" }).some((p) => p.includes('unresolved local import')));
});
test('类型依赖和着色器文本不被误认作运行时循环', () => {
  assert.deepEqual(check({ 'src/a.ts': "import type {B} from './b'; export type A={b:B}; const shader=`import './missing'`;", 'src/b.ts': "import {type A} from './a'; export type B={a:A};" }), []);
});
test('前端/引擎/持久化边界和可执行入口受到保护，包括动态导入', () => {
  const problems = check({
    'src/project/view.ts': "import 'fs'; import('../server/service.mjs');",
    'src/server/service.mjs': '',
    'src/server/project-repository.mjs': "import './service.mjs';",
    'src/vocal/plan.mjs': "import '../server/service.mjs';",
    'src/server/command.mjs': "import './index.mjs';",
    'src/server/index.mjs': '',
  });
  assert.ok(problems.some((p) => p.includes('browser boundary')));
  assert.ok(problems.some((p) => p.includes('persistence boundary')));
  assert.ok(problems.some((p) => p.includes('engine boundary')));
  assert.ok(problems.some((p) => p.includes('executable import')));
});
