// brand-store.mjs — 品牌素材本地存储：JSON 元数据 + 内容寻址 blob。独立于 projects/*/project.sqlite。
// 用户素材保留在本机（.gitignore 覆盖 .cache/）；删除被引用素材必须显式失败，不做级联删除。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrandError, MAX_ASSET_BYTES, normalizeAssetInput, validateAssetPatch, validateGuidelinesPatch, validateRefKey } from './validation.mjs';

const productRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export function brandRoot() {
  return resolve(process.env.VIDEOGRAPH_BRAND_DIR ?? join(productRoot, '.cache', 'brand'));
}
const emptyGuidelines = () => ({ palette: [], allowedFonts: [], requiredElements: [], forbidden: [], notes: '' });
const emptyLibrary = () => ({ schema: 1, revision: 0, updatedAt: 0, guidelines: emptyGuidelines(), assets: [] });

function libraryPath(dir) { return join(dir, 'library.json'); }
function readLibrary(dir) {
  if (!existsSync(libraryPath(dir))) return emptyLibrary();
  const data = JSON.parse(readFileSync(libraryPath(dir), 'utf8'));
  if (data?.schema !== 1) throw new BrandError('品牌素材库 schema 不受支持');
  return data;
}
function writeLibrary(dir, library) {
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.library-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(library, null, 2), { flag: 'wx' });
  renameSync(temporary, libraryPath(dir));
}
function mutate(dir, mutateLibrary) {
  const library = readLibrary(dir);
  mutateLibrary(library);
  library.revision += 1;
  library.updatedAt = Date.now();
  writeLibrary(dir, library);
  return structuredClone(library);
}
const findAsset = (library, id) => {
  const asset = library.assets.find((entry) => entry.id === id);
  if (!asset) throw new BrandError('素材不存在', 404);
  return asset;
};

export function listBrandAssets(dir = brandRoot()) { return structuredClone(readLibrary(dir)); }

export function importBrandAsset(dir, input, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new BrandError('素材内容为空');
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new BrandError(`素材超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB 上限`);
  const meta = normalizeAssetInput(input);
  const hash = sha256(bytes);
  return mutate(dir, (library) => {
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    const blob = join(dir, 'blobs', hash);
    if (!existsSync(blob)) writeFileSync(blob, bytes, { flag: 'wx' });
    else if (sha256(readFileSync(blob)) !== hash) throw new BrandError('内容寻址 blob 被外部修改', 409);
    library.assets.push({
      id: randomUUID(), ...meta, kind: meta.kind, hash, bytes: bytes.byteLength, ref: `blobs/${hash}`,
      referencedBy: [], locked: false, createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
}

export function updateBrandAsset(dir, id, patch) {
  const checked = validateAssetPatch(patch);
  return mutate(dir, (library) => {
    const asset = findAsset(library, id);
    const editing = Object.keys(checked).filter((key) => key !== 'locked');
    if (asset.locked && editing.length) throw new BrandError('素材已锁定，请先解锁再编辑', 409);
    Object.assign(asset, checked, { updatedAt: Date.now() });
  });
}

export function updateBrandGuidelines(dir, patch) {
  const checked = validateGuidelinesPatch(patch);
  return mutate(dir, (library) => {
    library.guidelines = { ...library.guidelines, ...checked };
  });
}

export function bindBrandReference(dir, id, refKey) {
  const key = validateRefKey(refKey);
  return mutate(dir, (library) => {
    const asset = findAsset(library, id);
    if (!asset.referencedBy.includes(key)) asset.referencedBy.push(key);
  });
}

export function unbindBrandReference(dir, id, refKey) {
  const key = validateRefKey(refKey);
  return mutate(dir, (library) => {
    const asset = findAsset(library, id);
    const index = asset.referencedBy.indexOf(key);
    if (index < 0) throw new BrandError('引用不存在', 404);
    asset.referencedBy.splice(index, 1);
  });
}

export function removeBrandAsset(dir, id) {
  let orphan;
  const result = mutate(dir, (library) => {
    const asset = findAsset(library, id);
    if (asset.locked) throw new BrandError('素材已锁定，请先解锁再删除', 409);
    if (asset.referencedBy.length > 0) throw new BrandError(`素材仍被引用（${asset.referencedBy.join(', ')}），请先解除引用再删除`, 409);
    library.assets = library.assets.filter((entry) => entry.id !== id);
    const shared = library.assets.some((entry) => entry.hash === asset.hash);
    if (!shared) orphan = asset.hash;
  });
  if (orphan) { try { unlinkSync(join(dir, 'blobs', orphan)); } catch { /* GC can retry orphan cleanup later. */ } }
  return result;
}
