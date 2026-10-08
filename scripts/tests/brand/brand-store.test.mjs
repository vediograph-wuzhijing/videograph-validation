// ASSET-01 领域测试：品牌素材存储（内容寻址、锁定/引用删除保护、品牌规范校验）。不启动服务。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'videograph-brand-'));
const { brandRoot, importBrandAsset, listBrandAssets, updateBrandAsset, updateBrandGuidelines, removeBrandAsset, bindBrandReference, unbindBrandReference, sha256 } = await import('../../../src/server/brand/brand-store.mjs');
const { BrandError, validateGuidelinesPatch, normalizeAssetInput } = await import('../../../src/server/brand/validation.mjs');
after(() => rmSync(root, { recursive: true, force: true }));
const dir = () => join(root, randomUUID());
const png = (seed) => new Uint8Array(64).fill(seed);
const status = (error) => error instanceof BrandError ? error.status : undefined;

test('导入建立内容寻址元数据，不泄露绝对路径或文件字节', () => {
  const store = dir();
  const library = importBrandAsset(store, { name: '主标 Logo', kind: 'logo', copyright: '© G1en', notes: '演示' }, png(1));
  const asset = library.assets.at(-1);
  assert.equal(asset.hash, sha256(png(1)));
  assert.equal(asset.ref, `blobs/${asset.hash}`);
  assert.equal(existsSync(join(store, 'blobs', asset.hash)), true);
  const raw = readFileSync(join(store, 'library.json'), 'utf8');
  assert.doesNotMatch(raw, /[A-Za-z]:[\\/]/, '元数据不得包含本机绝对路径');
  assert.ok(raw.length < 4096, '元数据不得携带文件字节');
  assert.deepEqual(asset.referencedBy, []);
  assert.equal(asset.locked, false);
});
test('相同内容共享同一 blob，互不影响元数据', () => {
  const store = dir();
  importBrandAsset(store, { name: 'A', kind: 'logo' }, png(7));
  importBrandAsset(store, { name: 'B', kind: 'product-image' }, png(7));
  const library = listBrandAssets(store);
  assert.equal(new Set(library.assets.map((asset) => asset.hash)).size, 1);
  assert.equal(library.assets.length, 2);
});
test('锁定素材禁止编辑，解锁切换始终可用', () => {
  const store = dir();
  const library = importBrandAsset(store, { name: '规范 Logo', kind: 'logo' }, png(2));
  const id = library.assets.at(-1).id;
  updateBrandAsset(store, id, { locked: true });
  assert.throws(() => updateBrandAsset(store, id, { name: '改名' }), (error) => status(error) === 409);
  updateBrandAsset(store, id, { locked: false });
  updateBrandAsset(store, id, { name: '改名后' });
  assert.equal(listBrandAssets(store).assets.find((asset) => asset.id === id).name, '改名后');
});
test('删除保护：被引用或锁定时拒绝；解除引用后成功并回收孤儿 blob', () => {
  const store = dir();
  const library = importBrandAsset(store, { name: '引用中的图', kind: 'product-image' }, png(3));
  const id = library.assets.at(-1).id;
  const hash = library.assets.at(-1).hash;
  bindBrandReference(store, id, 'shot:open:logo');
  assert.throws(() => removeBrandAsset(store, id), (error) => status(error) === 409);
  updateBrandAsset(store, id, { locked: true });
  assert.throws(() => removeBrandAsset(store, id), (error) => status(error) === 409);
  updateBrandAsset(store, id, { locked: false });
  unbindBrandReference(store, id, 'shot:open:logo');
  removeBrandAsset(store, id);
  assert.equal(listBrandAssets(store).assets.some((asset) => asset.id === id), false);
  assert.equal(existsSync(join(store, 'blobs', hash)), false, '无引用后孤儿 blob 应被回收');
});
test('共享 hash 的素材删除其一，blob 保留给另一条', () => {
  const store = dir();
  const first = importBrandAsset(store, { name: '甲', kind: 'logo' }, png(7)).assets.at(-1).id;
  const second = importBrandAsset(store, { name: '乙', kind: 'logo' }, png(7)).assets.at(-1).id;
  removeBrandAsset(store, first);
  assert.equal(existsSync(join(store, 'blobs', sha256(png(7)))), true);
  removeBrandAsset(store, second);
  assert.equal(existsSync(join(store, 'blobs', sha256(png(7)))), false);
});
test('品牌规范校验：坏颜色拒绝，合法补丁归一化持久化', () => {
  const store = dir();
  assert.throws(() => validateGuidelinesPatch({ palette: [{ name: '错', hex: 'orange' }] }), /#RRGGBB/);
  assert.throws(() => validateGuidelinesPatch({ forbidden: Array.from({ length: 51 }, () => 'x') }), /最多/);
  const normalized = validateGuidelinesPatch({
    palette: [{ name: '信号橙', hex: '#ff4d12', usage: '强调' }],
    allowedFonts: [{ family: 'Arial', weights: [700, 400] }],
    requiredElements: ['Logo 水印'], forbidden: ['紫色霓虹'], notes: '  ',
  });
  assert.equal(normalized.palette[0].hex, '#FF4D12');
  assert.deepEqual(normalized.allowedFonts[0].weights, [400, 700]);
  updateBrandGuidelines(store, normalized);
  const library = listBrandAssets(store);
  assert.equal(library.guidelines.palette[0].hex, '#FF4D12');
  assert.equal(library.guidelines.notes, '');
});
test('修订号随每次变更递增，重读保持一致', () => {
  const store = dir();
  const start = listBrandAssets(store).revision;
  const id = importBrandAsset(store, { name: '计数', kind: 'copy' }, png(4)).assets.at(-1).id;
  updateBrandAsset(store, id, { notes: '一' });
  bindBrandReference(store, id, 'shot:a:copy');
  const end = listBrandAssets(store);
  assert.equal(end.revision, start + 3);
  assert.deepEqual(end.assets.at(-1).referencedBy, ['shot:a:copy']);
});
test('非法输入拒绝：未知类型、空名称、超大字节、坏引用键', () => {
  assert.throws(() => normalizeAssetInput({ name: 'x', kind: 'meme' }), /未知素材类型/);
  assert.throws(() => normalizeAssetInput({ name: '   ', kind: 'logo' }), /名称/);
  const store = dir();
  assert.throws(() => importBrandAsset(store, { name: '大文件', kind: 'audio' }, new Uint8Array(65 * 1024 * 1024)), /上限/);
  assert.throws(() => importBrandAsset(store, { name: '空内容', kind: 'logo' }, new Uint8Array(0)), /内容为空/);
  const id = importBrandAsset(store, { name: '常规', kind: 'logo' }, png(5)).assets.at(-1).id;
  assert.throws(() => bindBrandReference(store, id, '../escape'), /引用键/);
  assert.throws(() => unbindBrandReference(store, id, 'shot:none:x'), (error) => status(error) === 404);
  assert.throws(() => bindBrandReference(store, 'missing', 'shot:a:x'), (error) => status(error) === 404);
});
test('默认根目录指向本机 .cache/brand，可被环境变量覆盖', () => {
  assert.ok(brandRoot().includes('.cache'), '默认存储必须在 .cache 下（.gitignore 已覆盖）');
});

test('metadata cannot inject bytes or a storage reference independently', () => {
  for (const field of [{ bytes: 1 }, { ref: 'blobs/fake' }]) {
    assert.throws(() => importBrandAsset(dir(), { name: 'logo', kind: 'logo', ...field }, png(7)), /存储层/);
  }
});
