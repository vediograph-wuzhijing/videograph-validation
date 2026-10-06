// oto.mjs — UTAU 声库的 oto.ini 解析与声库扫描（VOCAL-M1）。
// oto 行格式：`别名=文件名.wav,offset,consonant,blank,cutoff,preutter,overlap`（数值均可省略，默认 0）。
// offset/consonant/cutoff 与重采样器契约直接对应；preutter/overlap 决定 wavtool 的放置与交叠。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { UstxError } from './ustx.mjs';

const fail = (message) => { throw new UstxError(message); };

const num = (value, label) => {
  if (value === undefined || value.trim() === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`oto 数值非法（${label}）: ${value}`);
  return n;
};

/** 解析一段 oto.ini 文本 → [{ alias, file, offset, consonant, blank, cutoff, preutter, overlap }]。 */
export function parseOto(text) {
  const entries = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue; // 容错：跳过坏行而非整体失败
    const alias = line.slice(0, eq).trim();
    const fields = line.slice(eq + 1).split(',');
    if (!alias || !fields[0]?.trim()) continue;
    entries.push({
      alias,
      file: fields[0].trim(),
      offset: num(fields[1], 'offset'),
      consonant: num(fields[2], 'consonant'),
      blank: num(fields[3], 'blank'),
      cutoff: num(fields[4], 'cutoff'),
      preutter: num(fields[5], 'preutter'),
      overlap: num(fields[6], 'overlap'),
    });
  }
  return entries;
}

/** 扫描目录下所有 oto.ini（跳过隐藏目录），返回 { dir, oto }；找不到返回 []。 */
export function findOtoFiles(bankDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return; // 声库层级不会太深，防御符号链接环
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.toLowerCase() === 'oto.ini') found.push({ dir, oto: full });
    }
  };
  walk(bankDir, 0);
  return found;
}

function readCharacterName(bankDir) {
  for (const name of ['character.txt', 'character_utf8.txt']) {
    const full = join(bankDir, name);
    if (!existsSync(full)) continue;
    try {
      for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
        const m = /^name\s*=\s*(.+)$/.exec(line.trim());
        if (m) return m[1].trim();
      }
    } catch { /* 编码问题不致命 */ }
    return null;
  }
  return null;
}

/**
 * 加载声库：解析全部 oto 并建立别名索引。
 * 返回 { dir, name, entries, byAlias, warnings, findAlias(alias) }；
 * findAlias 返回 { entry, wavPath, otoDir } 或 null（重复别名取首个并告警，与 UTAU 行为一致）。
 */
export function loadVoicebank(bankDir) {
  if (!existsSync(bankDir) || !statSync(bankDir).isDirectory()) fail(`声库目录不存在: ${bankDir}`);
  const otoFiles = findOtoFiles(bankDir);
  if (otoFiles.length === 0) {
    fail(`声库目录下没有 oto.ini: ${bankDir}`);
  }
  const entries = [];
  const warnings = [];
  const byAlias = new Map();
  for (const { dir, oto } of otoFiles) {
    let parsed;
    try {
      parsed = parseOto(readFileSync(oto, 'utf8'));
    } catch (err) {
      warnings.push(`跳过无法解析的 ${relative(bankDir, oto) || basename(oto)}: ${err.message}`);
      continue;
    }
    for (const entry of parsed) {
      entry.otoDir = dir;
      entries.push(entry);
      if (byAlias.has(entry.alias)) {
        warnings.push(`别名重复（取首个）: ${entry.alias}`);
        continue;
      }
      byAlias.set(entry.alias, entry);
    }
  }
  return {
    dir: bankDir,
    name: readCharacterName(bankDir) ?? basename(bankDir),
    entries,
    byAlias,
    warnings,
    findAlias(alias) {
      const entry = byAlias.get(alias);
      if (!entry) return null;
      return { entry, wav: join(entry.otoDir, entry.file) };
    },
  };
}
