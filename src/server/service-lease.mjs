import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectsRoot } from './project-repository.mjs';
import { acquireProcessLease } from '../platform/process-lease.mjs';
/** One modern service owns a project root, even when its ports differ. */
export function acquireServiceLease() {
    mkdirSync(projectsRoot, { recursive: true });
    return acquireProcessLease(join(projectsRoot, '.service-owner.sqlite'));
}
