import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import {randomBytes} from 'node:crypto';
import {createApp} from '../../dist/app.js';
import {fixtureConfig} from '../helpers.mjs';

test('API errors retain security headers, deny framing and prevent caching', async () => {
  const response = await request(createApp(fixtureConfig(), {})).get('/missing');
  assert.equal(response.status, 404);
  assert.match(response.headers['content-security-policy'], /(?:^|;)\s*frame-ancestors 'none'(?:;|$)/);
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['strict-transport-security'], /max-age=\d+/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.equal(response.headers['x-request-id'], response.body.requestId);
});

test('unknown canonical session cookies do not allocate rate-limit buckets', async () => {
  let writes = 0;
  const database = {client:{staffSession:{findUnique:async()=>null}},transaction:async()=>{writes++;throw Error('Unexpected rate-limit transaction');}};
  const response = await request(createApp(fixtureConfig(), database)).get('/api/v1/auth/session')
    .set('Cookie','__Host-inquote_session='+randomBytes(32).toString('base64url'));
  assert.equal(response.status,401);
  assert.equal(response.body.code,'SESSION_REQUIRED');
  assert.equal(writes,0);
});

test('unsupported JSON charset and content encoding retain their 415 status', async () => {
  const app = createApp(fixtureConfig(), {});
  const charset = await request(app).post('/api/v1/auth/login').set('Content-Type','application/json; charset=ISO-8859-1').send('{}');
  assert.equal(charset.status,415);
  assert.equal(charset.body.code,'INVALID_REQUEST');
  const encoding = await request(app).post('/api/v1/auth/login').set('Content-Type','application/json').set('Content-Encoding','unsupported').send('{}');
  assert.equal(encoding.status,415);
  assert.equal(encoding.body.code,'INVALID_REQUEST');
});
