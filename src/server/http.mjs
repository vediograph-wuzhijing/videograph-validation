// @ts-check
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline, Transform } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { ProjectError } from './errors.mjs';

/** @param {string} value */
export function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { throw new ProjectError('invalid URL encoding', 400); }
}

/** @param {AsyncIterable<Buffer>} req @param {number} [limit] @returns {Promise<Record<string, unknown>>} */
export async function readJsonObject(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ProjectError('request too large', 413);
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ProjectError('invalid JSON', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectError('JSON body must be an object', 400);
  return input;
}

/** @param {import('node:http').ServerResponse} res @param {string} path
 * @param {Parameters<typeof createReadStream>[1]} [options] */
export function streamFile(res, path, options) {
  pipeline(createReadStream(path, options), res, (error) => {
    if (error && (!('code' in error) || error.code !== 'ERR_STREAM_PREMATURE_CLOSE')) console.error('[file stream]', error);
  });
}

/** @param {import('node:http').IncomingMessage} req @param {string} path @param {number} [limit] */
export async function saveUpload(req, path, limit = 300 * 1024 * 1024) {
  let size = 0;
  const bounded = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    callback(size > limit ? new ProjectError('audio exceeds 300 MB', 413) : null, chunk);
  } });
  // Do not pipeline req itself: an oversize upload must still receive a JSON 413 response.
  await pipelineAsync(req.iterator({ destroyOnReturn: false }), bounded, createWriteStream(path, { flags: 'wx' }));
}

/** @param {unknown} error */
export function publicError(error) {
  if (error instanceof ProjectError) return { status: error.status, data: { ...error.details, error: error.message } };
  console.error('[service]', error);
  return { status: 500, data: { error: 'internal service error' } };
}
