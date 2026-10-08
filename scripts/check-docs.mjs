// Offline validation of maintained Markdown links. Historical bodies and runtime/vendor
// directories are deliberately outside the manual's maintenance scope.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const folders = ['docs', 'analyzer', 'engine-base', 'skills', '.agents/skills'];
const slash = (path) => path.replaceAll('\\', '/');
const blank = (text) => text.replace(/[^\n]/g, ' ');

function withoutCodeBlocks(text) {
  let fence;
  return text.replace(/<!--[\s\S]*?-->/g, blank).split('\n').map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = undefined;
      return blank(line);
    }
    if (marker) { fence = marker; return blank(line); }
    return /^(?: {4}|\t)/.test(line) ? blank(line) : line;
  }).join('\n');
}

function headings(text) {
  const anchors = new Set(), counts = new Map();
  const lines = withoutCodeBlocks(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(lines[i])?.[1]
      ?? (i + 1 < lines.length && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) ? lines[i].trim() : undefined);
    if (!heading) continue;
    // GitHub-style heading IDs, including Chinese and duplicate headings.
    const base = heading.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
      .toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    let anchor = count ? `${base}-${count}` : base;
    let suffix = count;
    while (anchors.has(anchor)) anchor = `${base}-${++suffix}`;
    counts.set(base, suffix + 1);
    anchors.add(anchor);
  }
  return anchors;
}

function links(text) {
  // A code span can wrap within a paragraph, but cannot cross paragraph boundaries;
  // delimiters must have exactly the same length (single and double ticks coexist).
  const visible = withoutCodeBlocks(text).split(/(\n[ \t]*\n)/)
    .map((part) => part.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank)).join('');
  const references = new Map(), result = [];
  const normalize = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const destination = (raw) => /^<([^>]+)>/.exec(raw.trim())?.[1] ?? raw.trim().split(/\s/)[0];
  const lineAt = (index) => visible.slice(0, index).split('\n').length;
  for (const match of visible.matchAll(/^\s{0,3}\[([^\]\n]+)\]:\s*(.+)$/gm)) {
    const target = destination(match[2]);
    references.set(normalize(match[1]), target);
    result.push({ target, line: lineAt(match.index) });
  }
  for (const match of visible.matchAll(/(?<!\\)!?\[[^\]\n]*\]\((<[^>\n]+>|(?:\\.|[^()\n]|\([^()\n]*\))*)\)/g)) {
    result.push({ target: destination(match[1]).replace(/\\([ ()])/g, '$1'), line: lineAt(match.index) });
  }
  for (const match of visible.matchAll(/(?<!\\)!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = normalize(match[2] || match[1]);
    if (!references.has(label)) result.push({ error: `undefined link reference: ${label}`, line: lineAt(match.index) });
  }
  return result;
}

export function documentationFiles(root = repo) {
  const files = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name);
  function walk(dir) {
    if (!existsSync(resolve(root, dir))) return;
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (file === 'engine-base/runtime') continue;
      if (file === 'docs/archive') { if (existsSync(resolve(root, file, 'README.md'))) files.push(`${file}/README.md`); }
      else if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(file);
    }
  }
  for (const dir of folders) walk(dir);
  return files.sort();
}

export function checkDocs(root = repo, files = documentationFiles(root)) {
  const errors = [], cache = new Map(), linkedFromHub = new Set();
  let count = 0;
  for (const file of files) {
    const source = resolve(root, file);
    for (const link of links(readFileSync(source, 'utf8'))) {
      const fail = (reason) => errors.push(`${file}:${link.line}: ${reason}`);
      if (link.error) { fail(link.error); continue; }
      const target = link.target;
      if (!target || /^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) continue;
      let path, fragment;
      try { [path, fragment] = target.split('#').map((part) => decodeURIComponent(part)); }
      catch { fail(`invalid encoded link: ${target}`); continue; }
      const destination = path ? resolve(dirname(source), path) : source;
      count++;
      if (!existsSync(destination)) { fail(`missing local target: ${target}`); continue; }
      if (file === 'docs/README.md') linkedFromHub.add(slash(relative(root, destination)));
      if (fragment && extname(destination).toLowerCase() === '.md') {
        if (!cache.has(destination)) cache.set(destination, headings(readFileSync(destination, 'utf8')));
        if (!cache.get(destination).has(fragment)) fail(`missing heading: ${target}`);
      }
    }
  }
  // All current manuals (including templates and compatibility pointers) must be
  // discoverable from the single hub. Module-local references keep their own indexes.
  if (files.includes('docs/README.md')) {
    for (const file of files.filter((file) => file.startsWith('docs/') && file !== 'docs/README.md')) {
      if (!linkedFromHub.has(file)) errors.push(`docs/README.md: current document not indexed: ${file}`);
    }
  }
  return { files: files.length, links: count, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkDocs();
  if (report.errors.length) { console.error(report.errors.join('\n')); process.exitCode = 1; }
  else console.log(`Documentation: ${report.files} maintained Markdown files, ${report.links} local links valid; current manuals indexed.`);
}
