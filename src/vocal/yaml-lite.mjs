// yaml-lite.mjs — OpenUTAU USTX（YAML）子集读写器（VOCAL-M1）。
// 只覆盖 USTX 实际用到的结构：块式映射/序列、一层流式映射（音高点 `{x: -40, y: 0, shape: sp}`）、
// 流式标量序列；不支持锚点、多文档、多行块标量。
// 写出格式对齐 YamlDotNet（UnderscoredNamingConvention + OmitNull + QuotingNecessaryStrings）：
// 映射值整体缩进 +2，序列项与所属键同缩进、`- ` 后直接跟首键、延续键缩进 +2；
// 键名拼写由调用方给定，本模块不做命名转换。

const BOOLISH = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off']);
const NUMBERISH = /^[-+]?(\d[\d_]*\.?\d*([eE][-+]?\d+)?|\.\d+|0[xX][0-9a-fA-F]+|\.inf|\.nan)$/;
// 比真实必需更保守地加引号：多余引号仍是合法 YAML，漏引号才是错误。
const PLAIN_UNSAFE = /[:#\{\}\[\],&\*!\|>'"%@`]/;

export class YamlError extends Error {
  constructor(message) { super(message); this.name = 'YamlError'; }
}

/** 标量是否必须加引号（空串、前后空白、YAML 保留字、数字样、含指示符字符）。 */
export function needsQuote(s) {
  if (s === '') return true;
  if (/^\s|\s$/.test(s)) return true;
  if (BOOLISH.has(s.toLowerCase()) || NUMBERISH.test(s)) return true;
  if (PLAIN_UNSAFE.test(s)) return true;
  return false;
}

function quoteString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function scalarToText(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return quoteString(value);
}

function isScalar(value) {
  return value === null || value === undefined || typeof value !== 'object';
}

function isNonEmptyMap(value) {
  return !isScalar(value) && !Array.isArray(value)
    && Object.keys(value).some((k) => value[k] !== null && value[k] !== undefined);
}

function emitMap(map, indent, out) {
  const pad = ' '.repeat(indent);
  const keys = Object.keys(map).filter((k) => map[k] !== null && map[k] !== undefined);
  if (keys.length === 0) { out.push(`${pad}{}`); return; }
  for (const key of keys) {
    emitKeyValue(map[key], indent, out, `${pad}${quoteIfNeeded(key)}:`);
  }
}

/** 输出 `前缀` 之后的值（前缀形如 `key:` 或 `- key:`，已含冒号）。 */
function emitKeyValue(value, indent, out, prefix) {
  if (isScalar(value)) { out.push(`${prefix} ${scalarToText(value)}`); return; }
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push(`${prefix} []`); return; }
    out.push(prefix);
    emitSeq(value, indent, out); // 序列项与键同缩进（YamlDotNet 风格）
    return;
  }
  if (!isNonEmptyMap(value)) { out.push(`${prefix} {}`); return; }
  out.push(prefix);
  emitMap(value, indent + 2, out); // 嵌套映射缩进 +2
}

function emitSeq(items, indent, out) {
  const pad = ' '.repeat(indent);
  for (const item of items) {
    if (isScalar(item)) { out.push(`${pad}- ${scalarToText(item)}`); continue; }
    if (Array.isArray(item)) { out.push(`${pad}-`); emitSeq(item, indent + 2, out); continue; }
    const keys = Object.keys(item).filter((k) => item[k] !== null && item[k] !== undefined);
    if (keys.length === 0) { out.push(`${pad}- {}`); continue; }
    const first = keys[0];
    emitKeyValue(item[first], indent, out, `${pad}- ${quoteIfNeeded(first)}:`);
    const rest = {};
    for (const k of keys.slice(1)) rest[k] = item[k];
    if (isNonEmptyMap(rest)) emitMap(rest, indent + 2, out); // 延续键缩进 +2
  }
}

function quoteIfNeeded(key) {
  // 键比值更保守：USTX 键都是安全标识符，仅防御意外输入（如 `mod+` 之外的特殊键）。
  return /^[\w+.\-]+$/.test(key) ? key : quoteString(key);
}

/** 顶层只接受对象或数组；返回以换行结尾的 YAML 文本。null 字段一律省略（对齐 OmitNull）。 */
export function emitYaml(root) {
  const out = [];
  if (Array.isArray(root)) emitSeq(root, 0, out);
  else if (!isScalar(root)) emitMap(root, 0, out);
  else out.push(scalarToText(root));
  return out.join('\n') + '\n';
}

// ---------- 解析（严格对应写出的子集） ----------

function splitTop(text, sep) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\') { cur += text[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[') { depth++; cur += ch; continue; }
    if (ch === '}' || ch === ']') { depth--; cur += ch; continue; }
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() || parts.length) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseScalar(text) {
  const s = text.trim();
  if (s.startsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, (_, ch) => (
      ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch
    ));
  }
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'null' || s === '~' || s === '') return null;
  const low = s.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
  if (NUMBERISH.test(s)) return parseFloat(s);
  return s;
}

/** `{x: -40, y: 0, shape: sp}` → 对象；`[a, b]` → 数组；值只允许标量。 */
function parseScalarOrFlow(text) {
  const s = text.trim();
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError(`流式映射未闭合: ${text}`);
    const map = {};
    for (const part of splitTop(s.slice(1, -1), ',')) {
      const idx = findMapColon(part);
      if (idx < 0) throw new YamlError(`流式映射缺冒号: ${part}`);
      map[parseScalar(part.slice(0, idx))] = parseScalar(part.slice(idx + 1));
    }
    return map;
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError(`流式序列未闭合: ${text}`);
    return splitTop(s.slice(1, -1), ',').map(parseScalar);
  }
  return parseScalar(s);
}

function findMapColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i);
  }
  return line;
}

const isSeqLine = (text) => text.startsWith('- ') || text === '-';

// 读取键值对（key 行位于 i，冒号已定位）；value 可能是同/更深缩进的块。
// 返回 [value, nextIndex]。
function readValue(lines, i, colon, keyIndent) {
  const rest = lines[i][1].slice(colon + 1).trim();
  if (rest) return [parseScalarOrFlow(rest), i + 1];
  const next = lines[i + 1];
  if (!next) return [null, i + 1];
  if (next[0] > keyIndent) return parseBlock(lines, i + 1, next[0]);
  if (next[0] === keyIndent && isSeqLine(next[1])) return parseSeq(lines, i + 1, keyIndent);
  return [null, i + 1];
}

function parseMap(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i][0] === indent && !isSeqLine(lines[i][1])) {
    const colon = findMapColon(lines[i][1]);
    if (colon < 0) throw new YamlError(`映射行缺冒号（第 ${i + 1} 行）: ${lines[i][1]}`);
    const key = parseScalar(lines[i][1].slice(0, colon));
    const [value, next] = readValue(lines, i, colon, indent);
    map[typeof key === 'string' ? key : String(key)] = value;
    i = next;
  }
  return [map, i];
}

function parseSeq(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length && lines[i][0] === indent && isSeqLine(lines[i][1])) {
    const text = lines[i][1];
    const body = text === '-' ? '' : text.slice(2).trim();
    if (body === '') {
      if (i + 1 < lines.length && lines[i + 1][0] > indent) {
        const [value, next] = parseBlock(lines, i + 1, lines[i + 1][0]);
        items.push(value); i = next;
      } else { items.push(null); i++; }
      continue;
    }
    const colon = findMapColon(body);
    if (colon >= 0 && !body.startsWith('{') && !body.startsWith('[') && !body.startsWith('"')) {
      // 映射项：首键在 `- ` 之后（视作缩进 indent+2），延续键在 indent+2。
      const entry = {};
      const key = parseScalar(body.slice(0, colon));
      const keyText = typeof key === 'string' ? key : String(key);
      // 把 `- key: ...` 视作缩进 indent+2 上的键行，复用 readValue；virtualLines[0] 对应原文第 i 行。
      const virtualLines = [[indent + 2, body], ...lines.slice(i + 1)];
      const [value, consumed] = readValue(virtualLines, 0, colon, indent + 2);
      entry[keyText] = value;
      // consumed=1 表示值就在本行（下一行是 i+1）；否则值块消费到 virtualLines[consumed-1] = 原文 i+consumed-2。
      i = consumed === 1 ? i + 1 : i + consumed - 1;
      while (i < lines.length && lines[i][0] === indent + 2 && !isSeqLine(lines[i][1])) {
        const c = findMapColon(lines[i][1]);
        if (c < 0) throw new YamlError(`映射行缺冒号（第 ${i + 1} 行）: ${lines[i][1]}`);
        const k = parseScalar(lines[i][1].slice(0, c));
        const [v, n] = readValue(lines, i, c, indent + 2);
        entry[typeof k === 'string' ? k : String(k)] = v;
        i = n;
      }
      items.push(entry);
      continue;
    }
    items.push(parseScalarOrFlow(body));
    i++;
  }
  return [items, i];
}

function parseBlock(lines, start, indent) {
  return isSeqLine(lines[start][1]) ? parseSeq(lines, start, indent) : parseMap(lines, start, indent);
}

/** 解析 emitYaml 产出的（以及 USTX 实际使用的）YAML 子集。 */
export function parseYaml(text) {
  const lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    const stripped = stripComment(line).replace(/\s+$/, '');
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.replace(/^ +/, '').length;
    lines.push([indent, stripped.slice(indent)]);
  }
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0][0]);
  if (next !== lines.length) throw new YamlError(`第 ${next + 1} 行未能解析: ${lines[next] && lines[next][1]}`);
  return value;
}
