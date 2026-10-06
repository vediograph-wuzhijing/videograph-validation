// config.mjs — OpenUTAU 无头渲染的外部工具解析链（VOCAL-M1）。
// 原则：代码零硬编码路径。优先级（高→低）：
//   显式参数 → 环境变量 → 项目级 .videograph/vocal.json → 用户级 ~/.videograph/vocal.json
//   → PATH 查找 → 平台标准安装位置候选（仅作自动发现，所有层级都可覆盖）。
// 候选位置是"平台惯例数据"而非业务逻辑；任何一层显式配置后自动发现不再参与。
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { UstxError } from './ustx.mjs';

const fail = (message) => { throw new UstxError(message); };

export const CONFIG_ENV_KEYS = {
  openutauHome: 'VIDEOGRAPH_OPENUTAU_HOME',     // OpenUtau 安装根目录（含 OpenUtau.exe）
  resampler: 'VIDEOGRAPH_OPENUTAU_RESAMPLER',   // 重采样器可执行文件路径，或 argv 头数组（包装脚本/测试桩）
  voicebankDir: 'VIDEOGRAPH_VOICEBANK_DIR',     // 默认声库目录（单个声库根）
  resamplerContract: 'VIDEOGRAPH_OPENUTAU_CONTRACT', // classic（worldline.exe 等）| openutau（moresampler 等）
  cacheDir: 'VIDEOGRAPH_VOCAL_CACHE',           // 逐音符渲染缓存目录（内容寻址，B2）
};

// 平台标准安装位置候选（自动发现兜底，全部可被环境变量/配置文件覆盖）。
const INSTALL_CANDIDATES = {
  win32: () => [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenUtau'),
    join(process.env.ProgramFiles ?? '', 'OpenUtau'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'OpenUtau'),
  ],
  darwin: () => ['/Applications/OpenUtau.app'],
  linux: () => [
    join(homedir(), '.local', 'share', 'OpenUtau'),
    '/opt/OpenUtau',
  ],
};
const EXE_NAMES = { win32: 'OpenUtau.exe', darwin: 'OpenUtau', linux: 'OpenUtau' };

function readConfigFile(path) {
  if (!path || !existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`配置文件不是合法 JSON: ${path}（${err.message}）`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`配置文件顶层必须是对象: ${path}`);
  }
  return { path, data: raw };
}

/** 从候选 [value, source] 对里取第一个非空值；null 项跳过。 */
function firstDefined(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const [value, source] = candidate;
    if (value !== undefined && value !== null && value !== '') return { value, source };
  }
  return null;
}

function normalizeResampler(value, label) {
  // 字符串 → 单可执行文件路径；数组 → argv 头（如 ["node", "stub.mjs"]，测试与包装脚本用）。
  if (Array.isArray(value)) {
    if (value.length === 0 || value.some((x) => typeof x !== 'string')) {
      fail(`${label} 的数组形式必须是非空字符串数组（argv 头）`);
    }
    return [...value];
  }
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} 必须是路径字符串或 argv 数组`);
  return value.trim();
}

/** 从 PATH 查找可执行文件（where/which），找不到返回 null。 */
export function findOnPath(name) {
  const tool = platform() === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(tool, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find((line) => line.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 解析配置。options 显式值优先级最高：
 * { openutauHome?, resampler?, voicebankDir?, projectRoot?, configFile?, homedirOverride?, envOverride? }
 * 返回 { sources: {openutauHome, resampler, voicebankDir}, checks, missing }。
 * 只报告不抛错——缺配置是可诊断状态，需要强约束时由调用方（render）再 fail。
 */
export function resolveConfig(options = {}) {
  const home = options.homedirOverride ?? homedir();
  const projectRoot = options.projectRoot ?? process.cwd();
  const environ = options.envOverride ?? process.env;
  const sources = { openutauHome: null, resampler: null, voicebankDir: null };
  const checks = [];

  const explicitHome = firstDefined(
    options.openutauHome !== undefined ? [options.openutauHome, 'options'] : null,
    environ[CONFIG_ENV_KEYS.openutauHome] ? [environ[CONFIG_ENV_KEYS.openutauHome], `env:${CONFIG_ENV_KEYS.openutauHome}`] : null,
  );
  const explicitResampler = firstDefined(
    options.resampler !== undefined ? [options.resampler, 'options'] : null,
    environ[CONFIG_ENV_KEYS.resampler] ? [environ[CONFIG_ENV_KEYS.resampler], `env:${CONFIG_ENV_KEYS.resampler}`] : null,
  );
  const explicitBank = firstDefined(
    options.voicebankDir !== undefined ? [options.voicebankDir, 'options'] : null,
    environ[CONFIG_ENV_KEYS.voicebankDir] ? [environ[CONFIG_ENV_KEYS.voicebankDir], `env:${CONFIG_ENV_KEYS.voicebankDir}`] : null,
  );

  // 配置文件：项目级 → 用户级（先找到的生效）
  let fileConfig = null;
  if (!explicitHome || !explicitResampler || !explicitBank) {
    const projectFile = readConfigFile(options.configFile ?? join(projectRoot, '.videograph', 'vocal.json'));
    const userFile = projectFile ? null : readConfigFile(join(home, '.videograph', 'vocal.json'));
    fileConfig = projectFile ?? userFile;
    if (fileConfig) checks.push({ item: 'configFile', ok: true, detail: fileConfig.path });
  }

  const pick = (key, explicit) => firstDefined(
    explicit,
    fileConfig && fileConfig.data[key] !== undefined ? [fileConfig.data[key], `file:${fileConfig.path}`] : null,
  );

  const homeHit = explicitHome ?? pick('openutauHome', null);
  const resamplerHit = explicitResampler ?? pick('resampler', null);
  const bankHit = explicitBank ?? pick('voicebankDir', null);
  const contractHit = firstDefined(
    options.resamplerContract !== undefined ? [options.resamplerContract, 'options'] : null,
    environ[CONFIG_ENV_KEYS.resamplerContract] ? [environ[CONFIG_ENV_KEYS.resamplerContract], `env:${CONFIG_ENV_KEYS.resamplerContract}`] : null,
    fileConfig && fileConfig.data.resamplerContract !== undefined ? [fileConfig.data.resamplerContract, `file:${fileConfig.path}`] : null,
  );
  if (contractHit && !['classic', 'openutau'].includes(String(contractHit.value))) {
    fail(`resamplerContract 只能是 classic 或 openutau，实际: ${contractHit.value}`);
  }

  if (homeHit) {
    sources.openutauHome = { value: homeHit.value, source: homeHit.source };
    checks.push({ item: 'openutauHome', ok: true, detail: `${homeHit.value}（来源 ${homeHit.source}）` });
  } else {
    // 自动发现：PATH → 平台标准位置
    const exeName = EXE_NAMES[platform()] ?? 'OpenUtau';
    const onPath = findOnPath(exeName);
    if (onPath) {
      sources.openutauHome = { value: onPath, source: `path:${exeName}` };
      checks.push({ item: 'openutauHome', ok: true, detail: onPath });
    } else {
      const candidates = (INSTALL_CANDIDATES[platform()] ?? (() => []))()
        .filter((p) => p && isAbsolute(p) && existsSync(p));
      checks.push({
        item: 'openutauHome',
        ok: false,
        detail: `PATH 与平台标准位置均未找到 ${exeName}（扫描到 ${candidates.length} 个候选）；可用 ${CONFIG_ENV_KEYS.openutauHome} 或配置文件 openutauHome 键指定`,
      });
      if (candidates.length > 0) sources.openutauHome = { value: candidates[0], source: 'platform-default' };
    }
  }
  if (resamplerHit) {
    sources.resampler = { value: normalizeResampler(resamplerHit.value, 'resampler'), source: resamplerHit.source };
    checks.push({ item: 'resampler', ok: true, detail: `${Array.isArray(sources.resampler.value) ? sources.resampler.value.join(' ') : sources.resampler.value}（来源 ${resamplerHit.source}）` });
  } else {
    checks.push({ item: 'resampler', ok: false, detail: `未配置重采样器（${CONFIG_ENV_KEYS.resampler} 或配置文件 resampler 键；任何实现 UTAU/OpenUtau 命令行契约的 exe）` });
  }
  if (bankHit) {
    sources.voicebankDir = { value: bankHit.value, source: bankHit.source };
    checks.push({ item: 'voicebankDir', ok: true, detail: `${bankHit.value}（来源 ${bankHit.source}）` });
  } else {
    checks.push({ item: 'voicebankDir', ok: false, detail: `未配置声库目录（${CONFIG_ENV_KEYS.voicebankDir} 或配置文件 voicebankDir 键）` });
  }
  if (contractHit) {
    sources.resamplerContract = { value: String(contractHit.value), source: contractHit.source };
    checks.push({ item: 'resamplerContract', ok: true, detail: `${contractHit.value}（来源 ${contractHit.source}）` });
  }
  const cacheHit = firstDefined(
    options.cacheDir !== undefined ? [options.cacheDir, 'options'] : null,
    environ[CONFIG_ENV_KEYS.cacheDir] ? [environ[CONFIG_ENV_KEYS.cacheDir], `env:${CONFIG_ENV_KEYS.cacheDir}`] : null,
    fileConfig && fileConfig.data.cacheDir !== undefined ? [fileConfig.data.cacheDir, `file:${fileConfig.path}`] : null,
  );
  if (cacheHit) {
    sources.cacheDir = { value: cacheHit.value, source: cacheHit.source };
    checks.push({ item: 'cacheDir', ok: true, detail: `${cacheHit.value}（来源 ${cacheHit.source}）` });
  }

  const missing = [];
  if (!sources.openutauHome) missing.push('openutauHome');
  if (!sources.resampler) missing.push('resampler');
  if (!sources.voicebankDir) missing.push('voicebankDir');
  return { sources, checks, missing };
}

/** vocal.json / 环境变量的书写示例（check 命令与文档复用；路径用占位目录，不是真实本机路径）。 */
export function configExample() {
  const sep = platform() === 'win32' ? '\\' : '/';
  return {
    env: {
      [CONFIG_ENV_KEYS.openutauHome]: `D:${sep}tools${sep}OpenUtau`,
      [CONFIG_ENV_KEYS.resampler]: `D:${sep}tools${sep}moresampler.exe`,
      [CONFIG_ENV_KEYS.voicebankDir]: `D:${sep}voicebanks${sep}重音テト`,
    },
    file: {
      openutauHome: `D:${sep}tools${sep}OpenUtau`,
      resampler: `D:${sep}tools${sep}moresampler.exe`,
      voicebankDir: `D:${sep}voicebanks${sep}重音テト`,
      // resampler 也支持 argv 头形式（包装脚本/测试桩）：["node", "resampler-stub.mjs"]
    },
    filePaths: {
      project: `.videograph${sep}vocal.json（放工程根，不要提交进 git：机器本地路径不入库）`,
      user: `~${sep}.videograph${sep}vocal.json（用户主目录下）`,
    },
  };
}
