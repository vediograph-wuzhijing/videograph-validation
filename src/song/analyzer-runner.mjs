// analyzer-runner.mjs — SONG-01 的 Node 侧运行器：调用 analyzer/analyze.py，缓存键 = audioHash+stages+版本+参数，原子发布。
// 服务接线（SONG-05 的 HTTP/MCP）由集成者完成；本模块只提供纯函数接口，测试用 stub 解释器，不依赖真实环境。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const productRoot = fileURLToPath(new URL('../..', import.meta.url));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const ANALYZER_VERSION = 'song01-v1';
const condaEnvCache = new Map();
/** 按 conda 环境名找解释器：CONDA_PREFIX/CONDA_EXE 推出的 envs 目录 → 常见安装位置 → `conda env list`。 */
function condaEnvPython(name) {
  if (condaEnvCache.has(name)) return condaEnvCache.get(name);
  const exe = process.platform === 'win32' ? 'python.exe' : 'bin/python';
  const bases = [];
  if (process.env.CONDA_PREFIX) bases.push(/[\\/]envs[\\/][^\\/]+[\\/]?$/.test(process.env.CONDA_PREFIX) ? resolve(process.env.CONDA_PREFIX, '..', '..') : process.env.CONDA_PREFIX);
  if (process.env.CONDA_EXE) bases.push(resolve(dirname(process.env.CONDA_EXE), '..'));
  for (const dir of ['anaconda3', 'miniconda3', 'miniforge3']) bases.push(join(homedir(), dir));
  bases.push('D:/Users/Martis/anaconda3'); // 作者机的安装位置：只是最后一个探测项
  let found = bases.map((base) => join(base, 'envs', name, exe)).find((path) => existsSync(path)) ?? null;
  if (!found) {
    const listed = spawnSync('conda', ['env', 'list', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000, shell: process.platform === 'win32' });
    try { const env = JSON.parse(listed.stdout).envs.find((path) => path.replace(/[\\/]+$/, '').endsWith(name)); if (env && existsSync(join(env, exe))) found = join(env, exe); } catch { /* 未装 conda */ }
  }
  condaEnvCache.set(name, found);
  return found;
}
export const analyzerPython = () => process.env.VIDEOGRAPH_ANALYZER_PYTHON ?? condaEnvPython('videograph-analyzer') ?? (process.platform === 'win32' ? 'python' : 'python3');
/** T3（qwen-asr）需要 py3.12：存在 videograph-t3 环境时优先用它，否则回退主解释器（analyzer/environment.md 双环境说明）。 */
export const analyzerT3Python = () => process.env.VIDEOGRAPH_ANALYZER_T3_PYTHON ?? condaEnvPython('videograph-t3') ?? analyzerPython();
// 解释器可以是 PATH 上的命令名；只有写成路径时才能预先检查存在。
const missingInterpreter = (python) => /[\\/]/.test(python) && !existsSync(python);
export const analyzerTimeoutMs = () => Number(process.env.VIDEOGRAPH_ANALYZER_TIMEOUT_MS) || 30 * 60 * 1000;
const running = new Set();
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
  else child.kill('SIGKILL');
}
/** 服务关闭时调用：结束所有仍在运行的分析子进程（含其子进程树）。 */
export function killAll() {
  for (const child of running) killTree(child);
  running.clear();
}
/** 模型权重根目录：VIDEOGRAPH_MODELS_DIR，默认与仓库同级的 .models（作者机即 F:/aicg/.models，行为不变）。 */
export const modelsRoot = () => resolve(process.env.VIDEOGRAPH_MODELS_DIR ?? join(productRoot, '..', '.models'));
export const analysisCacheRoot = () => resolve(process.env.VIDEOGRAPH_SONG_CACHE ?? join(productRoot, '.cache', 'song-analysis'));

/** 缓存键（规范化输入 + 版本）：改分析参数或分析器版本即失效。 */
export function analysisCacheKey(audioHash, stages, params, version = ANALYZER_VERSION) {
  return sha256(JSON.stringify({ audioHash, stages, params, version }));
}

/** 已缓存的分析直接返回（含 file 路径）；否则执行并把产物放进缓存。
 * T3 需要独立解释器时自动拆成两步：T0+T3 跑 T3 环境，T1+assemble 跑主环境。 */
export async function runAnalysis({ audioPath, stages = ['t0', 't1', 't3'], lyricsText, lrcPath, asr, language, gpu = true, title, cacheRoot = analysisCacheRoot(), python = analyzerPython(), t3Python = analyzerT3Python(), analyzerScript = join(productRoot, 'analyzer', 'analyze.py'), onProgress, timeoutMs = analyzerTimeoutMs() } = {}) {
  if (!audioPath || !existsSync(audioPath)) throw new Error('音频不存在');
  if (missingInterpreter(python)) throw new Error(`分析器解释器不存在：${python}；见 analyzer/environment.md`);
  const needsT3 = stages.includes('t3') && Boolean(lyricsText || lrcPath || asr);
  if (needsT3 && missingInterpreter(t3Python)) throw new Error(`T3 解释器不存在：${t3Python}；见 analyzer/environment.md`);
  // analyze.py 按固定顺序执行阶段；缓存用去重后的实际阶段（含自动 assemble），而非请求列表。
  const baseStages = ['t0', 't1', 't3', 'assemble'].filter((stage) => stages.includes(stage) && (stage !== 't3' || needsT3));
  if (baseStages.includes('t1') && !baseStages.includes('assemble')) baseStages.push('assemble');
  const splitT3 = needsT3 && t3Python !== python && resolve(t3Python) !== resolve(python);
  if (splitT3 && !baseStages.includes('t0')) baseStages.unshift('t0');
  if (splitT3 && !baseStages.includes('assemble')) baseStages.push('assemble');
  const audioHash = sha256(readFileSync(audioPath));
  const params = {
    language: language ?? null, gpu, title: title ?? null, asr: asr ?? null,
    lyricsHash: lyricsText == null ? null : sha256(lyricsText),
    lrcHash: lrcPath ? sha256(readFileSync(lrcPath)) : null,
  };
  // 入口与本地算法库都纳入版本，源码变更不能复用旧分析（含未提交的分析器修改）。
  const library = join(dirname(analyzerScript), 'analysis_lib.py');
  const sourceVersion = sha256(JSON.stringify({ version: ANALYZER_VERSION,
    entrypoint: sha256(readFileSync(analyzerScript)), library: existsSync(library) ? sha256(readFileSync(library)) : null }));
  const key = analysisCacheKey(audioHash, baseStages, params, sourceVersion);
  const cached = join(cacheRoot, `${key}.json`);
  if (existsSync(cached)) return { cached: true, key, analysis: JSON.parse(readFileSync(cached, 'utf8')), file: cached };
  const work = mkdtempSync(join(tmpdir(), 'videograph-song-'));
  try {
    const output = [];
    const runWith = async (interpreter, selected) => {
      const specPath = join(work, `spec-${selected.join('_')}.json`);
      writeFileSync(specPath, JSON.stringify({ audioPath: resolve(audioPath), outDir: work, stages: selected, lyricsText, lrcPath, asr, language, gpu, title }), 'utf8');
      const lines = await runPython(interpreter, [analyzerScript, '--spec', specPath], onProgress, timeoutMs);
      output.push(...lines);
      return lines;
    };
    if (splitT3) {
      await runWith(t3Python, ['t0', 't3']);
      if (baseStages.includes('t1')) await runWith(python, ['t1']);
      await runWith(python, ['assemble']);
    } else {
      await runWith(python, baseStages);
    }
    const finalLine = [...output].reverse().find((line) => line.stage === 'all');
    if (!finalLine) throw new Error('分析器没有产出最终结果（缺少 assemble 输出）');
    const produced = join(work, 'analysis-v2.json');
    if (!existsSync(produced)) throw new Error('analysis-v2.json 缺失');
    const analysis = JSON.parse(readFileSync(produced, 'utf8'));
    mkdirSync(cacheRoot, { recursive: true });
    const temporary = join(cacheRoot, `.${key}.tmp`);
    writeFileSync(temporary, JSON.stringify(analysis), 'utf8');
    renameSync(temporary, cached);
    return { cached: false, key, analysis, file: cached, log: output };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function runPython(python, args, onProgress, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    // 模型权重以 local_dir 模式落盘（绕开 Windows 符号链接特权）；未显式配置时给默认路径。
    const env = { ...process.env };
    const models = modelsRoot();
    env.VIDEOGRAPH_QWEN_ALIGNER_DIR ??= join(models, 'local', 'qwen3-forced-aligner-0.6b');
    env.VIDEOGRAPH_QWEN_ASR_DIR ??= join(models, 'local', 'qwen3-asr-1.7b');
    env.HF_HOME ??= models;
    env.TORCH_HOME ??= models; // beat_this 权重走 torch.hub 缓存（TORCH_HOME/checkpoints）
    env.VIDEOGRAPH_MODELS_DIR ??= models;
    // 管道下 Python 默认用本地代码页（cp936/cp1252），中文输出会乱码或 UnicodeEncodeError。
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    const child = spawn(python, args, { windowsHide: true, env });
    running.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const lines = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          lines.push(parsed);
          onProgress?.(parsed);
        } catch { lines.push({ stage: 'stdout', message: line.slice(0, 500) }); }
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    const done = () => { clearTimeout(timer); running.delete(child); };
    child.on('error', (error) => { done(); reject(error); });
    child.on('close', (code) => {
      done();
      if (timedOut) reject(new Error(`分析器超时（${Math.round(timeoutMs / 1000)}s，VIDEOGRAPH_ANALYZER_TIMEOUT_MS 可调），已结束进程：${stderr.slice(-2000) || '无 stderr'}`));
      else if (code === 0) resolvePromise(lines);
      else reject(new Error(`分析器退出 ${code}：${stderr || '无 stderr'}`));
    });
  });
}

/** 从 v2 分析构造 SONG-05 建工程所需的摘要（不含字节/绝对路径）。 */
export function analysisSummary(analysis) {
  return {
    schema: analysis.schema,
    title: analysis.title,
    audio: { hash: analysis.audio.hash, duration: analysis.audio.duration },
    rhythm: { bpm: analysis.rhythm.bpm ?? null, beats: analysis.rhythm.beats.length, downbeats: analysis.rhythm.downbeats.length, confidence: analysis.rhythm.confidence },
    sections: analysis.sections.length,
    lyrics: analysis.lyrics ? { language: analysis.lyrics.language, humanConfirmed: analysis.lyrics.humanConfirmed, lines: analysis.lyrics.lines.length, source: analysis.lyrics.textSource } : null,
    instrumental: analysis.lyrics === undefined,
    provenance: Object.fromEntries(Object.entries(analysis.provenance).map(([layer, entry]) => [layer, { tool: entry.tool, version: entry.version, confidence: entry.confidence }])),
  };
}
