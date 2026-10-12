import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import {createApp} from '../../dist/app.js';
import {Telemetry} from '../../dist/observability/telemetry.js';
import {createOperationsServer} from '../../dist/observability/operations-server.js';
import {parseConfig} from '../../dist/config/env.js';
import {fixtureConfig} from '../helpers.mjs';

test('request JSON and bounded metrics omit secrets in denied, malformed and unknown requests', async () => {
  const records = [];
  const telemetry = new Telemetry(line => records.push(JSON.parse(line)));
  const database={client:{staffSession:{findUnique:async()=>{throw Error('synthetic-private-token-contact-password');}}}};
  const app = createApp({...fixtureConfig(), apiDocsEnabled: true}, database, telemetry);
  const secret = 'synthetic-private-token-contact-password';
  const success = await request(app).get('/openapi.json?secret='+secret).set('X-Request-Id',secret);
  assert.equal(success.status,200);
  assert.equal(records[0].requestId,success.headers['x-request-id']);
  const denied = await request(app).get('/api/v1/operations/'+secret+'?secret='+secret)
    .set('Cookie',secret).set('Authorization',secret);
  assert.equal(denied.status,401);
  const malformed = await request(app).post('/api/v1/auth/login?secret='+secret)
    .set('Content-Type','application/json').send('{"password":"'+secret+'",');
  assert.equal(malformed.status,400);
  for(let i=0;i<12;i++) assert.equal((await request(app).get('/unknown/'+secret+i+'?secret='+secret)).status,404);
  const failed=await request(app).get('/api/v1/auth/session').set('Cookie','__Host-inquote_session='+Buffer.alloc(32,7).toString('base64url'));
  assert.equal(failed.status,500);
  assert.equal(records.length,16);
  for(const record of records){
    assert.deepEqual(Object.keys(record).sort(), ['durationMs','event','method','requestId','route','status','time']);
    assert.match(record.requestId,/^[0-9a-f-]{36}$/);
    assert.ok(record.durationMs>=0);
  }
  assert.equal(records[1].route,'/api/v1/operations/:key');
  assert.equal(records[2].route,'unmatched');
  assert.equal(records[3].route,'unmatched');
  assert.doesNotMatch(JSON.stringify(records)+telemetry.metrics(), new RegExp(secret));
  assert.equal(telemetry.metrics().split('\n').filter(line=>line.startsWith('inquote_http_requests_total{')).length,5);
  assert.match(telemetry.metrics(),/inquote_http_requests_total\{route="unmatched",method="GET",status="404"\} 12/);
  assert.match(telemetry.metrics(),/inquote_http_request_duration_seconds_bucket.*le="\+Inf"/);
});

test('operations are separate from business HTTP, and live works when readiness fails', async () => {
  let checks=0;
  const telemetry = new Telemetry(()=>{});
  const operations = createOperationsServer({telemetry,readiness:async()=>{checks++;throw Error('synthetic-secret-db-error');}});
  for(const path of ['/_ops/live','/_ops/ready','/_ops/metrics']){
    const publicResponse = await request(createApp(fixtureConfig(),{})).get(path);
    assert.equal(publicResponse.status,404);
  }
  const live=await request(operations).get('/_ops/live');
  assert.equal(live.status,200);
  assert.deepEqual(live.body,{status:'live'});
  assert.equal(checks,0);
  const ready=await request(operations).get('/_ops/ready');
  assert.equal(ready.status,503);
  assert.deepEqual(ready.body,{status:'unavailable'});
  assert.equal(ready.headers['cache-control'],'no-store');
  assert.doesNotMatch(ready.text,/secret|error|database/i);
  const metrics=await request(operations).get('/_ops/metrics');
  assert.equal(metrics.status,200);
  assert.match(metrics.headers['content-type'],/text\/plain/);
  assert.match(metrics.text,/inquote_process_resident_memory_bytes/);
  assert.equal((await request(operations).post('/_ops/live')).status,404);
  operations.stopReadiness();
  assert.equal((await request(operations).get('/_ops/ready')).status,503);
  assert.equal(checks,1);
});

test('readiness times out with one in-flight check instead of accumulating database work', async () => {
  let checks=0, resolve;
  const telemetry = new Telemetry(()=>{});
  const operations=createOperationsServer({telemetry,timeoutMs:25,readiness:()=>{checks++;return new Promise(done=>{resolve=done;});}});
  const [first,second]=await Promise.all([request(operations).get('/_ops/ready'),request(operations).get('/_ops/ready')]);
  assert.equal(first.status,503);
  assert.equal(second.status,503);
  assert.equal(checks,1);
  assert.equal((await request(operations).get('/_ops/ready')).status,503);
  assert.equal(checks,1);
  resolve(true);
  await new Promise(done=>setImmediate(done));
});

test('private operation configuration defaults and rejects unsafe/conflicting listeners', () => {
  const config=fixtureConfig();
  const values={DATABASE_URL:config.databaseUrl,ADMIN_ORIGIN:config.adminOrigin,USER_ORIGIN:config.userOrigin,RECOVERY_EPOCH:config.recoveryEpoch,
    CSRF_HMAC_KEY:config.csrfKey.toString('base64'),RATE_LIMIT_HMAC_KEY:config.rateLimitKey.toString('base64'),REVIEW_HMAC_KEY:config.reviewKey.toString('base64'),
    OPERATION_HMAC_KEYS:JSON.stringify(Object.fromEntries([...config.operationKeys].map(([id,key])=>[id,key.toString('base64')]))),OPERATION_HMAC_CURRENT_KEY_ID:config.operationKeyId,
    VIEWING_LINK_KEYS:JSON.stringify(Object.fromEntries([...config.viewingKeys].map(([id,key])=>[id,key.toString('base64')]))),VIEWING_LINK_CURRENT_KEY_ID:config.viewingKeyId};
  assert.equal(parseConfig(values).opsHost,'127.0.0.1');
  assert.equal(parseConfig(values).opsPort,3001);
  for(const change of [{OPS_HOST:'0.0.0.0'},{OPS_HOST:'::'},{OPS_HOST:'8.8.8.8'},{OPS_HOST:'localhost'},{OPS_PORT:'0'},{OPS_PORT:'3000'}]) assert.throws(()=>parseConfig({...values,...change}));
  assert.equal(parseConfig({...values,OPS_HOST:'10.0.0.5'}).opsHost,'10.0.0.5');
});
