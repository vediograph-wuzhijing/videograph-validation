// FX-00 按需下载器：离线测试（假的 GitHub，不联网）。验证只下登记允许的文件、哈希校验、逐文件许可、路径与主机限制、缓存复用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(join(tmpdir(), 'vg-fx-'));
process.env.VIDEOGRAPH_FX_CACHE = join(tmp, 'cache');
const fx = await import('../../../src/server/fx/fetcher.mjs');
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const commit = 'a'.repeat(40);
const files = {
  'transitions/fade.glsl': '// Author: gre\n// License: MIT\nvec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), progress); }\n',
  'transitions/nc.glsl': '// Author: someone\n// License: CC BY-NC-SA 3.0\nvec4 transition(vec2 uv) { return vec4(0.0); }\n',
  'transitions/nolicense.glsl': '// Author: anon\nvec4 transition(vec2 uv) { return vec4(1.0); }\n',
  'transitions/apache.glsl': '// License: Apache 2.0\nvec4 transition(vec2 uv) { return vec4(0.5); }\n',
  'cases/demo/main.js': 'export const beat = 0.5;\n',
  'cases/demo/fonts/Brand.ttf': 'FONTBYTES',
  'cases/demo/bgm.mp3': 'MP3BYTES',
  'cases/demo/photo.png': 'PNG',
  'cases/demo/preview.jpg': 'JPG',
  'cases/demo/huge.html': 'x'.repeat(2048),
  'cases/mit-kit/tool.py': 'print("kit")\n',
};
const tree = Object.entries(files).map(([path, content]) => ({ path, type: 'blob', sha: fx.gitBlobSha(Buffer.from(content)), size: Buffer.byteLength(content) }));

function fakeFetch({ tamper = new Set(), log = [] } = {}) {
  return async (url) => {
    log.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'api.github.com') return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 });
    const path = decodeURIComponent(parsed.pathname.split('/').slice(4).join('/'));
    if (!(path in files)) return new Response('missing', { status: 404 });
    return new Response(tamper.has(path) ? files[path] + 'TAMPERED' : files[path], { status: 200 });
  };
}
const registry = {
  schema: 1,
  policy: { spdxAllow: ['MIT', 'Apache-2.0'], licenseRefAllow: ['LicenseRef-author-grant'], hosts: ['api.github.com', 'raw.githubusercontent.com'] },
  sources: [
    { id: 'glt', repo: 'o/glt', commit, license: 'per-file', licenseHeader: '^//\\s*License:\\s*(.+?)\\s*$', attribution: 'glt', include: ['transitions/*.glsl'], exclude: [], extensions: ['glsl'], maxFileBytes: 100000 },
    { id: 'book', repo: 'o/book', commit, license: 'LicenseRef-author-grant', attribution: 'book by friend', include: ['cases/**'],
      exclude: ['**/*.ttf', '**/*.mp3'], extensions: ['js', 'py', 'html', 'jpg', 'png'], imageAllow: ['**/preview.jpg'], maxFileBytes: 1000,
      licenseOverrides: [{ glob: 'cases/mit-kit/**', license: 'MIT', attribution: 'kit (MIT)' }] },
  ],
};
const regFile = join(tmp, 'sources.json');
writeFileSync(regFile, JSON.stringify(registry));

test('登记校验：commit 必须固定 40 位、来源需许可与署名', () => {
  assert.equal(fx.loadRegistry(regFile).sources.length, 2);
  const bad = join(tmp, 'bad.json');
  writeFileSync(bad, JSON.stringify({ ...registry, sources: [{ ...registry.sources[0], commit: 'main' }] }));
  assert.throws(() => fx.loadRegistry(bad), /固定的 40 位/);
});

test('选择规则：排除字体/音频/非联系表图片/超大文件，只留允许的扩展名', () => {
  const book = registry.sources[1];
  const picked = fx.selectFiles(book, tree).map((entry) => entry.path).sort();
  assert.deepEqual(picked, ['cases/demo/main.js', 'cases/demo/preview.jpg', 'cases/mit-kit/tool.py']);
});

test('逐文件许可：MIT/Apache 下载，NC 与无声明拒绝且不落盘；记录署名', async () => {
  const log = [];
  const { fetched, rejected } = await fx.ensurePrefix(registry, 'glt', '', { fetchImpl: fakeFetch({ log }) });
  assert.deepEqual(fetched.sort(), ['transitions/apache.glsl', 'transitions/fade.glsl']);
  assert.deepEqual(rejected.map((r) => r.path).sort(), ['transitions/nc.glsl', 'transitions/nolicense.glsl']);
  const fade = fx.readCached(registry.sources[0], 'transitions/fade.glsl');
  assert.equal(fade.license, 'MIT');
  assert.match(fade.attribution, /fade\.glsl by gre/);
  assert.throws(() => fx.readCached(registry.sources[0], 'transitions/nc.glsl'), /尚未下载或不在允许范围/);
  // 第二次：已缓存与已拒绝的都不再联网
  const again = [];
  const second = await fx.ensurePrefix(registry, 'glt', '', { fetchImpl: fakeFetch({ log: again }) });
  assert.equal(second.fetched.length, 0);
  assert.equal(again.length, 0, '文件树与文件都应命中缓存');
});

test('来源级授权 + 子目录 MIT 覆盖', async () => {
  await fx.ensurePrefix(registry, 'book', '', { fetchImpl: fakeFetch() });
  assert.equal(fx.readCached(registry.sources[1], 'cases/demo/main.js').license, 'LicenseRef-author-grant');
  assert.equal(fx.readCached(registry.sources[1], 'cases/mit-kit/tool.py').attribution, 'kit (MIT)');
});

test('内容被篡改（与固定 commit 的 git 哈希不一致）→ 拒绝写入', async () => {
  const reg = { ...registry, sources: [{ ...registry.sources[0], id: 'glt2' }] };
  const source = reg.sources[0];
  const entries = fx.selectFiles(source, tree).filter((entry) => entry.path === 'transitions/fade.glsl');
  await fx.sourceTree(reg, source, { fetchImpl: fakeFetch() });
  await assert.rejects(fx.ensureFiles(reg, source, entries, { fetchImpl: fakeFetch({ tamper: new Set(['transitions/fade.glsl']) }) }), /内容校验失败/);
  assert.throws(() => fx.readCached(source, 'transitions/fade.glsl'));
});

test('路径与主机限制：越界路径不选、不允许的主机拒绝', async () => {
  assert.equal(fx.safeRelativePath('../etc/passwd'), false);
  assert.equal(fx.safeRelativePath('a/../../b'), false);
  assert.equal(fx.safeRelativePath('C:\\x'), false);
  assert.equal(fx.safeRelativePath('transitions/fade.glsl'), true);
  const evil = [...tree, { path: 'cases/../../escape.js', type: 'blob', sha: 'x', size: 1 }];
  assert.ok(!fx.selectFiles(registry.sources[1], evil).some((entry) => entry.path.includes('..')));
  const reg = { ...registry, policy: { ...registry.policy, hosts: ['raw.githubusercontent.com'] }, sources: [{ ...registry.sources[0], id: 'glt3' }] };
  await assert.rejects(fx.sourceTree(reg, reg.sources[0], { fetchImpl: fakeFetch() }), /不允许的下载地址/);
  assert.ok(!existsSync(join(tmp, 'escape.js')));
});

test('许可写法规范化与 glob', () => {
  assert.equal(fx.normalizeLicense('MIT License'), 'MIT');
  assert.equal(fx.normalizeLicense('Apache 2.0'), 'Apache-2.0');
  assert.equal(fx.normalizeLicense('CC BY-NC-SA 3.0'), 'CC BY-NC-SA 3.0');
  assert.ok(fx.globToRegExp('**/*.ttf').test('a/b/c.ttf'));
  assert.ok(fx.globToRegExp('**/*.ttf').test('c.ttf'));
  assert.ok(!fx.globToRegExp('transitions/*.glsl').test('transitions/sub/x.glsl'));
});

test('BSD 写法变体规范化；拒绝记录在规则放宽后会重新判定', async () => {
  assert.equal(fx.normalizeLicense('BSD 3 Clause'), 'BSD-3-Clause');
  assert.equal(fx.normalizeLicense('BSD-2-Clause License'), 'BSD-2-Clause');
  const reg = { ...registry, sources: [{ ...registry.sources[0], id: 'glt4' }] };
  const first = await fx.ensurePrefix(reg, 'glt4', '', { fetchImpl: fakeFetch() });
  assert.ok(first.rejected.some((r) => r.path === 'transitions/nc.glsl'));
  const relaxed = { ...reg, policy: { ...reg.policy, spdxAllow: [...reg.policy.spdxAllow, 'CC BY-NC-SA 3.0'] } };
  const second = await fx.ensurePrefix(relaxed, 'glt4', '', { fetchImpl: fakeFetch() });
  assert.ok(second.fetched.includes('transitions/nc.glsl'), '规则变化后应重新下载判定');
});

test('单个文件下载失败不影响其他文件入账；重定向到未登记主机被拒绝', async () => {
  const reg = { ...registry, sources: [{ ...registry.sources[0], id: 'glt5' }] };
  const source = reg.sources[0];
  const entries = fx.selectFiles(source, tree);
  const failing = async (url) => url.endsWith('/fade.glsl') ? new Response('boom', { status: 500 }) : fakeFetch()(url);
  const result = await fx.ensureFiles(reg, source, entries, { fetchImpl: failing });
  assert.ok(result.failed.some((entry) => entry.path === 'transitions/fade.glsl'));
  assert.ok(result.fetched.length > 0);
  for (const path of result.fetched) assert.ok(fx.readCached(source, path).content.length > 0, `${path} 应已入账`);
  const redirected = async (url) => { const response = await fakeFetch()(url); Object.defineProperty(response, 'url', { value: 'https://evil.example/x' }); return response; };
  const other = { ...registry, sources: [{ ...registry.sources[0], id: 'glt6' }] };
  await assert.rejects(fx.sourceTree(other, other.sources[0], { fetchImpl: redirected }), /重定向到不允许的地址/);
});
