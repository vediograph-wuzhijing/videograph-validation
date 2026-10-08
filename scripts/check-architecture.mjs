import ts from 'typescript';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const normalize = (path) => path.replaceAll('\\', '/');
const sourceExtensions = ['.ts', '.tsx', '.mjs', '.js'];
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : sourceExtensions.includes(extname(path)) ? [path] : [];
  });
}
/** Parse imports with the existing TypeScript compiler; do not treat comments/GLSL as imports. */
export function sourceGraph(root) {
  const files = sourceFiles(resolve(root, 'src'));
  const edges = new Map(files.map((file) => [normalize(relative(root, file)), []]));
  const problems = [];
  for (const file of files) {
    const name = normalize(relative(root, file)), imports = [];
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const onlyTypes = clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly));
        if (!onlyTypes) imports.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some((e) => !e.isTypeOnly)) imports.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of new Set(imports)) {
      if (!specifier.startsWith('.')) { edges.get(name).push(specifier); continue; }
      const base = resolve(dirname(file), specifier.split('?')[0]);
      const target = [base, ...sourceExtensions.map((extension) => base + extension), ...sourceExtensions.map((extension) => resolve(base, 'index' + extension))].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      // JSON/raw resources are leaves, not executable modules.
      if (!target) problems.push(`${name}: unresolved local import ${specifier}`);
      else edges.get(name).push(normalize(relative(root, target)));
    }
  }
  return { edges, problems };
}
export function architectureProblems(graph) {
  const problems = [...graph.problems];
  const foundation = new Set(['src/server/project-repository.mjs', 'src/server/project-generation.mjs', 'src/server/project-backup.mjs', 'src/server/file-hash.mjs']);
  const featureOrAdapter = /src\/server\/(routes\/|service\.mjs|index\.mjs|http-app\.mjs|project-router\.mjs|mcp-|song-project\.mjs|vocal-project\.mjs|director\.mjs|project-store\.mjs|render-jobs\.mjs)/;
  for (const [from, targets] of graph.edges) for (const to of targets) {
    if ((from === 'src/main.tsx' || /^src\/(project|brand|design)\//.test(from)) && (/^src\/(server|pdoom)\//.test(to) || builtins.has(to))) problems.push(`browser boundary: ${from} -> ${to}`);
    if (/^src\/(song|vocal|fx)\//.test(from) && /^src\/server\//.test(to)) problems.push(`engine boundary: ${from} -> ${to}`);
    if (/^src\/server\//.test(from) && /^src\/project\//.test(to)) problems.push(`server boundary: ${from} -> ${to}`);
    if (foundation.has(from) && featureOrAdapter.test(to)) problems.push(`persistence boundary: ${from} -> ${to}`);
    if (to === 'src/server/index.mjs' || to === 'src/main.tsx' || to === 'src/pdoom/mcp-server.ts') problems.push(`executable import: ${from} -> ${to}`);
  }
  const visited = new Set(), active = new Set(), path = [];
  function visit(node) {
    if (active.has(node)) { problems.push(`runtime cycle: ${[...path.slice(path.indexOf(node)), node].join(' -> ')}`); return; }
    if (visited.has(node) || !graph.edges.has(node)) return;
    active.add(node); path.push(node);
    for (const target of graph.edges.get(node)) visit(target);
    path.pop(); active.delete(node); visited.add(node);
  }
  for (const node of graph.edges.keys()) visit(node);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url)), graph = sourceGraph(root), problems = architectureProblems(graph);
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log(`Architecture checked: ${graph.edges.size} source modules; no runtime cycles or forbidden imports.`);
}
