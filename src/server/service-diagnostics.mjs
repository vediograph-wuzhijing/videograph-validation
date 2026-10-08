import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { productRoot, projectsRoot } from './project-repository.mjs';
function sourceFiles(root) {
    if (!existsSync(root))
        return [];
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(join(root, entry.name))
        : /\.(mjs|ts|tsx|json)$/.test(entry.name) ? [join(root, entry.name)] : []);
}
export function serviceDiagnostics() {
    const hash = createHash('sha256');
    for (const file of [...sourceFiles(join(productRoot, 'src')), join(productRoot, 'package.json')].sort())
        hash.update(file.slice(productRoot.length)).update(readFileSync(file));
    const databases = !existsSync(projectsRoot) ? [] : readdirSync(projectsRoot).flatMap(id => {
        const file = join(projectsRoot, id, 'project.sqlite');
        return existsSync(file) ? [statSync(file).size + (existsSync(file + '-wal') ? statSync(file + '-wal').size : 0)] : [];
    });
    return { codeFingerprint: hash.digest('hex'), diskVersion: JSON.parse(readFileSync(join(productRoot, 'package.json'), 'utf8')).version,
        database: { count: databases.length, totalBytes: databases.reduce((sum, n) => sum + n, 0), largestBytes: Math.max(0, ...databases) }, sampledAt: Date.now() };
}
