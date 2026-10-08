// Release allowlist, SHA manifest and dependency notices. Never copy the
// workspace wholesale: audio, user projects, models and credentials stay out.
import { cpSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url)), version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Windows x64 package must be built on Windows x64');
const target = resolve(process.argv[2] ?? join(root, `.cache/releases/VideoGraph-${version}-windows-x64`));
const archive = `${target}.zip`;
if (existsSync(target) || existsSync(archive))
    throw new Error('Release destination exists; use a new directory, never overwrite a frozen package');
if (!existsSync(join(root, 'dist/index.html')))
    throw new Error('Run npm run build before packaging');
const forbidden = /\.(?:mp3|wav|flac|m4a|ogg|opus|aac|wma|aiff?|aifc|caf|w64|sf2|sfz|mid|midi|mp4|mov|webm|avi|mkv|m4v|sqlite(?:-wal|-shm)?|pt|pth|ckpt|onnx|gguf|ggml|safetensors)$/i;
const excluded = new Set(['.cache', '.vite', '.vite-temp', '__pycache__', '.git']);
const filter = path => {
    const rel = relative(root, path).replaceAll('\\', '/'), name = path.split(/[\\/]/).at(-1);
    return !rel.split('/').some(p => excluded.has(p)) && !forbidden.test(name) && !/^\.env/.test(name) && !/^workbench\.json$/.test(name) && !/^tmp-/.test(name) && !name.endsWith('.log') && !name.endsWith('.pyc');
};
mkdirSync(target, { recursive: true });
for (const name of ['src', 'dist', 'engine-base', 'effects', 'analyzer', 'skills', '.agents', '.github', 'docs', 'examples', 'node_modules'])
    cpSync(join(root, name), join(target, name), { recursive: true, dereference: true, filter });
for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'HANDOFF.md', 'CLAUDE.md', '.env.example', '.editorconfig', '.gitattributes', '.gitignore', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'index.html'])
    copyFileSync(join(root, name), join(target, name));
const releaseReadme = readFileSync(join(target, 'README.md'), 'utf8').replace(/2026 xihack[\s\S]*?\n---/, 'Windows 完整工作台 0.2.0。此包不包含演示影片、原始音频或声库。使用前运行 Doctor.cmd，配置外部工具后运行 Start-Workbench.cmd。\n\n---');
writeFileSync(join(target, 'README.md'), releaseReadme);
mkdirSync(join(target, 'public/brand-demo'), { recursive: true });
for (const name of ['favicon.svg', 'brand-demo/demo-library.json', 'brand-demo/demo-logo.svg'])
    copyFileSync(join(root, 'public', name), join(target, 'public', name));
cpSync(join(root, 'scripts'), join(target, 'scripts'), { recursive: true, filter });
mkdirSync(join(target, 'runtime'), { recursive: true });
copyFileSync(process.execPath, join(target, 'runtime/node.exe'));
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
if (!license.ok)
    throw new Error('Cannot retrieve the exact bundled Node.js license');
writeFileSync(join(target, 'runtime/NODE-LICENSE.txt'), await license.text());
const settings = { servicePort: 5191, studioPort: 5188, projects: 'projects', FFMPEG_PATH: 'ffmpeg', FFPROBE_PATH: 'ffprobe', VIDEOGRAPH_ANALYZER_PYTHON: '', VIDEOGRAPH_ANALYZER_T3_PYTHON: '', VIDEOGRAPH_MODELS_DIR: '', VIDEOGRAPH_VOICEBANK_DIR: '', VIDEOGRAPH_OPENUTAU_RESAMPLER: '' };
writeFileSync(join(target, 'workbench.example.json'), JSON.stringify(settings, null, 2));
const cmd = (script, args = '') => `@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" --env-file-if-exists=.env.local ${script} ${args}\r\n`;
writeFileSync(join(target, 'Start-Workbench.cmd'), cmd('scripts/workbench.mjs', 'start') + 'pause\r\n');
writeFileSync(join(target, 'Stop-Workbench.cmd'), cmd('scripts/workbench.mjs', 'stop') + 'pause\r\n');
writeFileSync(join(target, 'Doctor.cmd'), cmd('scripts/workbench.mjs', 'doctor') + 'pause\r\n');
writeFileSync(join(target, 'MCP.cmd'), cmd('scripts/workbench.mjs', 'mcp'));
writeFileSync(join(target, 'HTTP-Tools.cmd'), cmd('scripts/workbench.mjs', 'http-tools %*'));
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]);
const packages = walk(join(target, 'node_modules')).filter(f => /(?:^|\/)package\.json$/.test(f)).flatMap(file => {
    try {
        const p = JSON.parse(readFileSync(join(target, 'node_modules', file)));
        return p.name && p.version ? [{ name: p.name, version: p.version, license: p.license ?? p.licenses ?? 'UNKNOWN', file: `node_modules/${file}` }] : [];
    }
    catch {
        return [];
    }
});
const invalid = packages.filter(p => p.license === 'UNKNOWN' || p.license === 'UNLICENSED');
if (invalid.length)
    throw new Error(`Dependency licenses require review: ${JSON.stringify(invalid)}`);
writeFileSync(join(target, 'DEPENDENCY-LICENSES.json'), JSON.stringify(packages, null, 2));
writeFileSync(join(target, 'DISTRIBUTION.txt'), `VideoGraph ${version} Windows x64 workbench\n\nIncludes Node ${process.version}, offline npm dependencies, Studio, HTTP, MCP, engine/fonts, analysis adapters and source. Start-Workbench.cmd starts a hidden owned process; Doctor.cmd checks prerequisites. Copy workbench.example.json to workbench.json for paths/ports. See docs/OPERATIONS.md.\n\nFFmpeg/ffprobe and Edge/Chromium are external prerequisites; Python/models and licensed voicebanks/resamplers are externally configured. No original audio, MIDI, video, voicebank samples, user projects, model weights, caches, .env or credentials are distributed. Reference song importing only works when the operator separately provides their lawful local reference repository. New-song workflows use the included engine.\n\nThis software is GPL-3.0-only, with included source/LICENSE; bundled dependencies/fonts keep their own licenses. Exact installed dependency licenses are in DEPENDENCY-LICENSES.json and their packages. Bundled Node license: runtime/NODE-LICENSE.txt. Engine MIT notice: engine-base/runtime/LICENSE. FFmpeg binaries are not redistributed by this package.\n`);
const files = walk(target);
const leaks = files.filter(f => f !== '.env.example' && (forbidden.test(f) || /(?:^|\/)(?:projects|voicebanks|\.models|\.cache|\.env(?:\..*)?|service-token)(?:\/|$)/i.test(f)));
if (leaks.length)
    throw new Error(`Forbidden release payload: ${JSON.stringify(leaks)}`);
const manifest = { schema: 'videograph-release/v1', version, platform: 'windows-x64', node: process.version, builtAt: new Date().toISOString(), external: ['FFmpeg/ffprobe', 'Edge/Chromium', 'Python/models', 'voicebank/resampler'], files: files.map(file => ({ file, bytes: statSync(join(target, file)).size, sha256: createHash('sha256').update(readFileSync(join(target, file))).digest('hex') })) };
writeFileSync(join(target, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
// Paths travel as environment values, never interpolated into shell source.
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:VIDEOGRAPH_PACKAGE_INPUT, $env:VIDEOGRAPH_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)'], {
    env: { ...process.env, VIDEOGRAPH_PACKAGE_INPUT: target, VIDEOGRAPH_PACKAGE_ZIP: archive }, windowsHide: true, stdio: 'inherit'
});
const archiveHash=createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${archiveHash}  ${archive.split(/[\\/]/).at(-1)}\n`);
console.log(JSON.stringify({ target, archive, sha256:archiveHash, archiveBytes:statSync(archive).size, files: files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), audioFiles: 0, dependencyPackages: packages.length }, null, 2));
