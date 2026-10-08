// @ts-check
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ProjectError } from './errors.mjs';

// Credentials identify the caller; request bodies never confer human authority.
/** @param {ReadonlySet<string>} allowedOrigins */
export function createServiceAuth(allowedOrigins) {
  const mcpToken = randomUUID() + randomUUID();
  const studioToken = randomUUID() + randomUUID();
  /** @param {string | undefined} header @param {string} token */
  const matches = (header, token) => {
    const actual = Buffer.from(header ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  return {
    mcpToken,
    /** @param {string | undefined} origin */
    session(origin) {
      if (typeof origin !== 'string' || !allowedOrigins.has(origin)) throw new ProjectError('studio origin required', 403);
      return { token: studioToken };
    },
    /** @param {string | undefined} header @returns {'human' | 'mcp'} */
    actor(header) {
      if (matches(header, studioToken)) return 'human';
      if (matches(header, mcpToken)) return 'mcp';
      throw new ProjectError('local service authorization required', 401);
    },
  };
}

/** @param {string | null} actor @param {string[]} parts @param {Record<string, unknown>} input */
export function authorizeMutation(actor, parts, input) {
  if (actor === 'human') return;
  if ((parts[2] === 'vocal' && ['adopt', 'reset', 'lyrics'].includes(parts[3])) || parts.includes('accept-feedback') || parts.includes('reject-feedback') || parts.includes('accept-review') ||
      (parts[4] === 'feedback' && parts[6] === 'reply') || (typeof input.patch === 'object' && input.patch !== null && Object.hasOwn(input.patch, 'locked'))) {
    throw new ProjectError('此操作只允许人在审阅室完成', 403);
  }
}
