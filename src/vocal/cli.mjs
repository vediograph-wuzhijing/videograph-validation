// cli.mjs — VOCAL-M1 命令行入口（AI 操作者的主要界面；零依赖、无 shell 注入面）。
// 用法：node src/vocal/cli.mjs <command> [options]
//   check                       外部工具自检（解析链结果 + 缺项指引）
//   make-ustx --plan P --out F  由 plan JSON 生成 USTX（结构见 docs/VOCAL.md）
//   check-ustx --ustx F         USTX 结构自检
//   make-ust --ustx F --out G   USTX → 经典 UST（互操作）
//   render --ustx F --out W     无头渲染人声 WAV（需 resampler + 声库配置）
// 退出码：0 成功；2 配置缺失；3 输入/渲染错误；1 未预期。--json 输出机器可读报告。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolveConfig, configExample } from './config.mjs';
import { buildUstx, serializeUstx, validateUstxText, UstxError } from './ustx.mjs';
import { ustxTextToUst } from './ust.mjs';
import { loadVoicebank } from './oto.mjs';
import { renderUstx } from './render.mjs';

const EXIT = { OK: 0, UNEXPECTED: 1, CONFIG: 2, INPUT: 3 };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(token);
  }
  return args;
}

const fail = (message, exitCode, extra = {}) => {
  const payload = { ok: false, error: message, ...extra };
  console.error(args.json ? JSON.stringify(payload, null, 2) : message);
  process.exit(exitCode);
};

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const out = (payload, pretty) => {
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else if (pretty) console.log(pretty);
};

const asPath = (value, label) => {
  if (typeof value !== 'string' || !value) fail(`缺少 --${label}`, EXIT.INPUT);
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
};

function resolveResamplerOption(value) {
  // --resampler 支持 JSON argv 数组（如 '["node","stub.mjs"]'）或路径
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      fail(`--resampler 的 JSON 数组形式无法解析: ${trimmed}`, EXIT.INPUT);
    }
  }
  return trimmed;
}

try {
  switch (command) {
    case 'check': {
      const config = resolveConfig({ projectRoot: process.cwd() });
      let bank = null;
      const bankDir = config.sources.voicebankDir?.value;
      if (typeof bankDir === 'string') {
        try {
          const loaded = loadVoicebank(bankDir);
          bank = { name: loaded.name, aliases: loaded.entries.length, warnings: loaded.warnings };
        } catch (err) {
          bank = { error: err.message };
        }
      }
      const report = {
        ok: config.missing.length === 0 && !(bank && bank.error),
        missing: config.missing,
        checks: config.checks,
        voicebank: bank,
        note: '渲染只需要 resampler 与 voicebankDir；openutauHome 用于自检安装与 M2 互操作验证，非渲染必需',
        example: configExample(),
      };
      out(report);
      if (!args.json) {
        for (const c of config.checks) console.log(`${c.ok ? '✔' : '✖'} ${c.item}: ${c.detail}`);
        if (bank) console.log(bank.error ? `✖ voicebank: ${bank.error}` : `✔ voicebank: ${bank.name}（${bank.aliases} 个别名）`);
      }
      process.exit(report.ok ? EXIT.OK : EXIT.CONFIG);
      break;
    }

    case 'make-ustx': {
      const planPath = asPath(args.plan, 'plan');
      const outPath = asPath(args.out, 'out');
      let plan;
      try {
        plan = JSON.parse(readFileSync(planPath, 'utf8'));
      } catch (err) {
        fail(`plan JSON 无法读取: ${err.message}`, EXIT.INPUT);
      }
      const project = buildUstx(plan);
      writeFileSync(outPath, serializeUstx(project), 'utf8');
      const verdict = validateUstxText(serializeUstx(project));
      const summary = {
        ok: true, out: outPath,
        notes: project.voice_parts.reduce((sum, p) => sum + p.notes.length, 0),
        parts: project.voice_parts.length,
        tempo: project.tempos[0].bpm,
        selfCheck: verdict.ok,
        errors: verdict.errors,
      };
      out(summary, `已写出 ${outPath}（${summary.parts} part / ${summary.notes} 音符，自检${verdict.ok ? '通过' : '失败'}）`);
      process.exit(verdict.ok ? EXIT.OK : EXIT.INPUT);
      break;
    }

    case 'check-ustx': {
      const ustxPath = asPath(args.ustx, 'ustx');
      let text;
      try {
        text = readFileSync(ustxPath, 'utf8');
      } catch (err) {
        fail(`USTX 无法读取: ${err.message}`, EXIT.INPUT);
      }
      const verdict = validateUstxText(text);
      out({ ok: verdict.ok, ustx: ustxPath, errors: verdict.errors }, verdict.ok ? `✔ ${ustxPath} 结构自检通过` : verdict.errors.join('\n'));
      process.exit(verdict.ok ? EXIT.OK : EXIT.INPUT);
      break;
    }

    case 'make-ust': {
      const ustxPath = asPath(args.ustx, 'ustx');
      const outPath = asPath(args.out, 'out');
      const text = readFileSync(ustxPath, 'utf8');
      writeFileSync(outPath, ustxTextToUst(text, { voiceDir: typeof args['voice-dir'] === 'string' ? args['voice-dir'] : '' }), 'utf8');
      out({ ok: true, out: outPath }, `已写出 ${outPath}`);
      process.exit(EXIT.OK);
      break;
    }

    case 'render': {
      const ustxPath = asPath(args.ustx, 'ustx');
      const outPath = asPath(args.out, 'out');
      const config = resolveConfig({
        projectRoot: process.cwd(),
        openutauHome: typeof args['openutau-home'] === 'string' ? args['openutau-home'] : undefined,
        resampler: args.resampler !== undefined ? resolveResamplerOption(args.resampler) : undefined,
        voicebankDir: typeof args.bank === 'string' ? args.bank : undefined,
        resamplerContract: typeof args['resampler-contract'] === 'string' ? args['resampler-contract'] : undefined,
      });
      const missingRender = config.missing.filter((k) => k !== 'openutauHome'); // 渲染不依赖 OpenUtau 本体
      if (missingRender.length > 0) {
        fail(`配置缺失：${missingRender.join('、')}（用 --resampler/--bank、环境变量或 .videograph/vocal.json 提供）`, EXIT.CONFIG, { missing: missingRender, example: configExample() });
      }
      const ustxText = readFileSync(ustxPath, 'utf8');
      const workDir = typeof args['work-dir'] === 'string'
        ? asPath(args['work-dir'], 'work-dir')
        : mkdtempSync(join(tmpdir(), 'videograph-vocal-render-'));
      const result = await renderUstx({
        ustxText,
        resampler: config.sources.resampler.value,
        outWav: outPath,
        voicebankDir: config.sources.voicebankDir.value,
        workDir,
        contract: config.sources.resamplerContract?.value ?? 'classic',
        cacheDir: args['no-cache'] ? undefined : (config.sources.cacheDir?.value ?? join(homedir(), '.videograph', 'vocal-cache')),
        log: args.json ? undefined : (line) => console.log(line),
      });
      out({ ok: true, ...result }, `✔ ${outPath}（${result.noteCount} 音符，${result.bank.name}，${Math.round(result.durationSamples / 44100 * 1000)}ms）`);
      process.exit(EXIT.OK);
      break;
    }

    default:
      fail(`未知命令: ${command ?? '（空）'}。可用：check / make-ustx / check-ustx / make-ust / render`, EXIT.INPUT);
  }
} catch (err) {
  fail(err.message, err instanceof UstxError ? EXIT.INPUT : EXIT.UNEXPECTED, args.json ? { stack: err.stack } : {});
}
