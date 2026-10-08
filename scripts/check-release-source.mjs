// Check the exact staged tree before publishing; ignored files alone are not a boundary.
import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(line => {
  const match = /^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
  if (!match) throw new Error('Unexpected Git index record');
  return { mode: match[1], hash: match[2], stage: match[3], file: match[4] };
});
const media = /\.(?:mp3|wav|flac|m4a|ogg|opus|aac|wma|aiff?|aifc|caf|w64|sf2|sfz|mid|midi|mp4|mov|webm|avi|mkv|m4v|sqlite(?:-wal|-shm)?|pt|pth|ckpt|onnx|gguf|ggml|safetensors)$/i;
const paths = /(?:^|\/)(?:node_modules|dist|video|projects|voicebanks|\.models|\.cache|\.queue|\.git|\.videograph)(?:\/|$)|(?:^|\/)(?:workbench\.json|service-token[^/]*|oto\.ini|character\.yaml|\.env(?:\..*)?)$/i;
const texts = new Set(['.md', '.mjs', '.js', '.ts', '.tsx', '.json', '.py', '.yaml', '.yml', '.html', '.css', '.txt', '.example']);
const failures = [];
const scan = [];
for (const entry of entries) {
  const { file, mode, stage } = entry;
  if (stage !== '0' || mode !== '100644' && mode !== '100755') {
    failures.push({ file, reason: 'unmerged entry, symbolic link or submodule requires review' });
    continue;
  }
  if (media.test(file) || (paths.test(file) && file !== '.env.example') || (file.startsWith('public/audio/') && file !== 'public/audio/.gitkeep')) {
    failures.push({ file, reason: 'media, model, bank, runtime data or private configuration' });
    continue;
  }
  if (texts.has(extname(file)) || file.startsWith('engine-base/runtime/')) scan.push(entry);
}
// One read of staged blobs, rather than a Git subprocess per file.
const blobs = scan.length ? git(['cat-file', '--batch'], { input: scan.map(entry => entry.hash).join('\n') + '\n', encoding: null, maxBuffer: 256 * 1024 * 1024 }) : Buffer.alloc(0);
let offset = 0;
const engineBlobs = new Map();
for (const { file, hash } of scan) {
  const newline = blobs.indexOf(10, offset);
  const header = blobs.subarray(offset, newline).toString('ascii');
  const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
  if (newline < 0 || !match || match[1] !== hash) throw new Error('Unexpected Git blob response');
  const size = Number(match[2]);
  offset = newline + 1;
  if (offset + size >= blobs.length || blobs[offset + size] !== 10) throw new Error('Truncated Git blob response');
  const buffer = blobs.subarray(offset, offset + size);
  const body = buffer.toString('utf8');
  if (file.startsWith('engine-base/runtime/')) engineBlobs.set(file, buffer);
  offset += size + 1;
  // Never print a matching credential. A failure identifies only its file.
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{32,})/.test(body))
    failures.push({ file, reason: 'possible credential or private key' });
}
const engineManifest = JSON.parse(engineBlobs.get('engine-base/runtime/manifest.json')?.toString('utf8') ?? 'null');
if (!engineManifest?.files?.length) failures.push({ file: 'engine-base/runtime/manifest.json', reason: 'missing engine manifest in staged source' });
else for (const { file, sha256 } of engineManifest.files) {
  const name = `engine-base/runtime/${file}`;
  const buffer = engineBlobs.get(name);
  if (!buffer || createHash('sha256').update(buffer).digest('hex') !== sha256)
    failures.push({ file: name, reason: 'staged engine bytes differ from manifest; check Git line-ending conversion' });
}
if (failures.length) {
  console.error(JSON.stringify({ checked: entries.length, failures }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ checked: entries.length, mediaFiles: 0, credentialMatches: 0, engineFiles: engineManifest.files.length }));
