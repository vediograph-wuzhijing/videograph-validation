// Immutable JSON fragments. Small revision roots reference shared song/shot data;
// files are durable before a SQLite record can point at them.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { renameRetrySync } from '../platform/files.mjs';
const REF = '__videograph_ref', LITERAL = '__videograph_literal';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const singleKey = (value, key) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, key);
function location(dir, hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error('invalid immutable record hash');
    return join(dir, '.records', 'objects', `${hash}.json`);
}
export function putRecordObject(dir, value) {
    const text = JSON.stringify(value), hash = digest(text), path = location(dir, hash);
    if (existsSync(path)) {
        if (digest(readFileSync(path)) !== hash)
            throw new Error('immutable record is corrupt');
        return hash;
    }
    mkdirSync(join(dir, '.records', 'objects'), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx');
    try {
        writeFileSync(fd, text);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        renameRetrySync(temporary, path);
    }
    finally {
        if (existsSync(temporary))
            unlinkSync(temporary);
    }
    return hash;
}
export function getRecordObject(dir, hash, cache = new Map()) {
    if (cache.has(hash))
        return cache.get(hash);
    const bytes = readFileSync(location(dir, hash));
    if (digest(bytes) !== hash)
        throw new Error('immutable record is corrupt');
    const value = JSON.parse(bytes);
    cache.set(hash, value);
    return value;
}
export function encodeSnapshot(dir, value) {
    function pack(v, root = false) {
        if (singleKey(v, REF) || singleKey(v, LITERAL))
            return { [LITERAL]: v };
        const packed = Array.isArray(v) ? v.map(entry => pack(entry)) : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([key, entry]) => [key, pack(entry)])) : v;
        if (!root && packed !== undefined && Buffer.byteLength(JSON.stringify(packed)) > 4096)
            return { [REF]: putRecordObject(dir, packed) };
        return packed;
    }
    return { format: 'videograph-snapshot/v2', value: pack(value, true) };
}
export function decodeSnapshot(dir, record, cache = new Map()) {
    if (record?.format !== 'videograph-snapshot/v2')
        return record;
    function unpack(value, depth = 0) {
        if (depth > 100)
            throw new Error('immutable record nesting exceeds limit');
        if (singleKey(value, LITERAL))
            return value[LITERAL];
        if (singleKey(value, REF))
            return unpack(getRecordObject(dir, value[REF], cache), depth + 1);
        return Array.isArray(value) ? value.map(v => unpack(v, depth + 1)) : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, unpack(v, depth + 1)])) : value;
    }
    return unpack(record.value);
}
export function recordReferences(record, refs = new Set()) {
    if (singleKey(record, LITERAL))
        return refs;
    if (singleKey(record, REF)) {
        refs.add(record[REF]);
        return refs;
    }
    if (record && typeof record === 'object')
        for (const value of Object.values(record))
            recordReferences(value, refs);
    return refs;
}
