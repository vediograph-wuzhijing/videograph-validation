// config 测试：解析链优先级、PATH/平台候选回退、以及"零硬编码路径"卫生检查（VOCAL-M1 验收硬指标）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveConfig, CONFIG_ENV_KEYS, configExample } from '../../../src/vocal/config.mjs';

const work = mkdtempSync(join(tmpdir(), 'videograph-vocal-config-'));
after(() => rmSync(work, { recursive: true, force: true }));

const NO_ENV = {}; // 干净环境：屏蔽机器上可能存在的真实变量

test('优先级：显式参数 > 环境变量 > 项目级配置文件 > 用户级配置文件', () => {
  const projectDir = join(work, 'proj');
  const userHome = join(work, 'home');
  mkdirSync(join(projectDir, '.videograph'), { recursive: true });
  mkdirSync(join(userHome, '.videograph'), { recursive: true });
  writeFileSync(join(projectDir, '.videograph', 'vocal.json'), JSON.stringify({
    openutauHome: 'FROM_PROJECT', resampler: 'FROM_PROJECT_RS', voicebankDir: 'FROM_PROJECT_BANK',
  }), 'utf8');
  writeFileSync(join(userHome, '.videograph', 'vocal.json'), JSON.stringify({
    openutauHome: 'FROM_USER', resampler: 'FROM_USER_RS', voicebankDir: 'FROM_USER_BANK',
  }), 'utf8');

  const fromFile = resolveConfig({
    projectRoot: projectDir, homedirOverride: userHome, envOverride: NO_ENV,
    // 项目级存在时用户级不应被读取（userHome 下文件此时不存在，读不到也无妨）
  });
  assert.equal(fromFile.sources.openutauHome.value, 'FROM_PROJECT');
  assert.equal(fromFile.missing.length, 0);

  const withEnv = resolveConfig({
    projectRoot: projectDir, homedirOverride: userHome,
    envOverride: { [CONFIG_ENV_KEYS.openutauHome]: 'FROM_ENV', [CONFIG_ENV_KEYS.resampler]: 'FROM_ENV_RS' },
  });
  assert.equal(withEnv.sources.openutauHome.value, 'FROM_ENV');
  assert.equal(withEnv.sources.resampler.value, 'FROM_ENV_RS');       // 环境变量覆盖文件
  assert.equal(withEnv.sources.voicebankDir.value, 'FROM_PROJECT_BANK'); // 文件补位

  const withOptions = resolveConfig({
    projectRoot: projectDir, homedirOverride: userHome, envOverride: { [CONFIG_ENV_KEYS.resampler]: 'FROM_ENV_RS' },
    openutauHome: 'FROM_OPTION', resampler: ['node', 'stub.mjs'],
  });
  assert.equal(withOptions.sources.openutauHome.value, 'FROM_OPTION');
  assert.deepEqual(withOptions.sources.resampler.value, ['node', 'stub.mjs']);
});

test('缺失项如实报告 missing，并给出配置方法（不抛错）', () => {
  const empty = resolveConfig({ projectRoot: join(work, 'nowhere'), homedirOverride: join(work, 'no-home'), envOverride: NO_ENV });
  const missing = new Set(empty.missing);
  // openutauHome 在装了 OpenUtau 的机器上可被 PATH/平台候选自动发现，两种状态都合法
  assert.ok(missing.has('openutauHome') || empty.sources.openutauHome, 'openutauHome 要么缺失要么自动发现');
  for (const key of ['resampler', 'voicebankDir']) {
    assert.ok(missing.has(key), `${key} 应报告缺失`);
    const check = empty.checks.find((c) => c.item === key && !c.ok);
    assert.ok(check.detail.includes('VIDEOGRAPH_'), '失败说明要指到环境变量');
  }
});

test('用户级配置文件在项目级缺失时生效', () => {
  const userHome = join(work, 'home2');
  mkdirSync(join(userHome, '.videograph'), { recursive: true });
  writeFileSync(join(userHome, '.videograph', 'vocal.json'), JSON.stringify({
    resampler: 'USER_RS', voicebankDir: 'USER_BANK',
  }), 'utf8');
  const resolved = resolveConfig({ projectRoot: join(work, 'no-proj'), homedirOverride: userHome, envOverride: NO_ENV });
  assert.equal(resolved.sources.resampler.value, 'USER_RS');
  assert.equal(resolved.sources.voicebankDir.value, 'USER_BANK');
});

test('坏 JSON / 顶层非对象：报错并指出文件路径', () => {
  const userHome = join(work, 'bad-home');
  mkdirSync(join(userHome, '.videograph'), { recursive: true });
  writeFileSync(join(userHome, '.videograph', 'vocal.json'), '{oops', 'utf8');
  assert.throws(
    () => resolveConfig({ projectRoot: join(work, 'no-proj2'), homedirOverride: userHome, envOverride: NO_ENV }),
    /配置文件不是合法 JSON/,
  );
});

test('卫生检查：src/vocal 全目录零硬编码盘符路径、零本机用户目录', () => {
  // VOCAL-M1 验收硬指标：任何一层都可配置，代码里不允许出现机器本地路径。
  const moduleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'vocal');
  const offenders = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { scan(full); continue; }
      if (!/\.(mjs|ts|json)$/.test(name)) continue;
      const text = readFileSync(full, 'utf8');
      if (/[A-Za-z]:[\\/]/.test(text)) offenders.push(`${name}: 盘符路径（转义与否都算）`);
      if (/Users[\\/]Martis|home[\\/]martis/.test(text)) offenders.push(`${name}: 本机用户目录`);
      if (/F:\\aicg|F:\/aicg/.test(text)) offenders.push(`${name}: 本机工作区路径`);
    }
  };
  scan(moduleDir);
  assert.deepEqual(offenders, []);
});

test('configExample：示例里的路径是占位符而非真实路径', () => {
  const example = configExample();
  assert.ok(example.env[CONFIG_ENV_KEYS.resampler].endsWith('.exe'));
  assert.equal(JSON.stringify(example).includes('Martis'), false);
});
