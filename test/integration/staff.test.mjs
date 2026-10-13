import assert from 'node:assert/strict';
import test, {before, after, beforeEach} from 'node:test';
import request from 'supertest';
import {randomBytes} from 'node:crypto';
import {Database} from '../../dist/database/prisma.js';
import {createApp} from '../../dist/app.js';
import {PasswordService} from '../../dist/modules/auth/password.service.js';
import {fixtureConfig, testUrl, origin, password, nextPassword, epoch, key} from '../helpers.mjs';
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw Error('Dedicated TEST_DATABASE_URL ending in _test required.');
const db = new Database(testUrl), pwd = new PasswordService(), app = createApp(fixtureConfig(), db);
let hash, admin, employee, session;
const cookie = r => r.headers['set-cookie'][0].split(';')[0];
const login = (email, pass = password) => request(app).post('/api/v1/auth/login').set('Origin', origin).send({email, password:pass});
const temporary = () => randomBytes(32).toString('base64url');
const write = (method, path, body, {actor=session, operationKey=key(), etag, recoveryEpoch=epoch, csrf=actor.body.csrfToken}={}) => {
  const req = request(app)[method](path).set('Cookie', cookie(actor)).set('Origin', origin).set('X-CSRF-Token', csrf).set('Idempotency-Key', operationKey).set('X-Recovery-Epoch', recoveryEpoch);
  if (etag) req.set('If-Match', etag);
  return req.send(body);
};
const detail = id => request(app).get('/api/v1/staff/' + id).set('Cookie', cookie(session));
before(async () => hash = await pwd.hash(password));
after(async () => db.close());
beforeEach(async () => {
  await db.client.operationReceipt.deleteMany(); await db.client.staffSession.deleteMany(); await db.client.rateLimitBucket.deleteMany(); await db.client.staffUser.deleteMany();
  admin = await db.client.staffUser.create({data:{displayName:'Synthetic Administrator', normalizedEmail:'admin@example.test', role:'ADMINISTRATOR', passwordHash:hash}});
  employee = await db.client.staffUser.create({data:{displayName:'Synthetic Employee', normalizedEmail:'employee@example.test', passwordHash:hash}});
  session = await login(admin.normalizedEmail); assert.equal(session.status, 200);
});

test('administrator creates a fixed-role employee, no credential is returned, identical replay succeeds', async () => {
  const secret=temporary(), intent=key(), body={displayName:' New Employee ', email:' NEW@EXAMPLE.TEST ', temporaryPassword:secret};
  const created=await write('post','/api/v1/staff',body,{operationKey:intent}); assert.equal(created.status,201);
  const id=created.body.operation.resourceIds.staffId, row=await db.client.staffUser.findUnique({where:{id}});
  assert.equal(row.role,'EMPLOYEE'); assert.equal(row.enabled,true); assert.equal(row.mustChangePassword,true);
  assert.equal(row.displayName,'New Employee'); assert.equal(row.normalizedEmail,'new@example.test');
  assert.ok(Math.abs(row.temporaryCredentialExpiresAt-row.createdAt-86400000)<5000);
  assert.equal(await pwd.verify(row.passwordHash,secret),true);
  assert.equal(JSON.stringify(created.body).includes(secret),false);
  assert.equal(JSON.stringify(await db.client.operationReceipt.findMany()).includes(secret),false);
  const replay=await write('post','/api/v1/staff',body,{operationKey:intent}); assert.equal(replay.status,201); assert.deepEqual(replay.body,created.body);
  for(const changed of [{...body,displayName:body.displayName.trim()},{...body,email:body.email.trim().toLowerCase()}]){
    const rejected=await write('post','/api/v1/staff',changed,{operationKey:intent});assert.equal(rejected.status,409);assert.equal(rejected.body.code,'IDEMPOTENCY_KEY_REUSED');
  }
  const changed=await write('post','/api/v1/staff',{...body,temporaryPassword:temporary()},{operationKey:intent}); assert.equal(changed.status,409); assert.equal(changed.body.code,'IDEMPOTENCY_KEY_REUSED');
  const operation=await request(app).get('/api/v1/operations/'+intent).set('Cookie',cookie(session)).set('X-Recovery-Epoch',epoch); assert.equal(operation.status,200);
  const limited=await login(row.normalizedEmail,secret); assert.equal(limited.status,200); assert.equal(limited.body.mustChangePassword,true);
  const denied=await request(app).get('/api/v1/staff').set('Cookie',cookie(limited)); assert.equal(denied.status,403); assert.equal(denied.body.code,'PASSWORD_CHANGE_REQUIRED');
  const change=await write('post','/api/v1/auth/change-password',{currentPassword:secret,newPassword:nextPassword},{actor:limited,etag:limited.body.staffETag}); assert.equal(change.status,200);
  assert.equal((await login(row.normalizedEmail,nextPassword)).body.mustChangePassword,false);
});

test('staff rejects NUL and lone-surrogate names before create or replacement without changing receipts',async()=>{
 const original=await detail(employee.id),receiptCount=await db.client.operationReceipt.count();
 for(const name of ['A\u0000B','A\ud800B','A\udfffB']){
  const create=await write('post','/api/v1/staff',{displayName:name,email:'invalid-text@example.test',temporaryPassword:temporary()});assert.equal(create.status,422);assert.equal(create.body.code,'VALIDATION_FAILED');assert.equal(create.body.errors[0].pointer,'/displayName');
  const replace=await write('put','/api/v1/staff/'+employee.id,{displayName:name,enabled:false},{etag:original.body.etag});assert.equal(replace.status,422);assert.equal(replace.body.errors[0].pointer,'/displayName');
 }
 assert.equal(await db.client.staffUser.count(),2);assert.equal(await db.client.operationReceipt.count(),receiptCount);assert.equal((await detail(employee.id)).body.etag,original.body.etag);assert.equal((await db.client.staffUser.findUnique({where:{id:employee.id}})).enabled,true);
});

test('staff rejects malformed email encoding before persistence with a safe email field error',async()=>{
 const before=await detail(employee.id),receipts=await db.client.operationReceipt.count();
 for(const email of ['a\ud800b@example.test','a@\udfff.test','a\u0000b@example.test','a@\u0000.test']){
  const r=await write('post','/api/v1/staff',{displayName:'Synthetic new employee',email,temporaryPassword:temporary()});
  assert.equal(r.status,422);assert.equal(r.body.code,'VALIDATION_FAILED');assert.deepEqual(r.body.errors,[{pointer:'/email',code:'INVALID_EMAIL',message:'Use a valid email address.'}]);
 }
 assert.equal(await db.client.staffUser.count(),2);assert.equal(await db.client.operationReceipt.count(),receipts);assert.equal((await detail(employee.id)).body.etag,before.body.etag);
});

test('staff account email keeps Unicode domains and dot/plus while storing normalized identity',async()=>{
 const r=await write('post','/api/v1/staff',{displayName:' 😀\nEmployee ',email:' A.User+Tag@😀.COM ',temporaryPassword:temporary()});assert.equal(r.status,201);
 const row=await db.client.staffUser.findUnique({where:{id:r.body.operation.resourceIds.staffId}});assert.equal(row.normalizedEmail,'a.user+tag@😀.com');assert.equal(row.displayName,'😀\nEmployee');
});
test('staff search rejects unstorable text but preserves ordinary newlines and astral Unicode',async()=>{
 for(const search of ['A\u0000B']){
  const r=await request(app).get('/api/v1/staff').set('Cookie',cookie(session)).query({search});assert.equal(r.status,400);assert.equal(r.body.code,'INVALID_REQUEST');
 }
 const name=' 😀\nEmployee ',created=await write('post','/api/v1/staff',{displayName:name,email:'unicode-staff@example.test',temporaryPassword:temporary()});assert.equal(created.status,201);
 const listed=await request(app).get('/api/v1/staff').set('Cookie',cookie(session)).query({search:'😀\nEmployee'});assert.equal(listed.status,200);assert.equal(listed.body.items[0].displayName,'😀\nEmployee');
});

test('list/detail return employee allowlist and signed pagination rejects tampering or different filters',async()=>{
  await db.client.staffUser.create({data:{displayName:'Another Employee',normalizedEmail:'another@example.test',passwordHash:hash}});
  const first=await request(app).get('/api/v1/staff?limit=1').set('Cookie',cookie(session)); assert.equal(first.status,200); assert.equal(first.body.items.length,1); assert.ok(first.body.nextCursor);
  const second=await request(app).get('/api/v1/staff').query({limit:1,cursor:first.body.nextCursor}).set('Cookie',cookie(session)); assert.equal(second.status,200); assert.notEqual(second.body.items[0].id,first.body.items[0].id); assert.equal(second.body.nextCursor,null);
  assert.equal(first.body.items[0].role,'EMPLOYEE'); assert.equal(JSON.stringify(first.body).includes('passwordHash'),false);
  for(const query of [{limit:1,cursor:first.body.nextCursor+'x'},{limit:1,cursor:first.body.nextCursor,search:'Employee'},{limit:'101'},{enabled:'yes'},{unknown:'field'}]) assert.equal((await request(app).get('/api/v1/staff').query(query).set('Cookie',cookie(session))).status,400);
  const read=await detail(employee.id); assert.equal(read.status,200); assert.equal(read.headers.etag,read.body.etag); assert.equal(read.body.email,employee.normalizedEmail);
  assert.deepEqual((await detail(employee.id.toUpperCase())).body,read.body);
  assert.equal((await detail(admin.id)).status,404);
});

test('employee, limited and anonymous callers cannot administer staff or recover another actor receipt',async()=>{
  const staffSession=await login(employee.normalizedEmail);
  assert.equal((await request(app).get('/api/v1/staff')).status,401);
  assert.equal((await request(app).get('/api/v1/staff').set('Cookie',cookie(staffSession))).status,403);
  assert.equal((await write('post','/api/v1/staff',{displayName:'No',email:'no@example.test',temporaryPassword:temporary()},{actor:staffSession})).status,403);
  const created=await write('post','/api/v1/staff',{displayName:'New',email:'new@example.test',temporaryPassword:temporary()}); assert.equal(created.status,201);
  const foreign=await request(app).get('/api/v1/operations/'+created.body.operation.key).set('Cookie',cookie(staffSession)).set('X-Recovery-Epoch',epoch); assert.equal(foreign.status,404);
});

test('disable revokes all sessions atomically; re-enable does not revive cookies and replay precedes stale ETag',async()=>{
  const a=await login(employee.normalizedEmail), b=await login(employee.normalizedEmail), read=await detail(employee.id), intent=key();
  const body={displayName:'Disabled Employee',enabled:false};
  const disabled=await write('put','/api/v1/staff/'+employee.id,body,{etag:read.body.etag,operationKey:intent}); assert.equal(disabled.status,200);
  assert.equal(await db.client.staffSession.count({where:{staffId:employee.id,revokedAt:null}}),0);
  for(const s of [a,b]) assert.equal((await request(app).get('/api/v1/auth/session').set('Cookie',cookie(s))).status,401);
  const replay=await write('put','/api/v1/staff/'+employee.id,body,{etag:read.body.etag,operationKey:intent}); assert.equal(replay.status,200); assert.deepEqual(replay.body,disabled.body);
  assert.equal((await write('put','/api/v1/staff/'+employee.id,{...body,enabled:true},{etag:read.body.etag})).status,412);
  const current=await detail(employee.id); assert.equal((await write('put','/api/v1/staff/'+employee.id,{displayName:'Enabled Employee',enabled:true},{etag:current.body.etag})).status,200);
  assert.equal((await request(app).get('/api/v1/auth/session').set('Cookie',cookie(a))).status,401);
  assert.equal((await login(employee.normalizedEmail)).status,200);
});

test('credential reset preserves disabled state, revokes sessions and permits only limited fresh login',async()=>{
  const old=await login(employee.normalizedEmail), read=await detail(employee.id), secret=temporary(), intent=key();
  const reset=await write('post','/api/v1/staff/'+employee.id+'/credential-reset',{temporaryPassword:secret},{etag:read.body.etag,operationKey:intent}); assert.equal(reset.status,200);
  assert.equal(JSON.stringify(reset.body).includes(secret),false);
  assert.equal((await request(app).get('/api/v1/auth/session').set('Cookie',cookie(old))).status,401);
  assert.equal((await login(employee.normalizedEmail)).status,401);
  const fresh=await login(employee.normalizedEmail,secret); assert.equal(fresh.status,200); assert.equal(fresh.body.mustChangePassword,true);
  assert.equal((await write('post','/api/v1/staff/'+employee.id+'/credential-reset',{temporaryPassword:secret},{etag:read.body.etag,operationKey:intent})).status,200);
  const current=await detail(employee.id); await write('put','/api/v1/staff/'+employee.id,{displayName:employee.displayName,enabled:false},{etag:current.body.etag});
  const disabled=await detail(employee.id); assert.equal((await write('post','/api/v1/staff/'+employee.id+'/credential-reset',{temporaryPassword:temporary()},{etag:disabled.body.etag})).status,200);
  assert.equal((await db.client.staffUser.findUnique({where:{id:employee.id}})).enabled,false);
});

test('mutation guards reject role/email injection, malformed credentials, CSRF, missing key/ETag and recovery epochs',async()=>{
  const body={displayName:'Guarded',email:'guarded@example.test',temporaryPassword:temporary()}, read=await detail(employee.id);
  assert.equal((await write('post','/api/v1/staff',{...body,role:'ADMINISTRATOR'})).status,400);
  assert.equal((await write('post','/api/v1/staff',{...body,temporaryPassword:'short'})).status,422);
  assert.equal((await write('post','/api/v1/staff',body,{csrf:'wrong'})).status,403);
  assert.equal((await write('post','/api/v1/staff',body,{recoveryEpoch:key()})).status,409);
  assert.equal((await write('post','/api/v1/staff',body,{operationKey:'bad'})).status,400);
  assert.equal((await request(app).post('/api/v1/staff').set('Cookie',cookie(session)).set('Origin','https://quote.example.test').send(body)).status,403);
  assert.equal((await write('put','/api/v1/staff/'+employee.id,{displayName:'Renamed',enabled:true})).status,428);
  assert.equal((await write('put','/api/v1/staff/'+employee.id,{displayName:'Renamed',enabled:true,email:'other@example.test'},{etag:read.body.etag})).status,400);
  assert.equal((await write('put','/api/v1/staff/'+admin.id,{displayName:'No',enabled:false},{etag:read.body.etag})).status,404);
  assert.equal(await db.client.operationReceipt.count(),0);
});

test('same-key concurrent creates commit one employee and one receipt; duplicate emails roll back',async()=>{
  const intent=key(),body={displayName:'Concurrent',email:'concurrent@example.test',temporaryPassword:temporary()};
  const responses=await Promise.all([write('post','/api/v1/staff',body,{operationKey:intent}),write('post','/api/v1/staff',body,{operationKey:intent})]);
  for(const response of responses) assert.equal(response.status,201);
  assert.deepEqual(responses[0].body,responses[1].body);
  assert.equal(await db.client.staffUser.count({where:{normalizedEmail:body.email}}),1);
  assert.equal(await db.client.operationReceipt.count(),1);
  const duplicate=await write('post','/api/v1/staff',body); assert.equal(duplicate.status,409); assert.equal(duplicate.body.code,'EMAIL_ALREADY_EXISTS');
  assert.equal(await db.client.operationReceipt.count(),1);
});

test('create/reset rate limit is shared per Administrator and successful replay remains recoverable',async()=>{
  let first, firstBody, firstKey;
  for(let i=0;i<10;i++) {const body={displayName:'Limited '+i,email:'limited'+i+'@example.test',temporaryPassword:temporary()},intent=key(); const response=await write('post','/api/v1/staff',body,{operationKey:intent}); assert.equal(response.status,201); if(i===0){first=response;firstBody=body;firstKey=intent;}}
  const read=await detail(employee.id), blocked=await write('post','/api/v1/staff/'+employee.id+'/credential-reset',{temporaryPassword:temporary()},{etag:read.body.etag}); assert.equal(blocked.status,429);assert.ok(Number(blocked.headers['retry-after'])>0);
  const replay=await write('post','/api/v1/staff',firstBody,{operationKey:firstKey}); assert.equal(replay.status,201);assert.deepEqual(replay.body,first.body);
});

test('receipt storage failure rolls reset and session revocations back in the same transaction',async()=>{
  const old=await login(employee.normalizedEmail), read=await detail(employee.id), secret=temporary();
  await db.client.$executeRawUnsafe("CREATE FUNCTION test_staff_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'RESET_EMPLOYEE_CREDENTIAL' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$");
  await db.client.$executeRawUnsafe('CREATE TRIGGER test_staff_receipt_failure BEFORE INSERT ON operation_receipt FOR EACH ROW EXECUTE FUNCTION test_staff_receipt_failure()');
  try {
    const response=await write('post','/api/v1/staff/'+employee.id+'/credential-reset',{temporaryPassword:secret},{etag:read.body.etag}); assert.equal(response.status,500);
    assert.equal(JSON.stringify(response.body).includes(secret),false);
    const row=await db.client.staffUser.findUnique({where:{id:employee.id}}); assert.equal(row.revision,employee.revision);assert.equal(row.passwordHash,hash);assert.equal(row.mustChangePassword,false);
    assert.equal((await request(app).get('/api/v1/auth/session').set('Cookie',cookie(old))).status,200);
    assert.equal(await db.client.operationReceipt.count(),0);
  }finally{
    await db.client.$executeRawUnsafe('DROP TRIGGER test_staff_receipt_failure ON operation_receipt');
    await db.client.$executeRawUnsafe('DROP FUNCTION test_staff_receipt_failure()');
  }
});

test('staff replay preserves historical fingerprint keys and fences historical recovery epochs',async()=>{
  const body={displayName:'Rotated',email:'rotated@example.test',temporaryPassword:temporary()},intent=key();
  const created=await write('post','/api/v1/staff',body,{operationKey:intent}); assert.equal(created.status,201);
  const config=fixtureConfig();config.operationKeys=new Map([...config.operationKeys,['v2',Buffer.alloc(32,6)]]);config.operationKeyId='v2';
  const rotated=createApp(config,db);
  const repeat=app=>request(app).post('/api/v1/staff').set('Cookie',cookie(session)).set('Origin',origin).set('X-CSRF-Token',session.body.csrfToken).set('Idempotency-Key',intent).set('X-Recovery-Epoch',epoch).send(body);
  assert.deepEqual((await repeat(rotated)).body,created.body);
  config.operationKeys=new Map([['v2',Buffer.alloc(32,6)]]);
  assert.equal((await repeat(createApp(config,db))).status,503);
  await db.client.operationReceipt.update({where:{actorId_idempotencyKey:{actorId:admin.id,idempotencyKey:intent}},data:{recoveryEpoch:key()}});
  const fenced=await repeat(app);assert.equal(fenced.status,409);assert.equal(fenced.body.code,'RECOVERY_REQUIRED');
  assert.equal(await db.client.staffUser.count({where:{normalizedEmail:body.email}}),1);
});

test('Administrator disable during outside-transaction credential hashing prevents commit',async()=>{
  let enter,release;const entered=new Promise(resolve=>enter=resolve), gate=new Promise(resolve=>release=resolve);
  const original=PasswordService.prototype.hash;
  PasswordService.prototype.hash=async function(value){const result=await original.call(this,value);enter();await gate;return result;};
  const read=await detail(employee.id);
  const pending=write('post','/api/v1/staff/'+employee.id+'/credential-reset',{temporaryPassword:temporary()},{etag:read.body.etag}).then(r=>r);
  try{
    await entered;
    await db.client.staffUser.update({where:{id:admin.id},data:{enabled:false,revision:{increment:1}}});
    release();const response=await pending;assert.equal(response.status,401);
    const row=await db.client.staffUser.findUnique({where:{id:employee.id}});assert.equal(row.revision,employee.revision);assert.equal(row.passwordHash,hash);
    assert.equal(await db.client.operationReceipt.count(),0);
  }finally{release();PasswordService.prototype.hash=original;await pending;}
});

test('temporary expiry uses the database clock and limited Administrator cannot recover staff receipts',async()=>{
  const secret=temporary(),created=await write('post','/api/v1/staff',{displayName:'Expired',email:'expired@example.test',temporaryPassword:secret});assert.equal(created.status,201);
  const id=created.body.operation.resourceIds.staffId;
  await db.client.$executeRaw`UPDATE staff_user SET temporary_credential_expires_at=clock_timestamp() WHERE id=${id}::uuid`;
  assert.equal((await login('expired@example.test',secret)).status,401);
  await db.client.staffUser.update({where:{id:admin.id},data:{mustChangePassword:true,temporaryCredentialExpiresAt:new Date(Date.now()+86400000)}});
  const limited=await login(admin.normalizedEmail);assert.equal(limited.body.mustChangePassword,true);
  const operation=await request(app).get('/api/v1/operations/'+created.body.operation.key).set('Cookie',cookie(limited)).set('X-Recovery-Epoch',epoch);
  assert.equal(operation.status,404);assert.equal(operation.body.code,'OPERATION_UNKNOWN');
});

test('pagination accepts the maximum 200-code-point Unicode name and search',async()=>{
  const name='😀'.repeat(200);
  for(let i=0;i<2;i++) await db.client.staffUser.create({data:{displayName:name,normalizedEmail:'unicode'+i+'@example.test',passwordHash:hash}});
  const first=await request(app).get('/api/v1/staff').query({limit:1,search:name}).set('Cookie',cookie(session));assert.equal(first.status,200);assert.ok(first.body.nextCursor);
  const next=await request(app).get('/api/v1/staff').query({limit:1,search:name,cursor:first.body.nextCursor}).set('Cookie',cookie(session));
  assert.equal(next.status,200);assert.notEqual(next.body.items[0].id,first.body.items[0].id);assert.equal(next.body.nextCursor,null);
});

test('same committed key rejects another method/route/target/precondition; keys remain actor-scoped',async()=>{
  const read=await detail(employee.id),intent=key(),body={displayName:'Renamed',enabled:true};
  const updated=await write('put','/api/v1/staff/'+employee.id,body,{etag:read.body.etag,operationKey:intent});assert.equal(updated.status,200);
  const second=await db.client.staffUser.create({data:{displayName:'Second',normalizedEmail:'second@example.test',passwordHash:hash}});
  const secondRead=await detail(second.id),fresh=await detail(employee.id);
  for(const pending of [
    write('post','/api/v1/staff/'+employee.id+'/credential-reset',{temporaryPassword:temporary()},{etag:read.body.etag,operationKey:intent}),
    write('put','/api/v1/staff/'+second.id,body,{etag:secondRead.body.etag,operationKey:intent}),
    write('put','/api/v1/staff/'+employee.id,body,{etag:fresh.body.etag,operationKey:intent}),
  ]){const response=await pending;assert.equal(response.status,409);assert.equal(response.body.code,'IDEMPOTENCY_KEY_REUSED');}
  const other=await db.client.staffUser.create({data:{displayName:'Other Administrator',normalizedEmail:'other-admin@example.test',role:'ADMINISTRATOR',passwordHash:hash}}), otherSession=await login(other.normalizedEmail);
  assert.equal((await request(app).get('/api/v1/operations/'+intent).set('Cookie',cookie(otherSession)).set('X-Recovery-Epoch',epoch)).status,404);
  const own=await write('put','/api/v1/staff/'+second.id,body,{actor:otherSession,etag:secondRead.body.etag,operationKey:intent});assert.equal(own.status,200);
  assert.equal(await db.client.operationReceipt.count(),2);
  assert.notEqual(own.body.operation.resourceIds.staffId,updated.body.operation.resourceIds.staffId);
});

test('reset versus own password change serializes correctly in both actor/target UUID orders',async()=>{
  for(let i=0;i<2;i++){
    const adminId=(i===0?'1':'2')+`1000000-0000-4000-8000-00000000000${i+1}`,employeeId=(i===0?'2':'1')+`1000000-0000-4000-8000-00000000000${i+1}`;
    const a=await db.client.staffUser.create({data:{id:adminId,displayName:'Racing Admin '+i,normalizedEmail:'race-admin'+i+'@example.test',role:'ADMINISTRATOR',passwordHash:hash}});
    const e=await db.client.staffUser.create({data:{id:employeeId,displayName:'Racing Employee '+i,normalizedEmail:'race-employee'+i+'@example.test',passwordHash:hash}});
    const adminSession=await login(a.normalizedEmail),employeeSession=await login(e.normalizedEmail),secret=temporary();
    const read=await request(app).get('/api/v1/staff/'+e.id).set('Cookie',cookie(adminSession));assert.equal(read.status,200);
    const [reset,change]=await Promise.all([
      write('post','/api/v1/staff/'+e.id+'/credential-reset',{temporaryPassword:secret},{actor:adminSession,etag:read.body.etag}),
      write('post','/api/v1/auth/change-password',{currentPassword:password,newPassword:nextPassword},{actor:employeeSession,etag:employeeSession.body.staffETag}),
    ]);
    assert.equal([reset.status,change.status].filter(s=>s===200).length,1);
    assert.ok(reset.status===200 || reset.status===412);assert.ok(change.status===200 || change.status===401);
    assert.equal(await db.client.operationReceipt.count({where:{actorId:{in:[a.id,e.id]}}}),1);
    assert.equal(await db.client.staffSession.count({where:{staffId:e.id,revokedAt:null}}),0);
    const fresh=await login(e.normalizedEmail,reset.status===200?secret:nextPassword);assert.equal(fresh.status,200);assert.equal(fresh.body.mustChangePassword,reset.status===200);
  }
});

test('reset and disable win against a login paused after old-password verification',async()=>{
  const original=PasswordService.prototype.verify;
  for(const action of ['reset','disable']) {
    const target=await db.client.staffUser.create({data:{displayName:'Login Race',normalizedEmail:action+'-login@example.test',passwordHash:hash}});
    const read=await detail(target.id);let enter,release;
    const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
    PasswordService.prototype.verify=async function(stored,value){const result=await original.call(this,stored,value);if(stored===hash&&value===password){enter();await gate;}return result;};
    const pending=login(target.normalizedEmail).then(r=>r);
    try{
      await entered;
      const mutation=action==='reset'?await write('post','/api/v1/staff/'+target.id+'/credential-reset',{temporaryPassword:temporary()},{etag:read.body.etag}):await write('put','/api/v1/staff/'+target.id,{displayName:target.displayName,enabled:false},{etag:read.body.etag});
      assert.equal(mutation.status,200);release();assert.equal((await pending).status,401);
      assert.equal(await db.client.staffSession.count({where:{staffId:target.id,revokedAt:null}}),0);
    }finally{release();PasswordService.prototype.verify=original;await pending;}
  }
});
