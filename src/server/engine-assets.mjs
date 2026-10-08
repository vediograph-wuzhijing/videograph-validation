import { readFileSync, cpSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProjectError } from './errors.mjs';
const product = fileURLToPath(new URL('../..', import.meta.url));
export function copyEngineRuntime(target) {
    const source = join(product, 'engine-base/runtime');
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
    if (manifest.schema !== 'engine-base/v1' || !Array.isArray(manifest.files))
        throw new ProjectError('随包引擎清单无效', 500);
    for (const item of manifest.files) {
        if (typeof item.file !== 'string')
            throw new ProjectError('随包引擎清单路径无效', 500);
        const rel = relative(source, resolve(source, item.file));
        if (rel.startsWith('..') || isAbsolute(rel) || item.file.includes('\\'))
            throw new ProjectError('随包引擎清单路径无效', 500);
        const hash = createHash('sha256').update(readFileSync(join(source, item.file))).digest('hex');
        if (hash !== item.sha256)
            throw new ProjectError(`随包引擎文件损坏：${item.file}`, 500);
    }
    cpSync(source, target, { recursive: true });
    const components = join(product, 'engine-base/components');
    if (existsSync(components))
        cpSync(components, join(target, 'app/src/components'), { recursive: true });
}
