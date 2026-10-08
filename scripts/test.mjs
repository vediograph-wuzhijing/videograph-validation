import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const portable = process.argv.includes('--portable');
// These suites need GPU/browser rendering or the separately installed reference engine.
const integration = new Set([
  'scripts/tests/ae/ae-tools.test.mjs', 'scripts/tests/ae/render-cancel.test.mjs',
  'scripts/tests/director/director-mcp.test.mjs', 'scripts/tests/director/song-operations.test.mjs',
  'scripts/tests/feedback/mcp-feedback-tools.test.mjs', 'scripts/tests/song/song-project.test.mjs',
  'scripts/tests/vocal/integration.test.mjs',
  'scripts/tests/stab/shutter-engine.test.mjs',
]);
function discover(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return discover(path);
    return /(?:\.test|-test)\.mjs$/.test(entry.name) && !(portable && integration.has(path)) ? [path] : [];
  });
}
const tests = discover('scripts').sort();
console.log(`${portable ? 'Portable' : 'Full'} tests: ${tests.length} files`);
// Bound simultaneous browser/SQLite/engine-copy suites on high-core developer machines.
const child = spawn(process.execPath, ['--test', '--test-concurrency=4', ...tests], { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
