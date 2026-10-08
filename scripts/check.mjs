// One process runner for local checks and CI; no shell quoting or platform-specific npm spawning.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const typesOnly = process.argv.includes('--types-only'), full = process.argv.includes('--full');
const steps = [
  ['frontend types', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  ['service foundation types', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'],
  ...typesOnly ? [] : [
    ['architecture', 'scripts/check-architecture.mjs'],
    ['documentation', 'scripts/check-docs.mjs'],
    [full ? 'full tests' : 'portable tests', 'scripts/test.mjs', ...full ? [] : ['--portable']],
    ...full ? [['production bundle', 'node_modules/vite/bin/vite.js', 'build']] : [],
  ],
];
for (const [label, ...args] of steps) {
  console.log(`Checking ${label}`);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => { console.error(error); done(1); });
    child.once('exit', (code) => done(code ?? 1));
  });
  if (code !== 0) { process.exitCode = code; break; }
}
