// fetcher.mjs — FX-00：按需从上游下载动效/案例来源（不随本仓库分发）。
// 本仓库只保存 effects/sources.json（地址、固定 commit、许可、允许的文件规则）；文件在用户机器上
// 按固定 commit 从 GitHub 下载，用 git blob SHA-1 校验内容，逐文件判定许可，写入 .cache/fx（不入库）。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const productRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const registryPath = () => process.env.VIDEOGRAPH_FX_REGISTRY ?? join(productRoot, 'effects/sources.json');
export const fxCacheRoot = () => resolve(process.env.VIDEOGRAPH_FX_CACHE ?? join(productRoot, '.cache/fx'));

export class FxError extends Error {}
const check = (condition, message) => { if (!condition) throw new FxError(message); };

export function loadRegistry(path = registryPath()) {
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  check(registry.schema === 1 && Array.isArray(registry.sources), 'effects/sources.json 结构无效');
  for (const source of registry.sources) {
    check(/^[a-z0-9-]+$/.test(source.id), `来源 id 无效：${source.id}`);
    check(/^[\w.-]+\/[\w.-]+$/.test(source.repo), `${source.id}: repo 必须是 owner/name`);
    check(/^[0-9a-f]{40}$/.test(source.commit), `${source.id}: commit 必须是固定的 40 位 SHA`);
    check(source.license && source.attribution, `${source.id}: 缺少 license 或 attribution`);
  }
  return registry;
}
export function getSource(registry, id) {
  const source = registry.sources.find((entry) => entry.id === id);
  check(source, `未登记的来源：${id}`);
  return source;
}

/** 简单 glob：`**` 跨目录，`*` 不跨 `/`，`?` 单字符。 */
export function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { pattern += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (ch === '*') pattern += '[^/]*';
    else if (ch === '?') pattern += '[^/]';
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}
const matchesAny = (globs = [], path) => globs.some((glob) => globToRegExp(glob).test(path));

/** 仓库内路径的安全检查：GitHub tree 返回的路径也不盲信。 */
export function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length < 1000 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

export const gitBlobSha = (buffer) => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');

/** 规范化许可写法：`MIT License` → `MIT`，`Apache 2.0` → `Apache-2.0` 等；无法识别时原样返回。 */
export function normalizeLicense(raw) {
  const value = String(raw ?? '').trim().replace(/\s+license$/i, '').trim();
  const bsd = /^(?:new\s+|simplified\s+)?bsd[\s-]*([23])[\s-]*clause$/i.exec(value);
  if (bsd) return `BSD-${bsd[1]}-Clause`;
  const table = { mit: 'MIT', 'apache 2.0': 'Apache-2.0', 'apache-2.0': 'Apache-2.0', 'apache2': 'Apache-2.0', zlib: 'Zlib', isc: 'ISC', 'cc0': 'CC0-1.0', 'cc0-1.0': 'CC0-1.0',
    'bsd': 'BSD-3-Clause', 'bsd-2-clause': 'BSD-2-Clause', 'bsd-3-clause': 'BSD-3-Clause', 'cc-by-4.0': 'CC-BY-4.0', 'ofl-1.1': 'OFL-1.1' };
  return table[value.toLowerCase()] ?? value;
}
export function licenseAllowed(policy, license) {
  return (policy.spdxAllow ?? []).includes(license) || (policy.licenseRefAllow ?? []).includes(license);
}

/** 文件许可：先看 licenseOverrides，其次 per-file 头部声明，否则用来源级许可。 */
export function licenseFor(source, path, content) {
  const override = (source.licenseOverrides ?? []).find((entry) => globToRegExp(entry.glob).test(path));
  if (override) return { license: override.license, attribution: override.attribution ?? source.attribution, basis: 'override' };
  if (source.license === 'per-file') {
    const pattern = new RegExp(source.licenseHeader, 'm');
    const head = content.toString('utf8').split(/\r?\n/).slice(0, 12).join('\n');
    const match = pattern.exec(head);
    const author = /^\/\/\s*Author:\s*(.+?)\s*$/m.exec(head)?.[1];
    return { license: match ? normalizeLicense(match[1]) : null, attribution: `${source.attribution}${author ? ` · ${path.split('/').pop()} by ${author}` : ''}`, basis: 'file-header' };
  }
  return { license: source.license, attribution: source.attribution, basis: 'source' };
}

/** 按登记规则筛选可下载的文件（不含许可判定；per-file 许可要下载后看头部）。prefix 为仓库内路径前缀。 */
export function selectFiles(source, tree, prefix = '') {
  const extensions = new Set((source.extensions ?? []).map((ext) => ext.toLowerCase()));
  return tree.filter((entry) => {
    if (entry.type !== 'blob' || !safeRelativePath(entry.path)) return false;
    if (prefix && !entry.path.startsWith(prefix)) return false;
    if (!matchesAny(source.include, entry.path) || matchesAny(source.exclude, entry.path)) return false;
    const ext = (/\.([a-z0-9]+)$/i.exec(entry.path)?.[1] ?? '').toLowerCase();
    if (!extensions.has(ext)) return false;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) && !matchesAny(source.imageAllow, entry.path)) return false;
    return typeof entry.size === 'number' && entry.size <= (source.maxFileBytes ?? 1000000);
  });
}

const sourceDir = (source) => join(fxCacheRoot(), source.id, source.commit);
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}
function cachePath(source, path) {
  check(safeRelativePath(path), `非法路径：${path}`);
  const base = join(sourceDir(source), 'files');
  const full = resolve(base, ...path.split('/'));
  check(full.startsWith(resolve(base) + sep), `路径越界：${path}`);
  return full;
}

/** 只允许登记的主机（重定向后的最终地址同样检查）；api.github.com 可用 GITHUB_TOKEN 提高限额（不记录、不回显）。
 * maxBytes：按文件树登记的大小限制读取，避免异常响应在校验前就占满内存。 */
async function httpGet(registry, url, { fetchImpl = fetch, json = false, maxBytes } = {}) {
  const allowed = (parsed) => parsed.protocol === 'https:' && (registry.policy.hosts ?? []).includes(parsed.hostname);
  const parsed = new URL(url);
  check(allowed(parsed), `不允许的下载地址：${parsed.hostname}`);
  const headers = { 'user-agent': 'videograph-fx-fetcher' };
  if (parsed.hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60000) });
  if (response.url) check(allowed(new URL(response.url)), `重定向到不允许的地址：${new URL(response.url).hostname}`);
  if (!response.ok) throw new FxError(`下载失败 HTTP ${response.status}：${parsed.hostname}${parsed.pathname}${response.status === 403 ? '（GitHub API 匿名限额 60 次/小时，可设置 GITHUB_TOKEN）' : ''}`);
  if (json) return response.json();
  if (maxBytes === undefined || !response.body) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) { await response.body.cancel?.().catch(() => {}); throw new FxError(`${parsed.pathname}: 内容校验失败（响应超过登记大小 ${maxBytes} 字节）`); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 固定 commit 的文件树；缓存后永不过期（commit 不可变）。 */
export async function sourceTree(registry, source, options = {}) {
  check(source.downloadable !== false, `${source.id}: 许可不明，只登记链接、不下载（${source.url ?? source.repo}）`);
  const file = join(sourceDir(source), 'tree.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const data = await httpGet(registry, `https://api.github.com/repos/${source.repo}/git/trees/${source.commit}?recursive=1`, { ...options, json: true });
  check(Array.isArray(data.tree) && !data.truncated, `${source.id}: 文件树不完整（truncated）`);
  const tree = data.tree.map(({ path, type, sha, size }) => ({ path, type, sha, size }));
  writeAtomic(file, JSON.stringify(tree));
  return tree;
}

function readLedger(source) {
  const file = join(sourceDir(source), 'provenance.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { source: source.id, repo: source.repo, commit: source.commit, files: {}, rejected: {} };
}

/**
 * 确保这些文件已在本机缓存：下载 → 校验 git blob SHA → 判定许可 → 原子写入。
 * 许可不在白名单的文件不落盘，记入 rejected。单个文件下载/校验失败记入 failed，不影响其他文件入账；
 * 全部失败且没有任何可用文件时抛出第一个错误。返回 { fetched, cached, rejected, failed, pending }。
 */
export async function ensureFiles(registry, source, entries, { fetchImpl = fetch, concurrency = 8, deadline = Infinity } = {}) {
  check(source.downloadable !== false, `${source.id}: 许可不明，只登记链接、不下载`);
  const ledger = readLedger(source);
  const result = { fetched: [], cached: [], rejected: [], failed: [], pending: 0 };
  const updates = { files: {}, rejected: {}, cleared: [] };
  const queue = entries.filter((entry) => {
    const prior = ledger.rejected[entry.path];
    // 拒绝记录保存原始声明：许可白名单或规范化规则变了就重新判定，而不是永久拒绝。
    // 旧格式（纯字符串、无原始声明）的记录无法复判，直接重新下载判定。
    if (prior && typeof prior === 'object' && !(prior.license && licenseAllowed(registry.policy, normalizeLicense(prior.license)))) { result.rejected.push({ path: entry.path, reason: prior.reason }); return false; }
    if (prior) updates.cleared.push(entry.path);
    if (ledger.files[entry.path] && existsSync(cachePath(source, entry.path))) { result.cached.push(entry.path); return false; }
    return true;
  });
  const worker = async () => {
    // deadline：到时不再取新文件（MCP 客户端常见 60 秒超时），已下载的照常落盘，下次调用续传。
    for (let entry = queue.shift(); entry; entry = Date.now() < deadline ? queue.shift() : undefined) {
      const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const content = await httpGet(registry, url, { fetchImpl, maxBytes: entry.size });
        check(gitBlobSha(content) === entry.sha, `${entry.path}: 内容校验失败（与固定 commit 的 git 哈希不一致）`);
        const { license, attribution, basis } = licenseFor(source, entry.path, content);
        if (!license || !licenseAllowed(registry.policy, license)) {
          const reason = license ? `许可 ${license} 不在白名单` : '文件头没有许可声明';
          updates.rejected[entry.path] = { reason, license };
          result.rejected.push({ path: entry.path, reason });
          continue;
        }
        writeAtomic(cachePath(source, entry.path), content);
        updates.files[entry.path] = { sha: entry.sha, size: content.length, license, attribution, basis };
        result.fetched.push(entry.path);
      } catch (error) {
        result.failed.push({ path: entry.path, error: String(error.message ?? error) });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
  } finally {
    result.pending = queue.length;
    if (result.fetched.length || result.rejected.length || updates.cleared.length) {
      // 写前重读并合并：另一个并发调用可能已经写入了别的文件记录。
      const latest = readLedger(source);
      for (const path of updates.cleared) delete latest.rejected[path];
      Object.assign(latest.files, updates.files);
      Object.assign(latest.rejected, updates.rejected);
      for (const path of Object.keys(updates.files)) delete latest.rejected[path];
      writeAtomic(join(sourceDir(source), 'provenance.json'), JSON.stringify(latest, null, 2));
    }
  }
  if (result.failed.length && !result.fetched.length && !result.cached.length) throw new FxError(result.failed[0].error);
  return result;
}

/** 便捷入口：按前缀（仓库内路径）下载该来源允许的全部文件。 */
export async function ensurePrefix(registry, sourceId, prefix = '', options = {}) {
  const source = getSource(registry, sourceId);
  const tree = await sourceTree(registry, source, options);
  const entries = selectFiles(source, tree, prefix);
  return { source, entries, ...(await ensureFiles(registry, source, entries, options)) };
}

/** 读取已缓存文件（需先 ensure）；返回 Buffer 与许可记录。 */
export function readCached(source, path) {
  const ledger = readLedger(source);
  const record = ledger.files[path];
  check(record && existsSync(cachePath(source, path)), `${path} 尚未下载或不在允许范围内`);
  return { content: readFileSync(cachePath(source, path)), ...record };
}

/** 本机缓存状态（不联网）。 */
export function cacheStatus(source) {
  const ledger = readLedger(source);
  return { treeCached: existsSync(join(sourceDir(source), 'tree.json')), files: Object.keys(ledger.files).length, rejected: Object.keys(ledger.rejected).length };
}
