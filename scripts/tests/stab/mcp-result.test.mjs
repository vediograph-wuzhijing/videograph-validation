import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('oversize image results retain one JSON block and structured paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vg-mcp-result-'));
  const original = process.env.VIDEOGRAPH_PROJECTS;
  process.env.VIDEOGRAPH_PROJECTS = root;
  try {
    const { mcpToolResult } = await import('../../../src/server/mcp-feedback-tools.ts');
    mkdirSync(join(root, 'p', 'artifacts'), { recursive: true });
    const images = ['a', 'b'].map((hex) => ({ file: `artifacts/${hex.repeat(64)}.png` }));
    for (const { file } of images) writeFileSync(join(root, 'p', file), Buffer.alloc(2 * 1024 * 1024));
    const value = { projectId: 'p', result: { stills: { images } } };
    const result = mcpToolResult(value);
    assert.equal(result.content.filter((item) => item.type === 'text').length, 1);
    assert.equal(result.content.filter((item) => item.type === 'image').length, 1);
    assert.deepEqual(result.structuredContent.imageEmbedding.skipped, [images[1].file]);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const pathsOnly = mcpToolResult(value, { embedImages: false });
    assert.deepEqual(pathsOnly.structuredContent, value);
    assert.equal(pathsOnly.content.length, 1);
    const report = mcpToolResult({ result: { text: 'multi\nline', count: 2 } });
    assert.equal(report.structuredContent.result.text, 'multi\nline');
  } finally {
    if (original === undefined) delete process.env.VIDEOGRAPH_PROJECTS; else process.env.VIDEOGRAPH_PROJECTS = original;
    rmSync(root, { recursive: true, force: true });
  }
});
