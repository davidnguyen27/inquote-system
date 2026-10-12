import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = ['package.json', 'pnpm-lock.yaml', 'dist', 'assets/auth', 'openapi'];
const inputs = {
  runtime,
  context: [...runtime, 'Dockerfile', '.dockerignore'],
  source: ['package.json', 'pnpm-lock.yaml', '.gitignore', '.dockerignore', '.env.example', 'Dockerfile',
    'tsconfig.json', 'tsconfig.build.json', 'eslint.config.mjs', 'prisma.config.ts',
    'src', 'assets/auth', 'openapi', 'prisma', 'scripts', 'test', '.github'],
};
const blocked = new Set(['.git', '.local', '.tmp', '.artifacts', 'node_modules', 'coverage']);

export async function verifyPackage(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8'));
  if (!Object.hasOwn(inputs, manifest.kind)) throw new Error('Unknown artifact kind');
  const actual = new Set();
  async function walk(relative = '') {
    for (const name of await readdir(join(directory, relative))) {
      if (!relative && (name === 'artifact-manifest.json' || (manifest.kind === 'runtime' && name === 'node_modules'))) continue;
      const file = relative ? relative + '/' + name : name;
      const stat = await lstat(join(directory, file));
      if (stat.isSymbolicLink()) throw new Error('Artifact contains a symbolic link');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) actual.add(file);
      else throw new Error('Artifact contains a nonregular file');
    }
  }
  await walk();
  for (const [file, checksum] of Object.entries(manifest.files)) {
    if (!actual.delete(file)) throw new Error('Artifact has a missing file');
    const digest = createHash('sha256').update(await readFile(join(directory, file))).digest('hex');
    if (digest !== checksum) throw new Error('Artifact checksum mismatch');
  }
  if (actual.size) throw new Error('Artifact has an undeclared file');
}

export async function buildPackage(root, kind) {
  if (!Object.hasOwn(inputs, kind)) throw new Error('Unknown artifact kind');
  const destination = join(root, '.artifacts', kind);
  try { await lstat(destination); throw new Error('Artifact destination already exists; use a fresh checkout or remove that artifact explicitly.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = {};
  async function copy(relative) {
    const name = relative.split('/').at(-1);
    const sourceTemplate = kind === 'source' && relative === '.env.example';
    if (blocked.has(name) || relative === 'src/generated' || (name.startsWith('.env') && !sourceTemplate) || /\.(?:log|dump|backup|bak|pem|key|tsbuildinfo)$/i.test(name)) return;
    const source = join(root, relative);
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) throw new Error('Artifact input contains a symbolic link');
    if (stat.isDirectory()) {
      for (const child of (await readdir(source)).sort()) await copy(relative + '/' + child);
    } else if (stat.isFile()) {
      const target = join(destination, relative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      files[relative] = createHash('sha256').update(await readFile(target)).digest('hex');
    } else throw new Error('Artifact input must be a regular file or directory');
  }
  for (const input of inputs[kind]) {
    try { await lstat(join(root, input)); }
    catch (error) { if (error.code === 'ENOENT' && kind === 'source') continue; throw error; }
    await copy(input);
  }
  await writeFile(join(destination, 'artifact-manifest.json'), JSON.stringify({ kind, files }, null, 2) + '\n');
  await verifyPackage(destination);
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await buildPackage(root, process.argv[2]);
  console.log('Artifact prepared: ' + process.argv[2]);
}
