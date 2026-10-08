// @ts-check
// Files are immutable and durable BEFORE SQLite publishes the generation pointer.
// No consumer reads partially replaced engine/data or a half-written analysis.
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { renameRetrySync } from '../platform/files.mjs';

/** @typedef {{ analysisGeneration?: string }} GenerationProject */
/** @param {string | Buffer} bytes */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const GENERATION_FILES = ['analysis-v2.json', 'data/audio.json', 'data/lyrics.json', 'engine-manifest.json'];
/** @param {string} dir */
function syncDirectory(dir) {
  let fd;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (!(process.platform === 'win32' && typeof code === 'string' && ['EPERM', 'EISDIR', 'EINVAL', 'EBADF'].includes(code))) throw error;
  }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** @param {string} path @param {string} bytes */
function durableFile(path, bytes) {
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
/** @param {string} dir @param {GenerationProject} project */
export function generationDir(dir, project) {
  if (!project.analysisGeneration) return null;
  if (!/^[a-f0-9]{64}$/.test(project.analysisGeneration)) throw new Error('invalid analysis generation');
  return join(dir, 'generations', project.analysisGeneration);
}
/** @param {string} dir @param {GenerationProject} project */
export function projectAnalysisFile(dir, project) { const root = generationDir(dir, project); return root ? join(root, 'analysis-v2.json') : join(dir, 'analysis/analysis-v2.json'); }
/** @param {string} dir @param {GenerationProject} project */
export function projectManifestFile(dir, project) { const root = generationDir(dir, project); return root ? join(root, 'engine-manifest.json') : join(dir, 'engine-manifest.json'); }
/** @param {string} dir @param {GenerationProject} project */
export function projectDataRoot(dir, project) { const root = generationDir(dir, project); return root ? join(root, 'data') : join(dir, 'engine/data'); }
/** @param {string} dir @param {GenerationProject} project @param {string} path */
export function projectEngineFile(dir, project, path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('invalid engine manifest path');
  return path.startsWith('data/') ? join(projectDataRoot(dir, project), path.slice(5)) : join(dir, 'engine', path);
}
/** @param {string} dir @param {GenerationProject} project */
export function verifyGeneration(dir, project) {
  const location = generationDir(dir, project);
  if (!location) return;
  const files = JSON.parse(readFileSync(join(location, 'generation.json'), 'utf8'));
  if (!Array.isArray(files) || files.length !== GENERATION_FILES.length || hash(JSON.stringify(files)) !== project.analysisGeneration) throw new Error('generation index is corrupt');
  for (let i = 0; i < files.length; i++) {
    const [name, expected] = files[i];
    if (name !== GENERATION_FILES[i] || hash(readFileSync(join(location, name))) !== expected) throw new Error(`generation file is corrupt: ${name}`);
  }
}
/** @param {string} dir @param {Record<string, string>} contents
 * @param {{ checkpoint?: (point: string) => void }} [options] */
export function stageGeneration(dir, contents, { checkpoint = () => {} } = {}) {
  const index = GENERATION_FILES.map((name) => {
    if (typeof contents[name] !== 'string') throw new Error(`missing generation file: ${name}`);
    return [name, hash(contents[name])];
  });
  const analysisGeneration = hash(JSON.stringify(index)), root = join(dir, 'generations'), destination = join(root, analysisGeneration);
  mkdirSync(root, { recursive: true });
  if (existsSync(destination)) { verifyGeneration(dir, { analysisGeneration }); return analysisGeneration; }
  // Interrupted staging dirs are never active and never mistaken for complete generations.
  const staging = join(root, `.staging-${randomUUID()}`);
  mkdirSync(join(staging, 'data'), { recursive: true });
  try {
    for (const name of GENERATION_FILES) { durableFile(join(staging, name), contents[name]); checkpoint(`file:${name}`); }
    durableFile(join(staging, 'generation.json'), JSON.stringify(index));
    syncDirectory(join(staging, 'data')); syncDirectory(staging);
    checkpoint('before-publish');
    renameRetrySync(staging, destination); syncDirectory(root); syncDirectory(dir);
    checkpoint('after-publish');
    return analysisGeneration;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
