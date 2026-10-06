// oto.mjs — UTAU 声库的 oto.ini 解析与声库扫描（VOCAL-M1/M2）。
// 行格式（OpenUtau 与 UTAU 通用，2026-10-06 对 VoicebankLoader.cs 与 oto 格式文档核对）：
//   `<文件名>.wav=<别名>,<offset>,<consonant>,<cutoff>,<preutter>,<overlap>`（数值均可省略，默认 0；
//   别名省略时取文件名去扩展名；没有 `=` 的行跳过）。offset/consonant/cutoff 与重采样器契约直接对应；
//   preutter/overlap 决定 wavtool 的放置与交叠。
// 编码：character.yaml 的 text_file_encoding 声明 → oto.ini 头部 `#Charset:` 声明 →
//   UTF-8 严格解码失败退 Shift-JIS（老声库惯例）。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { UstxError } from './ustx.mjs';

const fail = (message) => { throw new UstxError(message); };

/** 读 character.yaml（OpenUtau 规范：YAML 本身是 UTF-8，可带 BOM），取 text_file_encoding 声明。 */
export function declaredEncoding(bankDir) {
  const yamlPath = join(bankDir, 'character.yaml');
  if (!existsSync(yamlPath)) return null;
  try {
    const text = new TextDecoder('utf-8').decode(readFileSync(yamlPath)).replace(/^\uFEFF/, '');
    const m = /^\s*text_file_encoding:\s*['"]?([\w.-]+)/m.exec(text);
    return m ? m[1].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 按声明解码；无声明时先看文件头 `#Charset:`（OpenUtau 惯例，前 10 行内），再 UTF-8 严格解码，失败退 Shift-JIS。 */
export function decodeBankText(buffer, declared) {
  if (!declared) {
    const head = buffer.subarray(0, 512).toString('latin1');
    const m = /^\s*#\s*Charset:\s*([\w-]+)/im.exec(head);
    if (m) declared = m[1].trim().toLowerCase();
  }
  if (declared) {
    try { return new TextDecoder(declared).decode(buffer); } catch { /* 声明错误时退自动探测 */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('shift-jis').decode(buffer);
  }
}

/**
 * 解析一段 oto.ini 文本。
 * 行格式：`<wav>=<alias>,<offset>,<consonant>,<cutoff>,<preutter>,<overlap>`
 * → [{ file, alias, offset, consonant, cutoff, preutter, overlap }]；没有 `=` 的坏行跳过。
 */
export function parseOto(text) {
  const entries = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue; // 容错：跳过坏行而非整体失败
    const file = line.slice(0, eq).trim();
    const fields = line.slice(eq + 1).split(',');
    const alias = (fields[0] ?? '').trim() || file.replace(/\.[^.]+$/, '');
    if (!file || !alias) continue;
    const num = (value) => {
      if (value === undefined || value.trim() === '') return 0;
      const n = Number(value);
      return Number.isFinite(n) ? n : 0; // OpenUtau 同款容错：非法数值按 0
    };
    entries.push({
      file,
      alias,
      offset: num(fields[1]),
      consonant: num(fields[2]),
      cutoff: num(fields[3]),
      preutter: num(fields[4]),
      overlap: num(fields[5]),
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

function readCharacterName(bankDir, declared) {
  // OpenUtau 声库优先 character.yaml 的 name（UTF-8、可带 BOM）
  const yamlPath = join(bankDir, 'character.yaml');
  if (existsSync(yamlPath)) {
    try {
      const text = new TextDecoder('utf-8').decode(readFileSync(yamlPath)).replace(/^\uFEFF/, '');
      const m = /^\s*name:\s*(.+)$/m.exec(text);
      if (m && m[1].trim()) return m[1].trim().replace(/^['"]|['"]$/g, '');
    } catch { /* 继续读 character.txt */ }
  }
  for (const name of ['character.txt', 'character_utf8.txt']) {
    const full = join(bankDir, name);
    if (!existsSync(full)) continue;
    try {
      const text = decodeBankText(readFileSync(full), declared);
      for (const line of text.split(/\r?\n/)) {
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
  const declared = declaredEncoding(bankDir);
  for (const { dir, oto } of otoFiles) {
    let parsed;
    try {
      parsed = parseOto(decodeBankText(readFileSync(oto), declared));
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
    name: readCharacterName(bankDir, declared) ?? basename(bankDir),
    encoding: declared ?? 'auto(utf8→shift-jis)',
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
