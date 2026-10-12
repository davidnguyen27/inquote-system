import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

test('CI parses with read-only PR permissions, SHA-pinned actions and trusted-only artifact retention', () => {
  const text = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const document = YAML.parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.doesNotMatch(text, /secrets\.|pull_request_target|packages:\s*write|docker\s+(?:push|login)/);
  const job = workflow.jobs.verify;
  assert.match(job.services.postgres.image, /^postgres:17-bookworm@sha256:[a-f0-9]{64}$/);
  assert.match(new URL(job.env.TEST_DATABASE_URL).pathname, /_test$/);
  assert.equal(job.env.DATABASE_URL, job.env.TEST_DATABASE_URL);
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
  for (const step of job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@') || step.run?.includes('docker build'))) {
    assert.equal(step.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  }
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm verify', 'pnpm db:migrate',
    'pnpm db:check-drift', 'prisma/tests/invariants.sql', 'pnpm test:integration',
    'pnpm package:source', 'pnpm package:runtime', 'pnpm package:context']) assert.ok(commands.includes(command), command);
});
