import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import express from 'express';
import request from 'supertest';
import {RateLimitService} from '../../dist/modules/auth/rate-limit.service.js';
import {problemHandler} from '../../dist/http/problem.js';
import {createApp} from '../../dist/app.js';
import {fixtureConfig} from '../helpers.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));

for(const [count,status,retry] of [[1,200,undefined],[2,429,'60']]){
  test(`rate quota ${status} response does not depend on a failing expired-bucket cleanup`,async()=>{
    const database={
      transaction:work=>work({$queryRaw:async sql=>sql.join('').includes('clock_timestamp')
        ?[{now:new Date('2026-10-13T00:00:00Z')}]:[{count}]}),
      client:{rateLimitBucket:{deleteMany:async()=>{throw Error('synthetic-private-cleanup-error');}}},
    };
    const limiter=new RateLimitService(database,Buffer.alloc(32,2));
    const app=express();
    app.get('/',async(_req,res)=>{await limiter.consume([{scope:'synthetic',identity:'synthetic',limit:1,seconds:60}]);res.sendStatus(200);});
    app.use(problemHandler);
    const response=await request(app).get('/');
    assert.equal(response.status,status);
    assert.equal(response.headers['retry-after'],retry);
    if(status===429)assert.equal(response.body.code,'RATE_LIMITED');
    assert.doesNotMatch(response.text,/synthetic-private-cleanup-error/);
  });
}

test('default telemetry survives a closed stdout pipe without leaking asynchronous errors',async()=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {Telemetry} from './dist/observability/telemetry.js';
    const telemetry=new Telemetry(); new Telemetry(); new Telemetry();
    process.stdin.once('data',()=>{
      for(let i=0;i<100;i++)telemetry.lifecycle('started');
      setTimeout(()=>{process.stderr.write('ALIVE');process.exit(0);},100);
    });
    process.stderr.write('READY');
  `],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='',ready=false;
  const timeout=setTimeout(()=>child.kill(),5000);
  try{
    const result=await new Promise((resolve,reject)=>{
      child.on('error',reject);
      child.stderr.on('data',chunk=>{
        stderr+=chunk;
        if(!ready&&stderr.includes('READY')){ready=true;child.stdout.destroy();child.stdin.end('GO');}
      });
      child.on('close',(code,signal)=>resolve({code,signal}));
    });
    assert.deepEqual(result,{code:0,signal:null},stderr);
    assert.equal(stderr,'READYALIVE');
  }finally{clearTimeout(timeout);child.kill();}
});

test('real public unavailable responses are accepted by the Problem error contract',async()=>{
  const spec=JSON.parse(readFileSync(new URL('../../openapi/auth.openapi.json',import.meta.url),'utf8'));
  const database={client:{rateLimitBucket:{deleteMany:async()=>({count:0})}},transaction:work=>work({$queryRaw:async sql=>sql.join('').includes('clock_timestamp')
    ?[{now:new Date('2026-10-13T00:00:00Z')}]:[{count:1}]})};
  const response=await request(createApp(fixtureConfig(),database)).post('/api/v1/public/quotation-view').send({token:'invalid'});
  assert.equal(response.status,404);
  assert.equal(response.body.code,'LINK_UNAVAILABLE');
  assert.ok(spec.components.schemas.Problem.properties.code.enum.includes(response.body.code));
  for(const code of ['UNIT_MISMATCH','SOURCE_UNAVAILABLE','CATALOG_CHANGED','REVIEW_STALE','VERSION_IMMUTABLE','ACCESS_SUPERSEDED'])
    assert.ok(spec.components.schemas.Problem.properties.code.enum.includes(code),code);
});

test('container healthcheck probes the configured ops IP including IPv6 and propagates failures',()=>{
  const dockerfile=readFileSync(new URL('../../Dockerfile',import.meta.url),'utf8');
  const line=dockerfile.split(/\r?\n/).find(line=>line.startsWith('HEALTHCHECK '));
  const command=JSON.parse(line.slice(line.indexOf('CMD ')+4));
  for(const [host,url] of [[undefined,'http://127.0.0.1:3017/_ops/live'],['127.0.0.2','http://127.0.0.2:3017/_ops/live'],['10.0.0.5','http://10.0.0.5:3017/_ops/live'],['::1','http://[::1]:3017/_ops/live'],['fd00::5','http://[fd00::5]:3017/_ops/live']]){
    const env={...process.env,OPS_PORT:'3017'};delete env.OPS_HOST;if(host)env.OPS_HOST=host;
    for(const healthy of [true,false]){
      const script=`globalThis.fetch=async url=>{process.stdout.write(String(url));return {ok:${healthy}};};`+command[3];
      const result=spawnSync(process.execPath,[command[1],command[2],script],{env,encoding:'utf8',timeout:5000,windowsHide:true});
      assert.equal(result.status,healthy?0:1,result.stderr);
      assert.equal(result.stdout,url);
      assert.equal(result.stderr,'');
    }
  }
});
