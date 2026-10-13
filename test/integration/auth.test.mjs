import assert from 'node:assert/strict';
import test, { before, after, beforeEach } from 'node:test';
import request from 'supertest';
import { Database } from '../../dist/database/prisma.js';
import { createApp } from '../../dist/app.js';
import { PasswordService } from '../../dist/modules/auth/password.service.js';
import { fixtureConfig, testUrl, origin, password, nextPassword, epoch, key } from '../helpers.mjs';

if (!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to a dedicated database ending in _test; tests never use DATABASE_URL.');
const database=new Database(testUrl), passwords=new PasswordService();
let app, hash, user;
before(async()=>{hash=await passwords.hash(password);app=createApp(fixtureConfig(),database);});
after(async()=>database.close());
beforeEach(async()=>{
  await database.client.operationReceipt.deleteMany();await database.client.staffSession.deleteMany();
  await database.client.rateLimitBucket.deleteMany();await database.client.staffUser.deleteMany();
  user=await database.client.staffUser.create({data:{displayName:'Synthetic staff',normalizedEmail:'staff@example.test',passwordHash:hash}});
});
const login=(email='staff@example.test',pass=password)=>request(app).post('/api/v1/auth/login').set('Origin',origin).send({email,password:pass});
const cookie=response=>response.headers['set-cookie'][0].split(';')[0];
function change(session,operationKey=key(),body={currentPassword:password,newPassword:nextPassword},etag=session.body.staffETag,recoveryEpoch=epoch){
  return request(app).post('/api/v1/auth/change-password').set('Cookie',cookie(session)).set('Origin',origin)
    .set('X-CSRF-Token',session.body.csrfToken).set('If-Match',etag).set('Idempotency-Key',operationKey)
    .set('X-Recovery-Epoch',recoveryEpoch).send(body);
}
test('login emits allowlisted summary and secure cookie; session inspection works',async()=>{
  const response=await login(' STAFF@EXAMPLE.TEST ');assert.equal(response.status,200);
  assert.match(response.headers['set-cookie'][0],/^__Host-inquote_session=[\w-]{43};/);
  for(const value of ['HttpOnly','Secure','SameSite=Lax','Path=/']) assert.ok(response.headers['set-cookie'][0].includes(value));
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.body.staff.role,'EMPLOYEE');
  assert.equal(response.body.recoveryEpoch,epoch);assert.equal(response.body.mustChangePassword,false);
  assert.equal(JSON.stringify(response.body).includes('passwordHash'),false);
  const row=await database.client.staffSession.findFirst();assert.equal(row.tokenHash.length,32);
  assert.equal(row.absoluteExpiresAt-row.createdAt,8*60*60*1000);
  const session=await request(app).get('/api/v1/auth/session').set('Cookie',cookie(response));
  assert.equal(session.status,200);assert.equal(session.body.csrfToken,response.body.csrfToken);
});
test('credential denial is uniform for missing identity, nonexistent, wrong, disabled and expired temporary password',async()=>{
  for(const body of [{password},{email:'missing@example.test',password},{email:'staff@example.test',password:'wrong'}]){
    const r=await request(app).post('/api/v1/auth/login').set('Origin',origin).send(body);assert.equal(r.status,401);assert.equal(r.body.code,'INVALID_CREDENTIALS');
  }
  await database.client.staffUser.update({where:{id:user.id},data:{enabled:false}});
  assert.equal((await login()).body.code,'INVALID_CREDENTIALS');
  await database.client.staffUser.update({where:{id:user.id},data:{enabled:true,mustChangePassword:true,temporaryCredentialExpiresAt:new Date(Date.now()-1000)}});
  assert.equal((await login()).body.code,'INVALID_CREDENTIALS');
});
test('Origin, unknown fields, content type, CSRF and body size cannot bypass guards',async()=>{
  assert.equal((await request(app).post('/api/v1/auth/login').send({email:'staff@example.test',password})).status,403);
  assert.equal((await request(app).post('/api/v1/auth/login').set('Origin','null').send({email:'staff@example.test',password})).status,403);
  assert.equal((await request(app).post('/api/v1/auth/login').set('Origin',origin).send({email:'staff@example.test',password,role:'ADMINISTRATOR'})).status,400);
  assert.equal((await request(app).post('/api/v1/auth/login').set('Origin',origin).type('text').send('body')).status,400);
  assert.equal((await request(app).post('/api/v1/auth/login').set('Origin',origin).send({password:'x'.repeat(17000)})).status,400);
  const session=await login();
  const r=await request(app).post('/api/v1/auth/change-password').set('Origin',origin).set('Cookie',cookie(session)).send({currentPassword:password,newPassword:nextPassword});
  assert.equal(r.status,403);
});

test('malformed Unicode email login returns uniform denial without sessions or successful receipts',async()=>{
  for(const email of ['a\ud800b@example.test','a@\udfff.test','a\u0000b@example.test','a@\u0000.test']){
    const r=await login(email);assert.equal(r.status,401);assert.equal(r.body.code,'INVALID_CREDENTIALS');
    assert.equal(r.headers['set-cookie'],undefined);assert.equal(JSON.stringify(r.body).includes(JSON.stringify(email).slice(1,-1)),false);
  }
  assert.equal(await database.client.staffSession.count(),0);assert.equal(await database.client.operationReceipt.count(),0);
  assert.equal(await database.client.staffUser.count(),1);
});
test('limited session can inspect, change password and logout but guard rejects full use cases',async()=>{
  await database.client.staffUser.update({where:{id:user.id},data:{mustChangePassword:true,temporaryCredentialExpiresAt:new Date(Date.now()+24*60*60*1000)}});
  const session=await login();assert.equal(session.body.mustChangePassword,true);
  const {AuthRepository}=await import('../../dist/modules/auth/auth.repository.js');
  const {SessionService}=await import('../../dist/modules/auth/security.js');
  const config=fixtureConfig(),repo=new AuthRepository(database,new SessionService(config.csrfKey),config.recoveryEpoch);
  await assert.rejects(()=>repo.withSession(cookie(session).split('=')[1],{allowLimited:false},async()=>true),e=>e.code==='PASSWORD_CHANGE_REQUIRED');
  const r=await change(session);assert.equal(r.status,200);
  const stored=await database.client.staffUser.findUnique({where:{id:user.id}});assert.equal(stored.mustChangePassword,false);assert.equal(stored.temporaryCredentialExpiresAt,null);
});
test('password change commits receipt, revokes every session and rejects old credentials',async()=>{
  const first=await login(),second=await login();const operationKey=key();const r=await change(first,operationKey);
  assert.equal(r.status,200);assert.equal(r.body.operation.key,operationKey);
  assert.ok(r.headers['set-cookie'][0].includes('Max-Age=0'));
  for(const session of [first,second]) assert.equal((await request(app).get('/api/v1/auth/session').set('Cookie',cookie(session))).status,401);
  assert.equal((await login()).status,401);assert.equal((await login('staff@example.test',nextPassword)).status,200);
  assert.equal(await database.client.operationReceipt.count(),1);
});
test('unknown outcome is recovered under fresh login; replay precedes old password and stale ETag checks',async()=>{
  const original=await login(),operationKey=key();assert.equal((await change(original,operationKey)).status,200);
  const fresh=await login('staff@example.test',nextPassword);
  const receipt=await request(app).get('/api/v1/operations/'+operationKey).set('Cookie',cookie(fresh)).set('X-Recovery-Epoch',epoch);
  assert.equal(receipt.status,200);assert.equal(receipt.body.key,operationKey);
  const replay=await change(fresh,operationKey,{currentPassword:password,newPassword:nextPassword},original.body.staffETag);
  assert.equal(replay.status,200);assert.equal(replay.headers['set-cookie'],undefined);
  assert.equal((await request(app).get('/api/v1/auth/session').set('Cookie',cookie(fresh))).status,200);
  assert.equal((await change(fresh,operationKey,{currentPassword:password,newPassword:'A different chosen password 789!'},original.body.staffETag)).body.code,'IDEMPOTENCY_KEY_REUSED');
});
test('epoch, missing key, weak precondition, stale revision and wrong current password leave no mutation',async()=>{
  const s=await login();
  assert.equal((await change(s,key(),undefined,undefined,'72000000-0000-4000-8000-000000000001')).body.code,'RECOVERY_REQUIRED');
  assert.equal((await change(s,'bad-key')).body.code,'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await change(s,key(),undefined,'*')).body.code,'PRECONDITION_REQUIRED');
  assert.equal((await change(s,key(),undefined,'"stale"')).body.code,'REVISION_CONFLICT');
  assert.equal((await change(s,key(),{currentPassword:'wrong',newPassword:nextPassword})).body.code,'INVALID_CREDENTIALS');
  assert.equal(await database.client.operationReceipt.count(),0);assert.equal((await login()).status,200);
});
test('expired idle/absolute sessions, disabled accounts and changed epochs fail closed',async()=>{
  for(const condition of ['idle','absolute','disabled','epoch']){
    const session=await login();const row=await database.client.staffSession.findFirst({orderBy:{createdAt:'desc'}});
    if(condition==='idle')await database.client.staffSession.update({where:{id:row.id},data:{createdAt:new Date(Date.now()-31*60*1000),lastSeenAt:new Date(Date.now()-30*60*1000)}});
    if(condition==='absolute')await database.client.staffSession.update({where:{id:row.id},data:{createdAt:new Date(Date.now()-9*60*60*1000),lastSeenAt:new Date(Date.now()-60*1000),absoluteExpiresAt:new Date(Date.now()-1)}});
    if(condition==='disabled')await database.client.staffUser.update({where:{id:user.id},data:{enabled:false}});
    if(condition==='epoch')await database.client.staffSession.update({where:{id:row.id},data:{recoveryEpoch:'73000000-0000-4000-8000-000000000001'}});
    assert.equal((await request(app).get('/api/v1/auth/session').set('Cookie',cookie(session))).status,401);
    await database.client.staffUser.update({where:{id:user.id},data:{enabled:true}});
  }
});
test('logout is repeatable but valid sessions require CSRF',async()=>{
  const s=await login();const base=()=>request(app).post('/api/v1/auth/logout').set('Origin',origin).set('Cookie',cookie(s)).send({});
  assert.equal((await base()).status,403);
  assert.equal((await base().set('X-CSRF-Token',s.body.csrfToken)).status,204);
  assert.equal((await base()).status,204);
});
test('login email and IP limits return Retry-After and never permanently disable accounts',async()=>{
  for(let i=0;i<10;i++)assert.equal((await login('missing@example.test')).status,401);
  const r=await login('missing@example.test');assert.equal(r.status,429);assert.ok(Number(r.headers['retry-after'])>0);
  await database.client.rateLimitBucket.deleteMany();
  for(let i=0;i<30;i++)assert.equal((await login(`missing${i}@example.test`)).status,401);
  assert.equal((await login('last@example.test')).status,429);
  assert.equal((await database.client.staffUser.findUnique({where:{id:user.id}})).enabled,true);
});
test('password change without a session returns SESSION_REQUIRED and invalid CSRF does no credential work',async()=>{
  const r=await request(app).post('/api/v1/auth/change-password').set('Origin',origin).send({currentPassword:password,newPassword:nextPassword});
  assert.equal(r.status,401);assert.equal(r.body.code,'SESSION_REQUIRED');
  const session=await login();
  const {AuthService}=await import('../../dist/modules/auth/auth.service.js');
  const {AuthRepository}=await import('../../dist/modules/auth/auth.repository.js');
  const {SessionService}=await import('../../dist/modules/auth/security.js');
  const {OperationReceiptService}=await import('../../dist/modules/auth/operation-receipt.service.js');
  let work=0;const config=fixtureConfig(),security=new SessionService(config.csrfKey);
  const service=new AuthService(config,new AuthRepository(database,security,config.recoveryEpoch),
    {verify:async()=>{work++;return true;},validate:()=>{},hash:async()=>{work++;return hash;}},security,new OperationReceiptService(config));
  await assert.rejects(()=>service.changePassword(cookie(session).split('=')[1],'invalid',{currentPassword:password,newPassword:nextPassword},
    {epoch,key:key(),precondition:session.body.staffETag}),e=>e.code==='FORBIDDEN');
  assert.equal(work,0);
});
