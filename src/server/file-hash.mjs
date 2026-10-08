// @ts-check
import { openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Bounded memory even for multi-gigabyte source media and exports. @param {string} path */
export function hashFile(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
