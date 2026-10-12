import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from 'pg';
import {checkReadiness} from '../../dist/observability/readiness.js';
import {fixtureConfig} from '../helpers.mjs';

test('checked-out readiness client disconnects and disposal errors cannot crash or leak', () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {Client} from 'pg';
    import {checkReadiness} from './dist/observability/readiness.js';
    import {fixtureConfig} from './test/helpers.mjs';
    const secret='synthetic-private-db-disconnect-detail';
    const client=new Client({user:'synthetic',database:'synthetic_test'});
    let discarded=false, releases=0;
    client.release=discard=>{
      discarded=discard; releases++;
      setImmediate(()=>{
        client._handleErrorEvent(new Error(secret+'-during-disposal'));
        client.emit('end');
        assert.equal(client.listenerCount('error'),0);
      });
    };
    const pending=checkReadiness({connect:async()=>client},'public',fixtureConfig()).catch(()=>false);
    setImmediate(()=>client._handleErrorEvent(new Error(secret+'-during-query')));
    const ready=await pending;
    await new Promise(done=>setImmediate(done));
    assert.equal(ready,false);
    assert.equal(discarded,true);
    assert.equal(releases,1);
    process.stdout.write(JSON.stringify({ready,discarded,releases,completed:true}));
  `],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,'readiness disconnect terminated the isolated process');
  assert.equal(result.stderr,'');
  assert.doesNotMatch(result.stdout,/synthetic-private-db-disconnect-detail|Error|stack/);
  assert.deepEqual(JSON.parse(result.stdout),{ready:false,discarded:true,releases:1,completed:true});
});

test('healthy readiness releases restore idle error coverage without retaining probe listeners', async () => {
  const client=new Client({user:'synthetic',database:'synthetic_test'});
  client.query=async()=>({rows:[{compatible:true}]});
  let releases=0, idleErrors=0;
  const idleHandler=()=>{idleErrors++;};
  const pool={connect:async()=>{
    client.off('error',idleHandler);
    return client;
  }};
  client.release=discard=>{
    assert.equal(discard,false);
    assert.equal(client.listenerCount('error'),1);
    client.on('error',idleHandler);
    assert.equal(client.listenerCount('error'),2);
    releases++;
  };
  for(let i=0;i<3;i++){
    assert.equal(await checkReadiness(pool,'public',fixtureConfig()),true);
    assert.equal(client.listenerCount('error'),1);
    assert.equal(client.listenerCount('end'),0);
  }
  client.emit('error',new Error('synthetic-private-idle-detail'));
  assert.equal(idleErrors,1);
  assert.equal(releases,3);
});
