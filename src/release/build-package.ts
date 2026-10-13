'use strict';

// Build the JavaScript form published to npm in an isolated staging directory. The checkout stays
// TypeScript so local development and the source CLI keep using Node's native type stripping.
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { REPO_ROOT } = require('../helper/repo-root.ts');

const TEXT_EXTENSIONS = new Set(['.js', '.json', '.sh', '.md', '.yaml', '.yml']);

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function buildPackage(outDir: string, { repoRoot = REPO_ROOT }: { repoRoot?: string } = {}): string {
  if (typeof stripTypeScriptTypes !== 'function') {
    throw new Error('Node does not provide node:module.stripTypeScriptTypes');
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const output = path.resolve(outDir);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  for (const rel of packageJson.files || []) {
    const source = path.join(repoRoot, rel);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(output, rel), { recursive: true });
  }
  for (const name of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    const source = path.join(repoRoot, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(output, name));
  }

  const converted = new Set<string>();
  for (const file of walkFiles(path.join(output, 'src'))) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const relative = path.relative(output, file).split(path.sep).join('/');
    const jsRelative = relative.slice(0, -3) + '.js';
    const code = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(path.join(output, jsRelative), stripTypeScriptTypes(code, { mode: 'strip' }));
    fs.rmSync(file);
    converted.add(relative);
  }

  for (const file of walkFiles(output)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
    const relative = path.relative(output, file).split(path.sep).join('/');
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/(['"`])((?:\.\.?\/)[^'"`\n]*?\.ts)\1/g, (whole: string, quote: string, specifier: string) => {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!converted.has(resolved)) return whole;
      return `${quote}${specifier.slice(0, -3)}.js${quote}`;
    });
    for (const rel of [...converted].sort((a, b) => b.length - a.length)) {
      content = content.split(rel).join(rel.slice(0, -3) + '.js');
    }
    fs.writeFileSync(file, content);
  }

  const remaining = walkFiles(output);
  const runtimeFiles = ['src', 'bin'].flatMap((directory) => {
    const root = path.join(output, directory);
    return fs.existsSync(root) ? walkFiles(root) : [];
  });
  const nonDeclarationTs = runtimeFiles.filter((file: string) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  if (nonDeclarationTs.length) throw new Error(`staged package retains TypeScript files: ${nonDeclarationTs.join(', ')}`);
  for (const file of remaining) {
    if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
    const content = fs.readFileSync(file, 'utf8');
    const unresolved = [...converted].filter((rel) => content.includes(rel));
    if (unresolved.length) throw new Error(`${path.relative(output, file)} still references converted TypeScript paths: ${unresolved.join(', ')}`);
  }
  return output;
}

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    process.stderr.write('Usage: node src/release/build-package.ts <outDir>\n');
    process.exit(2);
  }
  buildPackage(outDir);
}

module.exports = { buildPackage };
