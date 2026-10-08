// validation.mjs — 品牌素材领域的纯校验/归一化。无 IO，可被存储层与测试共享。
// 边界（ROADMAP §11 ASSET-01）：元数据绝不收调用方提供的路径或字节，引用一律由存储层派生。

export class BrandError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const BRAND_ASSET_KINDS = ['logo', 'product-image', 'font', 'audio', 'palette', 'copy'];
export const BRAND_ASPECTS = undefined; // 预留给 FB-01 anchor.aspect 对齐；本期不使用
const HEX = /^#[0-9a-fA-F]{6}$/;
const REF_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,120}$/;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

const cleanText = (value, label, limit) => {
  if (typeof value !== 'string' || !value.trim()) throw new BrandError(`${label}不能为空`);
  const text = value.trim();
  if (text.length > limit) throw new BrandError(`${label}超过 ${limit} 字符`);
  return text;
};
const optionalText = (value, label, limit) => {
  if (value === undefined || value === null || value === '') return undefined;
  return cleanText(value, label, limit);
};

/** 导入输入归一化：只接受名称/类型/版权/备注；hash、ref、字节由存储层处理。 */
export function normalizeAssetInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BrandError('无效的素材输入');
  if (typeof input.bytes !== 'undefined' || typeof input.ref !== 'undefined') throw new BrandError('素材字节与引用由存储层管理，不能随元数据提交');
  const name = cleanText(input.name, '素材名称', 120);
  if (!BRAND_ASSET_KINDS.includes(input.kind)) throw new BrandError(`未知素材类型：${String(input.kind)}`);
  return { name, kind: input.kind, copyright: optionalText(input.copyright, '版权说明', 500), notes: optionalText(input.notes, '备注', 2000) };
}

/** 元数据更新补丁：锁定素材只允许解锁切换本身。 */
export function validateAssetPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new BrandError('无效的更新补丁');
  const allowed = ['name', 'copyright', 'notes', 'locked'];
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new BrandError('不支持的素材更新字段');
  const next = {};
  if (patch.name !== undefined) next.name = cleanText(patch.name, '素材名称', 120);
  if (patch.copyright !== undefined) next.copyright = optionalText(patch.copyright, '版权说明', 500);
  if (patch.notes !== undefined) next.notes = optionalText(patch.notes, '备注', 2000);
  if (patch.locked !== undefined) {
    if (typeof patch.locked !== 'boolean') throw new BrandError('locked 必须是布尔值');
    next.locked = patch.locked;
  }
  if ((next.name !== undefined || next.copyright !== undefined || next.notes !== undefined) && patch.locked === true) {
    throw new BrandError('素材已锁定，请先解锁再编辑', 409);
  }
  return next;
}

function validatePalette(rows) {
  if (!Array.isArray(rows) || rows.length > 32) throw new BrandError('色板最多 32 行');
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw new BrandError('色板行必须是对象');
    const name = cleanText(row.name, '色板名称', 40);
    if (typeof row.hex !== 'string' || !HEX.test(row.hex.trim())) throw new BrandError(`色板「${name}」的颜色必须是 #RRGGBB`);
    return { name, hex: row.hex.trim().toUpperCase(), usage: optionalText(row.usage, '色板用途', 120) };
  });
}
function validateFonts(rows) {
  if (!Array.isArray(rows) || rows.length > 24) throw new BrandError('允许字体最多 24 项');
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw new BrandError('字体行必须是对象');
    const family = cleanText(row.family, '字体族名', 80);
    let weights;
    if (row.weights !== undefined) {
      if (!Array.isArray(row.weights) || row.weights.some((w) => !Number.isInteger(w) || w < 100 || w > 900)) throw new BrandError(`字体「${family}」的字重必须是 100..900 的整数`);
      weights = [...new Set(row.weights)].sort((a, b) => a - b);
    }
    return { family, weights, note: optionalText(row.note, '字体备注', 120) };
  });
}
function validateList(rows, label, limit = 50) {
  if (!Array.isArray(rows) || rows.length > limit) throw new BrandError(`${label}最多 ${limit} 条`);
  return rows.map((row) => cleanText(row, label, 200));
}

/** 品牌规范补丁：部分更新，逐字段校验归一化。 */
export function validateGuidelinesPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new BrandError('无效的品牌规范补丁');
  const allowed = ['palette', 'allowedFonts', 'requiredElements', 'forbidden', 'notes'];
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new BrandError('不支持的品牌规范字段');
  const next = {};
  if (patch.palette !== undefined) next.palette = validatePalette(patch.palette);
  if (patch.allowedFonts !== undefined) next.allowedFonts = validateFonts(patch.allowedFonts);
  if (patch.requiredElements !== undefined) next.requiredElements = validateList(patch.requiredElements, '必保留元素');
  if (patch.forbidden !== undefined) next.forbidden = validateList(patch.forbidden, '禁用规则');
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== 'string') throw new BrandError('规范备注必须是字符串');
    const text = patch.notes.trim();
    if (text.length > 2000) throw new BrandError('规范备注超过 2000 字符');
    next.notes = text;
  }
  return next;
}

/** 引用键：集成者把素材接入镜头/缓存键时用（如 `shot:open:logo`）。 */
export function validateRefKey(refKey) {
  if (typeof refKey !== 'string' || !REF_KEY.test(refKey)) throw new BrandError('无效的引用键');
  return refKey;
}

export { MAX_ASSET_BYTES };
