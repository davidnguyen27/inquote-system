import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import request from 'supertest';
import {createApp} from '../../dist/app.js';
import {fixtureConfig} from '../helpers.mjs';

test('enabled API docs redirect the root and serve the existing contract with local assets', async () => {
  const app = createApp({...fixtureConfig(), apiDocsEnabled: true}, {});
  const root = await request(app).get('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/docs/');
  const page = await request(app).get('/docs/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /swagger-ui/);
  assert.match(page.text, /InQuote API Docs/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.doesNotMatch(page.headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'(?:;|$)/);

  const spec = await request(app).get('/openapi.json');
  assert.equal(spec.status, 200);
  assert.deepEqual(spec.body, JSON.parse(readFileSync(new URL('../../openapi/auth.openapi.json', import.meta.url), 'utf8')));
  assert.equal(spec.headers['cache-control'], 'no-store');
  const init = await request(app).get('/docs/swagger-ui-init.js');
  assert.equal(init.status, 200);
  assert.match(init.text, /\/openapi\.json/);
  assert.match(init.text, /"validatorUrl":\s*null/);
  assert.match(init.text, /"persistAuthorization":\s*false/);
  for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js']) {
    const response = await request(app).get('/docs/' + asset);
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const error = await request(app).get('/api/v1/missing');
  assert.equal(error.status, 404);
  assert.match(error.headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.doesNotMatch(error.headers['content-security-policy'], /script-src[^;]*'unsafe-inline'/);
});

test('API docs and assets remain unavailable unless explicitly enabled', async () => {
  const app = createApp(fixtureConfig(), {});
  for (const path of ['/', '/docs/', '/docs/swagger-ui-init.js', '/docs/swagger-ui-bundle.js', '/openapi.json']) {
    const response = await request(app).get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.code, 'NOT_FOUND');
  }
});
