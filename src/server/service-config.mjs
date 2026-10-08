// @ts-check
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse configuration before opening a port, creating credentials or starting workers.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readServiceConfig(env = process.env) {
  const port = Number(env.VIDEOGRAPH_SERVICE_PORT ?? 5191);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || env.VIDEOGRAPH_SERVICE_PORT === '') throw new Error('VIDEOGRAPH_SERVICE_PORT must be an integer in 0..65535');
  const stallMs = Number(env.VIDEOGRAPH_JOB_STALL_MS ?? 600_000);
  if (!Number.isSafeInteger(stallMs) || stallMs <= 0) throw new Error('VIDEOGRAPH_JOB_STALL_MS must be a positive integer');
  const allowedOrigins = new Set((env.VIDEOGRAPH_STUDIO_ORIGINS ?? 'http://127.0.0.1:5188,http://localhost:5188').split(',').map((origin) => origin.trim()).filter(Boolean));
  if (!allowedOrigins.size) throw new Error('At least one explicit Studio origin is required');
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.origin !== origin) throw new Error('Studio origins must be explicit local HTTP origins');
  }
  const root = fileURLToPath(new URL('../..', import.meta.url));
  return { host: '127.0.0.1', port, stallMs, allowedOrigins, tokenPath: resolve(env.VIDEOGRAPH_SERVICE_TOKEN_FILE ?? join(root, '.cache/service-token')) };
}
