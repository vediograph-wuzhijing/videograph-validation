import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkDocs, documentationFiles } from '../../check-docs.mjs';

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'videograph-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

test('docs checks local images and links, UTF-8 headings, duplicate headings and references', (t) => {
  const root = fixture(t, {
    'README.md': '[一](guide.md#中文标题) [二](guide.md#中文标题-1) ![图](picture.png) [三][api]\n[api]: guide.md#api-v1\n[四](<a b.md> "空格")',
    'guide.md': '# 中文标题\n## 中文标题\n## API `v1`', 'picture.png': '', 'a b.md': '',
  });
  assert.deepEqual(checkDocs(root).errors, []);
});

test('docs reports missing files, invalid fragments, bad URI escapes and unresolved references with locations', (t) => {
  const root = fixture(t, {
    'README.md': '[a](gone.md)\n[b](guide.md#gone)\n[c][unknown]\n[d](%broken.md)',
    'guide.md': '# Exists',
  });
  const result = checkDocs(root);
  assert.equal(result.errors.length, 4);
  for (const line of [1, 2, 3, 4]) assert.ok(result.errors.some((error) => error.startsWith(`README.md:${line}:`)));
});

test('docs ignores fenced/indented code, inline examples, escaped links, comments and external destinations', (t) => {
  const root = fixture(t, {
    'README.md': '```md\n[fake](missing.md)\n```\n~~~\n[fake](missing.md)\n~~~\n    [fake](missing.md)\n`[fake](missing.md)`\n\\[fake](missing.md)\n<!-- [fake](missing.md) -->\n[online](https://example.invalid/) [resource](videograph://docs/vocal)',
  });
  assert.deepEqual(checkDocs(root).errors, []);
});

test('docs distinguishes delimiter lengths, unmatched backticks and multiline code spans', (t) => {
  const root = fixture(t, {
    'README.md': 'A literal ` unmatched here.\n\n``A ` tick`` and `{ lines[](词级),\nkick[](强度对) }`.\n\n[real](missing.md)',
  });
  const { errors } = checkDocs(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing local target: missing.md/);
});

test('docs discovers hidden skills and requires every current manual to be indexed', (t) => {
  const root = fixture(t, {
    'docs/README.md': '[manual](manual.md) [archive](archive/README.md)',
    'docs/manual.md': '', 'docs/orphan.md': '', 'docs/archive/README.md': '[snapshot](old.md)',
    'docs/archive/old.md': '[removed historical file](removed.md)',
    '.agents/skills/example/SKILL.md': '[missing](missing.md)', 'projects/test/user.md': '[missing](missing.md)',
  });
  const files = documentationFiles(root);
  assert.ok(files.includes('.agents/skills/example/SKILL.md'));
  assert.ok(!files.includes('docs/archive/old.md'));
  assert.ok(!files.includes('projects/test/user.md'));
  const { errors } = checkDocs(root);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.includes('current document not indexed: docs/orphan.md')));
  assert.ok(errors.some((error) => error.includes('.agents/skills/example/SKILL.md:1: missing')));
});
