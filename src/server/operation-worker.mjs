import { parentPort } from 'node:worker_threads';
import { operations } from './operation-catalog.mjs';
parentPort.on('message', async ({ id, name, args }) => {
    try {
        if (!Object.hasOwn(operations, name))
            throw new Error(`unknown worker operation: ${name}`);
        const value = await operations[name](...args);
        parentPort.postMessage({ id, value });
    }
    catch (error) {
        parentPort.postMessage({ id, error: { message: error.message, status: error.status ?? (error.name === 'UstxError' ? 400 : 500), details: error.details } });
    }
});
