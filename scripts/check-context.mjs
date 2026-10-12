import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyPackage } from './package.mjs';

const directory = resolve('.artifacts/context');
await verifyPackage(directory);
const dockerfile = await readFile(join(directory, 'Dockerfile'), 'utf8');
const lines = dockerfile.split(/\r?\n/);
const bases = lines.filter(line => line.startsWith('FROM '));
assert.equal(bases.length, 2);
for (const line of bases) assert.match(line, /^FROM node:24\.13\.0-bookworm-slim@sha256:[a-f0-9]{64} AS (?:dependencies|runtime)$/);
assert.ok(lines.includes('USER node'));
assert.ok(lines.includes('CMD ["node", "dist/main.js"]'));
assert.match(dockerfile, /HEALTHCHECK .*127\.0\.0\.1:.*\/_ops\/live/);
assert.equal(lines.filter(line => line.startsWith('EXPOSE ')).join(), 'EXPOSE 3000');
for (const line of lines.filter(line => line.startsWith('COPY ') && !line.includes('--from='))) {
  const sources = line.split(/\s+/).slice(1, -1).filter(value => !value.startsWith('--'));
  for (const source of sources) {
    assert.ok(!source.includes('..') && !source.includes('*') && source !== '.');
    await lstat(join(directory, source));
  }
}
console.log('Docker context verified: checksums, pinned bases, explicit COPY inputs, nonroot user and private liveness probe.');
