import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inquote-package-'));
  for (const file of ['package.json', 'pnpm-lock.yaml', 'Dockerfile', '.dockerignore', 'dist/main.js', 'dist/generated/prisma/client.js',
    'assets/auth/common-passwords.txt', 'openapi/auth.openapi.json', 'src/main.ts',
    'src/generated/client.ts', 'prisma/schema.prisma', 'prisma/migrations/initial/migration.sql',
    'test/unit/a.test.mjs', '.github/workflows/ci.yml', 'scripts/check.mjs', 'tsconfig.json',
    '.env', '.env.example', '.git/config', '.local/database.dump', 'src/.env', 'src/.env.example', 'assets/auth/.env', 'dist/.env']) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), file === 'package.json' ? '{"name":"synthetic","version":"0.0.0"}' : file);
  }
  return root;
}

test('runtime and Docker context include executable assets without source, tests or private files', async () => {
  const { buildPackage } = await import('../../scripts/package.mjs');
  const root = await fixture();
  try {
    for (const kind of ['runtime', 'context']) {
      const target = await buildPackage(root, kind);
      const manifest = JSON.parse(await readFile(join(target, 'artifact-manifest.json'), 'utf8'));
      assert.ok(manifest.files['dist/main.js']);
      assert.ok(manifest.files['dist/generated/prisma/client.js']);
      assert.ok(manifest.files['assets/auth/common-passwords.txt']);
      assert.ok(manifest.files['openapi/auth.openapi.json']);
      assert.equal(manifest.files['src/main.ts'], undefined);
      assert.equal(manifest.files['test/unit/a.test.mjs'], undefined);
      assert.ok(Object.keys(manifest.files).every(file => !file.split('/').includes('.env')));
      assert.equal(manifest.files['.git/config'], undefined);
      assert.equal(manifest.files['.local/database.dump'], undefined);
      assert.equal((await readdir(target)).includes('node_modules'), false);
      await assert.rejects(() => buildPackage(root, kind), /already exists/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source artifact retains verification inputs and migrations but excludes generated caches and private files', async () => {
  const { buildPackage } = await import('../../scripts/package.mjs');
  const root = await fixture();
  try {
    const target = await buildPackage(root, 'source');
    const manifest = JSON.parse(await readFile(join(target, 'artifact-manifest.json'), 'utf8'));
    for (const file of ['src/main.ts', '.env.example', 'prisma/migrations/initial/migration.sql', 'test/unit/a.test.mjs', '.github/workflows/ci.yml']) assert.ok(manifest.files[file]);
    for (const file of ['src/generated/client.ts', '.env', 'src/.env', 'src/.env.example', '.git/config', '.local/database.dump', 'dist/main.js']) assert.equal(manifest.files[file], undefined);
    assert.match(manifest.files['src/main.ts'], /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaging refuses symlinks in included paths and unknown artifact kinds', async () => {
  const { buildPackage } = await import('../../scripts/package.mjs');
  const root = await fixture();
  try {
    await symlink(join(root, '.local'), join(root, 'assets/auth/linked'), 'junction');
    await assert.rejects(() => buildPackage(root, 'runtime'), /symbolic link/);
    await assert.rejects(() => buildPackage(root, 'invalid'), /Unknown artifact kind/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact verification detects altered files and undeclared additions', async () => {
  const { buildPackage, verifyPackage } = await import('../../scripts/package.mjs');
  assert.equal(typeof verifyPackage, 'function');
  const root = await fixture();
  try {
    const target = await buildPackage(root, 'runtime');
    await verifyPackage(target);
    await writeFile(join(target, 'dist/main.js'), 'tampered');
    await assert.rejects(() => verifyPackage(target), /checksum/);
    await writeFile(join(target, 'dist/main.js'), 'dist/main.js');
    await writeFile(join(target, '.env'), 'synthetic-secret');
    await assert.rejects(() => verifyPackage(target), /undeclared/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
